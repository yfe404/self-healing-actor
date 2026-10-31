// The build session: the agent builds the scraper through the durable harness once, so its memory is real.
// Runs locally with tsx, but writes into the same platform KV store the repair Actor later opens.
// Usage: APIFY_TOKEN=.. OPENROUTER_API_KEY=.. npx tsx scripts/build-session.ts <scraperActorId> <targetUrl> [--fresh]
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { BuildExtension, type ToolEnv } from "../src/agent-tools.js";
import { platformFixtureStore } from "../src/fixtures.js";
import { MODELS, openModels } from "../src/models.js";
import { agentStoreName, client } from "../src/platform.js";
import { ApifyKvStorage } from "../src/kvstore/apify-kv-storage.js";
import { apifyKvClient } from "../src/kvstore/kv-client.js";

const context = BACKGROUND_CONTEXT;
const [scraperActorId, targetUrl, flag] = process.argv.slice(2);
if (!scraperActorId || !targetUrl) throw new Error("usage: build-session.ts <scraperActorId> <targetUrl> [--fresh]");
const log = (line: string) => console.log(`[build] ${line}`);

const name = agentStoreName(scraperActorId);
if (flag === "--fresh") {
	const existing = await client.keyValueStores().getOrCreate(name);
	await client.keyValueStore(existing.id).delete();
	log(`deleted old store ${existing.id}`);
}
const { id: storeId } = await client.keyValueStores().getOrCreate(name);
log(`agent store ${name} = ${storeId} (https://console.apify.com/storage/key-value-stores/${storeId})`);
const storage = await ApifyKvStorage.open(apifyKvClient(client, storeId), { log });

const env: ToolEnv = {
	scraperActorId,
	failedRunId: "",
	targetUrl,
	fixtures: platformFixtureStore(storeId),
	log,
	budget: { maxToolCalls: 40, maxElapsedMs: 30 * 60_000, startedAt: Date.now(), toolCallsSoFar: async () => 0 },
};
const registry = createRegistry();
registry.install(BuildExtension(env));
const harness = await Harness.open(
	storage,
	{ models: openModels(), registry, settings: { toolExecution: "sequential", stream: { timeoutMs: 300_000 } }, onReport: (e, info) => log(`report ${JSON.stringify(info)}: ${String(e)}`) },
	context,
);
const root = await harness.root(context, { agent: { model: MODELS.build } });

const submission = await root.submit(
	{
		requestId: "build-1",
		type: "input",
		content: [
			`Build and verify the scraper for ${targetUrl}, then hand off.`,
			"1. snapshot_page (label 'build time') and read the HTML. For each field (item, name, price, rating) list the candidate selectors you see and check on how many of the items each candidate appears. Prefer selectors that appear on every item; reject ones that appear only on some items or carry a different meaning, and say why.",
			"2. read_scraper_source selectors.js. If the selectors there are not the ones you chose, write_scraper_file with your version (same exports: SELECTORS and extract).",
			"3. build_scraper, then run_canary with that buildId. Check item count and fill rates.",
			"4. store_fixture fixture-expected-sample (the first 5 items exactly as the canary returned them), fixture-invariants ({ fillRateThresholds: { name: 0.95, price: 0.9, rating: 0.9 }, itemCountMin: 15, itemCountMax: 30 }), and fixture-selectors (the SELECTORS object).",
			"5. tag_prod with the verified buildId.",
			"6. finish_build with a handoff note written for your future self: per field, the selector chosen and the reason, the alternatives rejected and why (name the classes), the fixtures stored, the invariants, the prod build id. Plain prose, under 350 words.",
		].join("\n"),
	},
	context,
);
log(`submission ${String(submission.id)} admitted; the agent is building (this takes a few minutes)`);
const settled = await submission.wait(context);
log(`settled: ${JSON.stringify(settled).slice(0, 600)}`);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	log(`last answer: ${JSON.stringify(answer?.model?.[0]?.content ?? answer).slice(0, 1500)}`);
}
await harness.waitForIdle(context);
const view = await root.context(context);
log(`context after handoff: ${view.entries.length} visible entries, head #${String(view.head)}`);
for (const message of view.messages) log(`visible to the model now: ${JSON.stringify(message).slice(0, 2000)}`);
const usage = await harness.usage(context);
log(`usage: ${JSON.stringify(usage)}`);
await harness.close(context);
await storage.close(context);
