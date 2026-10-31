// Run Steps 1 to 5 unattended on the live platform and check each result.
// Usage: npx tsx scripts/smoke.ts            (reset, Steps 1 to 5, reset)
//        npx tsx scripts/smoke.ts reset      (restore the original site and scraper)
// APIFY_TOKEN gives this script access to Apify. Every action uses the same API as the Console buttons.
// A webhook is the platform's HTTP notification that starts the repair run after a failure.
// POST /steer sends the agent a message. POST /approve saves a person's approval.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApifyClient } from "apify-client";
import { actorRef, agentStoreName, CONFIG, targetSiteUrl } from "../config.js";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const token = process.env.APIFY_TOKEN ?? "";
const SCRAPER = actorRef("scraper");
const REPAIR = actorRef("repair");
/** The agent's initial verified build. Reset points the production build label `prod` back at it. */
const ORIGINAL_PROD_BUILD = "x1nrd0s8qY8NVe6aK";
const STEER_TEXT = "the site also added a cookie banner, handle it";

const t0 = Date.now();
const log = (line: string) => console.log(`[smoke ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`);
const assert = (cond: unknown, msg: string) => {
	if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
	log(`ok: ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false>, every = 5000): Promise<T> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value;
		await sleep(every);
	}
	throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}
const runLog = async (runId: string) => (await client.run(runId).log().get()) ?? "";
const runStatus = async (runId: string) => (await client.run(runId).get())?.status ?? "?";
const site = (path: string) => fetch(`${targetSiteUrl()}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());

async function reset(): Promise<void> {
	log("reset: site -> variant a, selectors.js -> original, prod -> original build");
	log(`site says ${await site("variant?set=a")}`);
	const original = await readFile(join(import.meta.dirname, "..", "actors", "scraper", "selectors.js"), "utf8");
	const actor = await client.actor(SCRAPER).get();
	if (!actor) throw new Error("scraper actor not found");
	const version = await client.actor(SCRAPER).version(CONFIG.scraperVersion).get();
	const files = ((version as { sourceFiles?: { name: string; content: string; format: string }[] })?.sourceFiles ?? []).map((f) => (f.name === "selectors.js" ? { ...f, content: original } : f));
	await client.actor(SCRAPER).version(CONFIG.scraperVersion).update({ sourceFiles: files } as never);
	const build = await client.build(ORIGINAL_PROD_BUILD).get();
	const taggedBuilds = { ...((actor as { taggedBuilds?: Record<string, unknown> }).taggedBuilds ?? {}), [CONFIG.buildTag]: { buildId: ORIGINAL_PROD_BUILD, buildNumber: build?.buildNumber } };
	await client.actor(SCRAPER).update({ taggedBuilds } as never);
	log(`reset done: prod -> ${ORIGINAL_PROD_BUILD} (${build?.buildNumber})`);
}

async function findRepairRun(failedRunId: string, notBefore: number): Promise<{ id: string; containerUrl: string } | undefined> {
	const runs = await client.actor(REPAIR).runs().list({ desc: true, limit: 10 });
	for (const run of runs.items) {
		if (new Date(run.startedAt).getTime() < notBefore) continue;
		const detail = await client.run(run.id).get();
		if (!detail) continue;
		const input = (await client.keyValueStore(detail.defaultKeyValueStoreId).getRecord("INPUT"))?.value as { failedRunId?: string } | undefined;
		if (input?.failedRunId === failedRunId) return { id: run.id, containerUrl: detail.containerUrl ?? "" };
	}
	return undefined;
}

async function readSnapshot(containerUrl: string): Promise<string> {
	// /events streams updates over one open connection. Its first event contains everything saved so far.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(`${containerUrl}/events`, { signal: controller.signal });
		const reader = res.body?.getReader();
		let text = "";
		while (reader) {
			const { value, done } = await reader.read();
			if (done) break;
			text += new TextDecoder().decode(value);
			if (text.includes("\n\n")) break;
		}
		return text;
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

async function pass(): Promise<void> {
	await reset();

	// Step 1: the site owner changes the layout and the scraper run fails.
	log("step 1: changing the site to layout b");
	log(`site says ${await site("variant?set=b")}`);
	const failedAt = Date.now();
	const red = await client.actor(SCRAPER).call({}, { build: CONFIG.buildTag, waitSecs: 240 });
	assert(red.status === "FAILED", `scraper run ${red.id} (build ${red.buildNumber}) FAILED as expected`);
	const diagnosis = await client.keyValueStore(red.defaultKeyValueStoreId).getRecord("DIAGNOSIS");
	assert(diagnosis?.value, "the failed run wrote a DIAGNOSIS record");

	// Step 2: the failure notification starts the repair Actor. The page comparison and first message appear.
	const repair1 = await until("the webhook to start a repair run", 120_000, () => findRepairRun(red.id, failedAt), 5000);
	log(`step 2: failure notification started repair run ${repair1.id}. Agent web page ${repair1.containerUrl}`);
	const bundleLog = await until("the page comparison in the repair log", 90_000, async () => {
		const text = await runLog(repair1.id);
		return text.includes("=== end of diff bundle ===") ? text : undefined;
	});
	assert(/price\s+\.price-tag\s+build time: 20 matches, now: 0\s+-> MISSING/.test(bundleLog), "page comparison reports .price-tag missing");
	assert(bundleLog.includes("cookie-banner"), "page comparison lists the new cookie banner class");
	assert(bundleLog.includes("waking the agent") || bundleLog.includes("resuming investigation"), "failure record sent to the agent");
	const firstMessage = await until("the agent's first message on the agent web page", 120_000, async () => {
		const snapshot = await readSnapshot(repair1.containerUrl);
		const after = snapshot.slice(snapshot.indexOf("apify.incident"));
		return /"role":"assistant","content":\[\{"type":"text","text":"((?:[^"\\]|\\.)*)"/.exec(after)?.[1];
	}, 3000);
	log(`agent's first message: ${firstMessage.slice(0, 400)}`);
	assert(/price-tag/.test(firstMessage) && /amount/.test(firstMessage), "first message names the saved build decision: .price-tag chosen, .amount rejected. The saved build notes supply .amount because the page comparison does not include it");

	// Step 3: stop the run during the investigation, then restart it with the same input.
	// Stop while a tool runs: the agent starts the build after writing the source.
	await until("the agent to write the scraper source (abort point)", 120_000, async () => (await runLog(repair1.id)).includes("scraper source written"), 2000).catch(() => log("agent did not write source within 120s; aborting anyway"));
	await client.run(repair1.id).abort();
	await until(`run ${repair1.id} to be ABORTED`, 120_000, async () => (await runStatus(repair1.id)) === "ABORTED");
	const log1 = await runLog(repair1.id);
	log(`step 3: stopped ${repair1.id} after ${(log1.match(/\] status: /g) ?? []).length} status lines. Restarting with the same input`);
	const input = (await client.keyValueStore((await client.run(repair1.id).get())!.defaultKeyValueStoreId).getRecord("INPUT"))?.value as object;
	const repair2 = await client.actor(REPAIR).start(input);
	const startupLog = await until("the restarted run to print its saved work status", 120_000, async () => {
		const text = await runLog(repair2.id);
		return text.includes("waiting for the agent to finish") ? text : undefined;
	});
	assert(/memory recovered: snapshot=\d+, log records replayed=\d+, head seq=\d+/.test(startupLog), "restarted run recovered the agent's memory from the key-value store");
	assert(startupLog.includes("resuming investigation in conversation #"), "restarted run reused the same investigation conversation (no second investigation)");
	const tree = startupLog.split("\n").filter((l) => /task tree|live tasks|pi\.generation|pi\.tool|submission #|abandoning|resuming investigation/.test(l)).map((l) => l.replace(/^.*?\] /, "    "));
	log(`saved work status printed at restart:\n${tree.join("\n")}`);
	const repair2Detail = await client.run(repair2.id).get();
	const steerUrl = repair2Detail?.containerUrl ?? "";
	log(`restarted run ${repair2.id}. New agent web page ${steerUrl}`);

	// Step 4: send the agent a message while it works.
	await until("the agent web page to answer", 90_000, async () => (await fetch(steerUrl).then((r) => r.status).catch(() => 0)) === 200);
	const steer = await fetch(`${steerUrl}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: STEER_TEXT }) });
	assert(steer.status === 200, `step 4: message accepted: ${await steer.text()}`);

	// Step 5: wait for the approval check, then put the fix live.
	await until("the approval check to ask for approval", 600_000, async () => (await runLog(repair2.id)).includes("gate: WAITING FOR APPROVAL"));
	log("step 5: approval check is waiting. Approving as 'smoke'");
	const approve = await fetch(`${steerUrl}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: "smoke" }) });
	assert(approve.status === 200, `approval accepted: ${await approve.text()}`);
	const finalStatus = await until("the repair run to finish", 600_000, async () => {
		const s = await runStatus(repair2.id);
		return ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(s) ? s : undefined;
	});
	const log2 = await runLog(repair2.id);
	assert(finalStatus === "SUCCEEDED", `repair run ${repair2.id} finished with ${finalStatus}`);
	assert(/PROMOTED: prod -> build (\S+)/.test(log2), "production build label now points to the fix");
	const report = (await client.dataset(repair2Detail!.defaultDatasetId).listItems()).items[0] as Record<string, unknown> | undefined;
	assert(report?.outcome === "promoted" && report.approvedBy === "smoke", `report in the dataset: outcome=${report?.outcome} approvedBy=${report?.approvedBy} elapsed=${report?.elapsedSeconds}s CU=${report?.computeUnitsThisRun}`);
	log(`report ${/cookie/i.test(JSON.stringify(report)) ? "mentions" : "does NOT mention"} the cookie banner from the message`);
	const green = await client.actor(SCRAPER).call({}, { build: CONFIG.buildTag, waitSecs: 240 });
	assert(green.status === "SUCCEEDED", `next scraper run ${green.id} on prod (build ${green.buildNumber}) is green`);
	log(`PASS in ${((Date.now() - t0) / 1000).toFixed(0)}s: red ${red.id}, repair ${repair1.id} -> ${repair2.id}, green ${green.id}, memory store ${agentStoreName((await client.actor(SCRAPER).get())!.id)}`);
	await reset();
}

if (process.argv[2] === "reset") await reset();
else await pass();
