// The repair Actor loads the agent's saved steps from its key-value store through the agent framework.
// It prints completed and interrupted work, serves the agent web page, and computes the page comparison.
// New repairs share the latest finished repair's history and notes, falling back to the original build.
// `probe` mode uses a slow test tool to demonstrate stopping and restarting the run.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { Actor } from "apify";
import { RepairExtension, type ToolEnv } from "./agent-tools.js";
import { computeDiffBundle } from "./diff-bundle.js";
import { compactionSettings } from "./compaction.js";
import { abandonMarkedWork, countOwnToolResults, markStaleWork, ownEntries, reconcileLatestHandoff, repairMappingKey, submitSavedIncident, type RepairMapping } from "./repair-chain.js";
import { openFixtureStore } from "./fixtures.js";
import { MODELS, openModels } from "./models.js";
import { openAgentStorage, otherOwnerRunning, REDIRECTOR_URL, type RepairInput, runUrl, self, TARGET_URL } from "./platform.js";
import { startSteerServer } from "./steer-server.js";
import { printTaskTree } from "./task-tree.js";

const context = BACKGROUND_CONTEXT;
const startedAt = Date.now();
const log = (line: string): void => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}`);

await Actor.init();
const input = (await Actor.getInput<RepairInput>()) ?? ({} as RepairInput);
if (!input.actorId || !input.failedRunId) throw new Error("input needs actorId and failedRunId");
const targetUrl = input.targetUrl ?? TARGET_URL;

log("================= SHD repair agent =================");
log(`agent web page (this run only):   ${self.webUrl}`);
log(`permanent link (opens the live run): ${REDIRECTOR_URL}?token=<APIFY_TOKEN>`);
log(`scraper actor ${input.actorId}; failed run ${input.failedRunId}${self.runId ? `; this run ${runUrl(self.runId)}` : ""}`);

const other = await otherOwnerRunning(input.actorId);
if (other) {
	log(`another repair run (${other}) already uses the memory store for ${input.actorId}. Exiting.`);
	await Actor.exit();
	process.exit(0);
}

const { storage, storeId, storeUrl } = await openAgentStorage(input.actorId, log);
log(`agent memory store: ${storeUrl}`);
log(`memory recovered: snapshot=${storage.recovery.snapshotSeq ?? "none"}, log records replayed=${storage.recovery.replayedFromLog}, head seq=${storage.recovery.headSeq}`);
const fixtures = openFixtureStore(storeId);
const mappingKey = repairMappingKey(input.failedRunId);
const mapping = (await fixtures.get(mappingKey))?.value as RepairMapping | undefined;
// Persist ALL stale abort marks before opening the scheduler. Even abort() can start scheduling.
const staleConversations = input.mode === "probe" ? [] : await markStaleWork(storage, mapping?.conversationId, context);

let harnessRef: Harness | undefined;
const env: ToolEnv = {
	scraperActorId: input.actorId,
	failedRunId: input.failedRunId,
	targetUrl,
	fixtures,
	log,
	getConversation: (id, ctx) => {
		if (!harnessRef) throw new Error("repair harness is not open yet");
		return harnessRef.conversation(id, ctx);
	},
	budget: {
		maxToolCalls: 60,
		maxElapsedMs: 40 * 60_000,
		startedAt,
		toolCallsSoFar: async (conversationId) => countOwnToolResults(storage, conversationId as never, context),
	},
};

// Test mode uses a slow tool so you can see where a stopped run continues after a restart.
const slowSteps = defineTool({
	name: "slow_steps",
	description: "Does n slow steps of 10 seconds each and reports which ones it finished.",
	parameters: Type.Object({ n: Type.Number() }),
	// Do not repeat this tool after a crash. The model receives an `interrupted` result.
	execute: async (args, api) => {
		for (let i = 1; i <= args.n; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10_000));
			api.output(`step ${i}/${args.n} done\n`);
			log(`slow_steps: step ${i}/${args.n} done`);
		}
		return {};
	},
});
const quickStep = defineTool({
	name: "quick_step",
	description: "Returns immediately with a tag.",
	parameters: Type.Object({ tag: Type.String() }),
	replay: "safe",
	execute: async (args) => {
		log(`quick_step(${args.tag})`);
		return { output: [{ type: "text", text: `quick_step ${args.tag} ok` }] };
	},
});

const registry = createRegistry();
if (input.mode === "probe") registry.install(defineExtension({ name: "probe", tools: [quickStep, slowSteps] }));
else registry.install(RepairExtension(env));

const models = openModels();
const compaction = compactionSettings(models, [MODELS.fix, MODELS.narrate, MODELS.build]);
log(`compaction policies from the installed model catalog: ${JSON.stringify(compaction.modelOverrides)}`);
const harness = await Harness.open(
	storage,
	{
		models,
		registry,
		settings: { toolExecution: "sequential", stream: { timeoutMs: 180_000 }, afterFailedRun: "continue", compaction },
		onReport: (error, info) => log(`report (${JSON.stringify(info)}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
	},
	context,
);

harnessRef = harness;

const inspection = await printTaskTree(harness, storage, context, log, "task tree at startup (before resume)");
if (inspection.tasks.length > 0) log("recovered unfinished work; only this incident resumes, stale investigations are marked for abandonment.");

let repairConversation: Conversation | undefined;
const server = startSteerServer({
	harness,
	storage,
	port: self.webPort,
	log,
	conversation: async () => repairConversation as never,
	header: () => `repair of ${input.actorId} for failed run ${input.failedRunId} | this run: ${self.runId ?? "local"} | memory: ${storeUrl}`,
});
if (input.mode !== "probe") await abandonMarkedWork(harness, staleConversations, context, log);

if (input.mode === "probe") {
	const root = await harness.root(context, { agent: { model: MODELS.narrate } });
	repairConversation = root;
	const submission = await root.submit(
		{
			requestId: `probe-${input.failedRunId}`,
			type: "input",
			content:
				"Call quick_step with tag 'before'. Then call slow_steps with n=12. Then call quick_step with tag 'after'. Finally reply with one line listing which tool calls finished and which, if any, were reported as interrupted.",
		},
		context,
	);
	log(`probe submission #${String(submission.id)} admitted (request probe-${input.failedRunId}); waiting for the answer`);
	const settled = await submission.wait(context);
	log(`probe request finished: ${settled.status}`);
	if (settled.status === "done" && settled.type === "input") {
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		log(`answer: ${JSON.stringify(answer?.model?.[0] ?? answer)}`);
	}
} else {
	const latest = await reconcileLatestHandoff(harness, storage, fixtures, context);
	const root = await harness.root(context);
	if (mapping) {
		repairConversation = await harness.conversation(mapping.conversationId, context);
		if (!repairConversation) throw new Error(`mapped repair conversation #${mapping.conversationId} is missing`);
		log(`resuming investigation in conversation #${mapping.conversationId} (parent conversation #${String(mapping.parentConversationId ?? root.id)}, fork entry #${String(mapping.forkedAt ?? "legacy")})`);
	} else {
		// Plain code computes the comparison against the immutable original build before any model call.
		await computeDiffBundle({ failedRunId: input.failedRunId, targetUrl, fixtures, log });
		const parent = latest ? await harness.conversation(latest.conversationId, context) : root;
		if (!parent) throw new Error("latest completed repair conversation is missing");
		const forkedAt = latest?.entryId ?? (await ownEntries(root, context)).filter((entry) => entry.kind === "pi.reset").at(-1)?.id;
		if (!forkedAt) throw new Error("the build has no handoff: run the build session first");
		repairConversation = await parent.fork(forkedAt, { ownership: { kind: "ownerless" }, agent: { model: MODELS.fix } }, context);
		const provenance: RepairMapping = { conversationId: repairConversation.id, forkedAt, parentConversationId: parent.id, ...(latest ? { parentFailedRunId: latest.failedRunId } : {}), bundleKey: `incident-${input.failedRunId}` };
		await fixtures.put(mappingKey, provenance, "application/json");
		log(`forked the ${latest ? "latest finished repair" : "build"} conversation #${String(parent.id)} at entry #${String(forkedAt)} into conversation #${String(repairConversation.id)}; the agent sees its own handoff note first${latest ? ` (source incident ${latest.failedRunId})` : ""}`);
	}
	// Reuse the actual saved incident even if the process died between mapping and admission.
	const submission = await submitSavedIncident(repairConversation, input.failedRunId, fixtures, context);
	log(`incident submitted (request id = failed run id ${input.failedRunId}); waking the agent`);
	log(`waiting for the agent to finish (submission #${String(submission.id)})`);
	const settled = await submission.wait(context);
	log(`investigation finished: ${settled.status}`);
	await repairConversation.waitForIdle(context);
	const completed = await reconcileLatestHandoff(harness, storage, fixtures, context);
	if (completed) log(`latest handoff: conversation #${String(completed.conversationId)}, entry #${String(completed.entryId)}, source incident ${completed.failedRunId}`);
}

await printTaskTree(harness, storage, context, log, "task tree at shutdown");
const usage = await harness.usage(context);
log(`usage: ${JSON.stringify(usage)}`);
server.close();
await harness.close(context);
await storage.close(context);
await Actor.exit();
