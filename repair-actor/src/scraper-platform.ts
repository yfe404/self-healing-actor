// Operations on the scraper Actor through the Apify API. Shared by the build session and the repair tools.
// Every write is an absolute-state write: the full source file list, a build of a named version, a tag set
// to one build id. Replaying any of them yields the same end state.
import { client } from "./platform.js";

export const SCRAPER_VERSION = "0.0";
export const PROD_TAG = "prod";

export type SourceFile = { name: string; format: "TEXT" | "BASE64"; content: string };

export async function readScraperSource(actorId: string): Promise<SourceFile[]> {
	const version = (await client.actor(actorId).version(SCRAPER_VERSION).get()) as { sourceFiles?: SourceFile[] } | undefined;
	if (!version?.sourceFiles) throw new Error(`actor ${actorId} version ${SCRAPER_VERSION} has no source files`);
	return version.sourceFiles;
}

/** Replace one file in the version's source (sending the whole list, so a replay writes the same state). */
export async function writeScraperFile(actorId: string, name: string, content: string): Promise<{ files: string[] }> {
	const current = await readScraperSource(actorId);
	const next = current.some((f) => f.name === name)
		? current.map((f) => (f.name === name ? { ...f, format: "TEXT" as const, content } : f))
		: [...current, { name, format: "TEXT" as const, content }];
	await client.actor(actorId).version(SCRAPER_VERSION).update({ sourceFiles: next } as never);
	return { files: next.map((f) => f.name) };
}

export async function buildScraper(actorId: string, tag: string): Promise<{ buildId: string; buildNumber: string; status: string }> {
	const build = await client.actor(actorId).build(SCRAPER_VERSION, { tag, waitForFinish: 300 });
	return { buildId: build.id, buildNumber: build.buildNumber ?? "?", status: build.status };
}

/** Point the `prod` tag at one build. The scheduled scraper runs `prod`, so this is the promotion. */
export async function tagBuild(actorId: string, buildId: string, tag = PROD_TAG): Promise<{ tag: string; buildId: string; buildNumber: string }> {
	const build = await client.build(buildId).get();
	if (!build) throw new Error(`build ${buildId} not found`);
	const actor = await client.actor(actorId).get();
	const taggedBuilds = { ...((actor as { taggedBuilds?: Record<string, unknown> } | undefined)?.taggedBuilds ?? {}), [tag]: { buildId, buildNumber: build.buildNumber } };
	await client.actor(actorId).update({ taggedBuilds } as never);
	return { tag, buildId, buildNumber: build.buildNumber ?? "?" };
}

export type RunStats = {
	runId: string;
	status: string;
	buildNumber: string | undefined;
	itemCount: number;
	fillRates: Record<string, number>;
	sample: unknown[];
	diagnosis: unknown;
	logTail: string;
};

export async function runScraper(actorId: string, build: string, waitSecs = 240): Promise<RunStats> {
	// The run API takes a build tag or build number; a build id must be resolved to its number first.
	const looksLikeId = /^[A-Za-z0-9]{17}$/.test(build);
	const selector = looksLikeId ? (await client.build(build).get())?.buildNumber ?? build : build;
	const run = await client.actor(actorId).start({}, { build: selector });
	const finished = await client.run(run.id).waitForFinish({ waitSecs });
	return readRun(finished.id);
}

export async function readRun(runId: string): Promise<RunStats> {
	const run = await client.run(runId).get();
	if (!run) throw new Error(`run ${runId} not found`);
	const items = (await client.dataset(run.defaultDatasetId).listItems({ limit: 1000 })).items as Record<string, unknown>[];
	const diagnosis = (await client.keyValueStore(run.defaultKeyValueStoreId).getRecord("DIAGNOSIS"))?.value ?? null;
	const log = (await client.run(runId).log().get()) ?? "";
	return {
		runId,
		status: run.status,
		buildNumber: run.buildNumber,
		itemCount: items.length,
		fillRates: fillRates(items),
		sample: items.slice(0, 5),
		diagnosis,
		logTail: log.split("\n").filter((l) => !/^\s*$/.test(l)).slice(-25).join("\n"),
	};
}

export function fillRates(items: Record<string, unknown>[]): Record<string, number> {
	const fields = new Set<string>();
	for (const item of items) for (const key of Object.keys(item)) fields.add(key);
	const rates: Record<string, number> = {};
	for (const field of [...fields].sort()) {
		rates[field] = items.length === 0 ? 0 : items.filter((i) => i[field] !== null && i[field] !== undefined && i[field] !== "").length / items.length;
	}
	return rates;
}

export async function fetchTargetPage(url: string): Promise<string> {
	const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } });
	if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
	return response.text();
}
