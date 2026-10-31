// Deploys the three single-file Actors (target site, scraper, redirector) as SOURCE_FILES Actors through the
// API, wires the failed-run webhook to the repair Actor, seeds the target site's variant, and sets the repair
// Actor's secret env vars. The repair Actor itself is pushed with `apify push` from repair-actor/.
// Usage: npx tsx scripts/deploy.ts [site|scraper|redirector|webhook|repair-env|all]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApifyClient } from "apify-client";
import { CONFIG, actorRef, standbyUrl, targetSiteUrl } from "../config.js";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const root = join(import.meta.dirname, "..");

type Spec = {
	name: string;
	dir: string;
	files: string[];
	standby: boolean;
	envVars?: { name: string; value: string; isSecret?: boolean }[];
	tagProd?: boolean;
	title: string;
	inputSchema?: object;
};

const pkg = (name: string, deps: Record<string, string>) =>
	JSON.stringify({ name, version: "0.0.1", type: "module", main: "main.js", scripts: { start: "node main.js" }, dependencies: deps }, null, 2);
const dockerfile = `FROM apify/actor-node:22
COPY package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev --omit=optional
COPY . ./
CMD npm start --silent
`;

async function ensureActor(spec: Spec): Promise<string> {
	const ref = `${CONFIG.user}/${spec.name}`;
	const sourceFiles = [
		{ name: "package.json", format: "TEXT" as const, content: pkg(spec.name, spec.name === CONFIG.actors.scraper ? { apify: "^3.4.0", cheerio: "^1.0.0" } : { apify: "^3.4.0", "apify-client": "^2.12.0" }) },
		{ name: "Dockerfile", format: "TEXT" as const, content: dockerfile },
		...(await Promise.all(spec.files.map(async (file) => ({ name: file, format: "TEXT" as const, content: await readFile(join(root, spec.dir, file), "utf8") })))),
		...(spec.inputSchema ? [{ name: "INPUT_SCHEMA.json", format: "TEXT" as const, content: JSON.stringify(spec.inputSchema, null, 2) }] : []),
	];
	const version = {
		versionNumber: CONFIG.scraperVersion,
		sourceType: "SOURCE_FILES" as const,
		buildTag: "latest",
		envVars: spec.envVars ?? [],
		sourceFiles,
	};
	let actor = await client.actor(ref).get();
	if (!actor) {
		actor = await client.actors().create({ name: spec.name, title: spec.title, versions: [version as never], defaultRunOptions: { build: "latest", timeoutSecs: 600, memoryMbytes: 512 } } as never);
		console.log(`created ${ref} (${actor.id})`);
	} else {
		await client.actor(ref).version(CONFIG.scraperVersion).update(version as never);
		console.log(`updated source of ${ref} (${actor.id})`);
	}
	// New Actors default to LIMITED_PERMISSIONS, under which a run cannot open named stores or touch other Actors.
	await client.actor(ref).update({
		actorPermissionLevel: "FULL_PERMISSIONS",
		...(spec.standby
			? { actorStandby: { isEnabled: true, desiredRequestsPerActorRun: 8, maxRequestsPerActorRun: 32, idleTimeoutSecs: 600, build: "latest", memoryMbytes: 256 } }
			: {}),
	} as never);
	const build = await client.actor(ref).build(CONFIG.scraperVersion, { tag: "latest", waitForFinish: 300 });
	console.log(`build ${build.id} ${build.status} ${build.buildNumber ?? ""}`);
	if (build.status !== "SUCCEEDED") throw new Error(`build of ${ref} ended ${build.status}`);
	if (spec.tagProd) {
		const prod = await client.actor(ref).build(CONFIG.scraperVersion, { tag: CONFIG.buildTag, waitForFinish: 300 });
		console.log(`tagged ${CONFIG.buildTag}: build ${prod.id} ${prod.status}`);
	}
	if (spec.standby) {
		const fresh = (await client.actor(ref).get()) as { standbyUrl?: string } | undefined;
		const expected = standbyUrl(spec.name === CONFIG.actors.targetSite ? "targetSite" : "redirector").replace(/\/$/, "");
		console.log(`standby URL: ${fresh?.standbyUrl}`);
		if (fresh?.standbyUrl !== expected) throw new Error(`config.ts standbyUrl() gives ${expected} but the platform says ${fresh?.standbyUrl}; fix STANDBY_USER in config.ts`);
	}
	return actor.id;
}

const specs: Record<string, Spec> = {
	site: {
		name: CONFIG.actors.targetSite,
		title: "SHD target site (Standby)",
		dir: "actors/target-site",
		files: ["main.js"],
		standby: true,
		envVars: [{ name: "STATE_STORE", value: CONFIG.targetSiteStateStore }],
	},
	scraper: {
		name: CONFIG.actors.scraper,
		title: "SHD scraper (the patient)",
		dir: "actors/scraper",
		files: ["main.js", "selectors.js"],
		standby: false,
		envVars: [{ name: "TARGET_URL", value: targetSiteUrl() }],
		tagProd: true,
		inputSchema: {
			title: "SHD scraper input",
			type: "object",
			schemaVersion: 1,
			properties: {
				url: { title: "Target URL", description: "Product page to scrape (the SHD target site).", type: "string", editor: "textfield", default: targetSiteUrl() },
				priceFillRateThreshold: { title: "Minimum price fill rate", description: "The run fails when fewer items than this share have a price.", type: "number", default: CONFIG.priceFillRateThreshold },
			},
		},
	},
	redirector: {
		name: CONFIG.actors.redirector,
		title: "SHD repair link (Standby redirect)",
		dir: "actors/redirector",
		files: ["main.js"],
		standby: true,
		envVars: [{ name: "REPAIR_ACTOR", value: actorRef("repair") }],
	},
};

async function seedVariant(): Promise<void> {
	const { id } = await client.keyValueStores().getOrCreate(CONFIG.targetSiteStateStore);
	const existing = await client.keyValueStore(id).getRecord("variant");
	if (!existing) await client.keyValueStore(id).setRecord({ key: "variant", value: "a", contentType: "application/json" });
	console.log(`target site state store ${id}: variant=${existing?.value ?? "a (seeded)"}`);
}

async function webhook(): Promise<void> {
	const scraper = await client.actor(actorRef("scraper")).get();
	const repair = await client.actor(actorRef("repair")).get();
	if (!scraper || !repair) throw new Error("scraper and repair actors must exist first (push repair-actor with `apify push`)");
	const existing = await client.actor(scraper.id).webhooks().list();
	const requestUrl = `https://api.apify.com/v2/acts/${repair.id}/runs`;
	const payloadTemplate = `{"actorId": {{eventData.actorId}}, "failedRunId": {{eventData.actorRunId}}}`;
	const mine = existing.items.find((w) => w.requestUrl === requestUrl);
	if (mine) {
		await client.webhook(mine.id).update({ eventTypes: ["ACTOR.RUN.FAILED"], payloadTemplate });
		console.log(`webhook ${mine.id} updated`);
	} else {
		const created = await client.webhooks().create({ eventTypes: ["ACTOR.RUN.FAILED"], condition: { actorId: scraper.id }, requestUrl, payloadTemplate, description: "SHD: failed scraper run starts the repair agent" });
		console.log(`webhook ${created.id} created: scraper FAILED -> ${actorRef("repair")}`);
	}
}

async function repairEnv(): Promise<void> {
	const repair = await client.actor(actorRef("repair")).get();
	if (!repair) throw new Error("push repair-actor first");
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY not set");
	const versionNumber = repair.versions?.[0]?.versionNumber ?? "0.0";
	await client.actor(repair.id).version(versionNumber).update({ envVars: [{ name: "OPENROUTER_API_KEY", value: key, isSecret: true }] } as never);
	await client.actor(repair.id).update({ actorPermissionLevel: "FULL_PERMISSIONS" } as never);
	console.log(`repair actor ${repair.id} version ${versionNumber}: OPENROUTER_API_KEY set (secret), FULL_PERMISSIONS`);
	// Env vars are baked into a build, so a build made before the secret was set runs without it.
	const build = await client.actor(repair.id).build(versionNumber, { tag: "latest", waitForFinish: 600 });
	console.log(`rebuilt with the secret: build ${build.id} ${build.status} ${build.buildNumber ?? ""}`);
	if (build.status !== "SUCCEEDED") throw new Error(`repair actor build ended ${build.status}`);
}

const what = process.argv[2] ?? "all";
if (what === "site" || what === "all") {
	await seedVariant();
	await ensureActor(specs.site!);
}
if (what === "scraper" || what === "all") await ensureActor(specs.scraper!);
if (what === "redirector" || what === "all") await ensureActor(specs.redirector!);
if (what === "webhook" || what === "all") await webhook();
if (what === "repair-env") await repairEnv();
