// The repair Actor. Opens the durable harness over the agent's KV store, prints the task tree (what was
// finished, what was interrupted), serves the steer page, computes the diff bundle with plain code, and
// wakes the agent on a fork of the build conversation. `probe` mode runs only a slow dummy tool, to
// demonstrate abort and resume.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { Actor } from "apify";
import { RepairExtension, type ToolEnv } from "./agent-tools.js";
import { computeDiffBundle, incidentText } from "./diff-bundle.js";
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
log(`steer & watch (this run only):   ${self.webUrl}`);
log(`stable link (redirects to the live run): ${REDIRECTOR_URL}?token=<your Apify token>`);
log(`scraper actor ${input.actorId}; failed run ${input.failedRunId}${self.runId ? `; this run ${runUrl(self.runId)}` : ""}`);

const other = await otherOwnerRunning(input.actorId);
if (other) {
	log(`another repair run (${other}) already owns the memory store for ${input.actorId}; exiting.`);
	await Actor.exit();
	process.exit(0);
}

const { storage, storeId, storeUrl } = await openAgentStorage(input.actorId, log);
log(`agent memory store: ${storeUrl}`);
log(`memory recovered: snapshot=${storage.recovery.snapshotSeq ?? "none"}, log records replayed=${storage.recovery.replayedFromLog}, head seq=${storage.recovery.headSeq}`);
const fixtures = openFixtureStore(storeId);

const env: ToolEnv = {
	scraperActorId: input.actorId,
	failedRunId: input.failedRunId,
	targetUrl,
	fixtures,
	log,
	budget: {
		maxToolCalls: 60,
		maxElapsedMs: 40 * 60_000,
		startedAt,
		toolCallsSoFar: async (conversationId) => {
			const page = await storage.scanEntries({ conversationId: conversationId as never }, 1000, undefined, context);
			return page.items.filter((entry) => (entry as { kind?: string }).kind === "pi.tool-result").length;
		},
	},
};

// --- probe mode tools: one slow tool, so an abort in the middle is visible and the resume is provable ---------
const slowSteps = defineTool({
	name: "slow_steps",
	description: "Does n slow steps of 10 seconds each and reports which ones it finished.",
	parameters: Type.Object({ n: Type.Number() }),
	// Not replay-safe on purpose: after a crash the model must get an `interrupted` result, not a rerun.
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

const harness = await Harness.open(
	storage,
	{
		models: openModels(),
		registry,
		settings: { toolExecution: "sequential", stream: { timeoutMs: 180_000 }, afterFailedRun: "continue" },
		onReport: (error, info) => log(`report (${JSON.stringify(info)}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
	},
	context,
);

const inspection = await printTaskTree(harness, storage, context, log, "task tree at startup (before resume)");
if (inspection.tasks.length > 0) log("some work was cut off by the previous run; resuming it now.");

let repairConversation: Conversation | undefined;
const server = startSteerServer({
	harness,
	storage,
	port: self.webPort,
	log,
	conversation: async () => repairConversation as never,
	header: () => `repair of ${input.actorId} for failed run ${input.failedRunId} | this run: ${self.runId ?? "local"} | memory: ${storeUrl}`,
});
harness.resume();

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
	log(`probe settled: ${settled.status}`);
	if (settled.status === "done" && settled.type === "input") {
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		log(`answer: ${JSON.stringify(answer?.model?.[0] ?? answer)}`);
	}
} else {
	// Which conversation handles this incident? One fork of the build conversation per failed run, remembered
	// in the store so a restarted run finds it instead of forking again.
	// One investigation at a time: a submission left behind by another incident (its run was aborted and never
	// restarted) is abandoned here, so only this incident's work is resumed.
	for (const stale of inspection.submissions as readonly { id: unknown; conversationId: unknown; requestId?: string }[]) {
		if (stale.requestId === input.failedRunId) continue;
		const staleConversation = await harness.conversation(stale.conversationId as never, context);
		if (!staleConversation) continue;
		log(`abandoning stale investigation for request ${stale.requestId ?? "?"} (conversation #${String(stale.conversationId)}): its run was aborted and this run is for a different incident`);
		await Promise.race([staleConversation.abort(context), new Promise((resolve) => setTimeout(resolve, 20_000))]);
	}
	const mappingKey = `repair-conversation-${input.failedRunId}`;
	const mapping = (await fixtures.get(mappingKey))?.value as { conversationId: number } | undefined;
	const root = await harness.root(context);
	if (mapping) {
		repairConversation = await harness.conversation(mapping.conversationId as never, context);
		log(`resuming investigation in conversation #${mapping.conversationId} (fork of the build conversation #${String(root.id)})`);
	} else {
		// Beat 2 (a): the diff bundle, computed by plain code before any model call.
		const bundle = await computeDiffBundle({ failedRunId: input.failedRunId, targetUrl, fixtures, log });
		const last = (await root.entries({}, 1, undefined, context)).items[0];
		if (!last) throw new Error("the build conversation is empty: run the build session first");
		repairConversation = await root.fork(last.id, { ownership: { kind: "ownerless" }, agent: { model: MODELS.fix } }, context);
		await fixtures.put(mappingKey, { conversationId: repairConversation.id, forkedAt: last.id, bundleKey: `incident-${input.failedRunId}` }, "application/json");
		log(`forked the build conversation #${String(root.id)} at entry #${String(last.id)} into conversation #${String(repairConversation.id)}; the agent sees its own handoff note first`);
		// The incident goes in as a platform entry (kind apify.incident), not as a user message.
		await repairConversation.submit(
			{
				requestId: input.failedRunId,
				type: "input",
				content: incidentText(bundle),
				entry: { kind: "apify.incident", data: { summary: incidentText(bundle), bundleKey: `incident-${input.failedRunId}`, failedRunId: input.failedRunId } },
			},
			context,
		);
		log(`incident submitted (request id = failed run id ${input.failedRunId}); waking the agent`);
	}
	if (!repairConversation) throw new Error("no repair conversation");
	// Same request id on a resumed run returns the existing submission; its wait resolves when the agent is done.
	const submission = await repairConversation.submit({ requestId: input.failedRunId, type: "input", content: "(resubmitted)" }, context);
	log(`waiting for the agent to finish (submission #${String(submission.id)})`);
	const settled = await submission.wait(context);
	log(`investigation settled: ${settled.status}`);
	await repairConversation.waitForIdle(context);
}

await printTaskTree(harness, storage, context, log, "task tree at shutdown");
const usage = await harness.usage(context);
log(`usage: ${JSON.stringify(usage)}`);
server.close();
await harness.close(context);
await storage.close(context);
await Actor.exit();
