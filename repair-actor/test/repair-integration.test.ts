import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { Actor } from "apify";
import { describe, expect, it, vi } from "vitest";
import { RepairExtension, type ToolEnv } from "../src/agent-tools.js";
import { compactionSettings, PRESERVATION_INSTRUCTIONS, SUMMARY_MAX_TOKENS, type Summarize } from "../src/compaction.js";
import type { FixtureStore } from "../src/fixtures.js";
import { MODELS } from "../src/models.js";
import { latestCompletedHandoff, ownEntries, repairHandoff } from "../src/repair-chain.js";
import * as scraper from "../src/scraper-platform.js";

const context = BACKGROUND_CONTEXT;
const BUILD_NOTE = "Price .price-tag chosen: present on all 20 products. Rejected .amount: old prices on only 7 of 20. Production build original-1.";
const NOTE = "Price decision: .price-tag is still live, because the candidate did not pass validation.\nRejected price alternative: .amount rejected because it contains old prices on only 7 of 20 products.\nLayout b has a cookie banner. Tried .value in candidate-1 but gave up; production original-1 unchanged. Unresolved: failing canary.";
const fixtures: FixtureStore = { async get() { return undefined; }, async put(key) { return key; }, url: (key) => key };

async function setup(options: { summarize?: Summarize; keepRecentTokens?: number } = {}) {
	const faux = fauxProvider({ provider: "openrouter", models: [{ id: MODELS.fix.modelId, contextWindow: 1_000_000, maxTokens: 64_000 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const models = createModels();
	models.setProvider(faux.provider);
	let harness: Harness;
	const env: ToolEnv = { scraperActorId: "scraper", failedRunId: "failed-new", targetUrl: "https://example.test", fixtures, log() {}, getConversation: (id, ctx) => harness.conversation(id, ctx), budget: { maxToolCalls: 60, maxElapsedMs: 600_000, startedAt: Date.now(), toolCallsSoFar: async () => 0 } };
	const registry = createRegistry();
	const extension = RepairExtension(env, { summarize: options.summarize });
	registry.install(extension);
	const settings = compactionSettings(models, [MODELS.fix]);
	if (options.keepRecentTokens !== undefined) settings.modelOverrides[`${MODELS.fix.provider}/${MODELS.fix.modelId}`]!.keepRecentTokens = options.keepRecentTokens;
	const storage = new MemoryStorage();
	harness = await Harness.open(storage, { models, registry, settings: { toolExecution: "sequential", compaction: settings } }, context);
	const root = await harness.root(context, { agent: { model: MODELS.fix } });
	const reset = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.reset", head: "self", model: [{ role: "user", content: BUILD_NOTE, timestamp: 0 }] }), context);
	return { harness, storage, root, reset, faux, extension };
}

describe("repair memory integration", () => {
	it("lets the real tool lifecycle commit a gave-up handoff, leaves production unchanged, and forks it next", async () => {
		const push = vi.spyOn(Actor, "pushData").mockResolvedValue(undefined as never);
		vi.spyOn(Actor, "setValue").mockResolvedValue(undefined);
		const promote = vi.spyOn(scraper, "tagBuild").mockImplementation(async () => { throw new Error("unexpected promotion in an offline test"); });
		vi.stubEnv("ACTOR_RUN_ID", "");
		const { harness, storage, root, reset, faux } = await setup();
		try {
			const repair = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			faux.setResponses([fauxAssistantMessage([fauxText("I chose .price-tag and rejected .amount because it was an old price on 7 of 20 items."), fauxToolCall("write_report", { whatChanged: "layout b", whatWasDone: "candidate did not pass", outcome: "gave up", handoffNote: NOTE })], { stopReason: "toolUse" })]);
			const submission = await repair.submit({ requestId: "failed-new", type: "input", content: "Investigate", entry: { kind: "apify.incident", data: { failedRunId: "failed-new" } } }, context);
			expect((await submission.wait(context)).status).toBe("done");
			await repair.waitForIdle(context);
			expect(push).toHaveBeenCalledWith(expect.objectContaining({ outcome: "gave up", handoffNote: NOTE }));
			expect(promote).not.toHaveBeenCalled();
			expect(faux.state.callCount).toBe(1); // terminate + handoff ends the run without another generation.
			const completion = await latestCompletedHandoff(harness, storage, context);
			expect(completion).toMatchObject({ conversationId: repair.id, failedRunId: "failed-new", note: repairHandoff("failed-new", NOTE) });
			const own = await ownEntries(repair, context);
			expect(own.some((entry) => entry.kind === "pi.reset" && entry.id === completion!.entryId)).toBe(true);
			const next = await repair.fork(completion!.entryId, { ownership: { kind: "ownerless" } }, context);
			expect((await next.context(context)).messages).toMatchObject([{ role: "user", content: repairHandoff("failed-new", NOTE) }]);
		} finally { await harness.close(context); vi.restoreAllMocks(); vi.unstubAllEnvs(); }
	});

	it("registers recall on a full fork-aware handle and explains when to use it without supplying build evidence", async () => {
		const { harness, root, reset, extension } = await setup();
		try {
			const repair = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			const tool = extension.tools!.find((tool) => tool.name === "recall_history")!;
			expect(tool).toBeDefined();
			const result = await tool.execute({ query: "amount rejected" } as never, { conversationId: repair.id } as never, context);
			expect(result.isError).not.toBe(true);
			expect(JSON.stringify(result.output)).toContain(".amount");
			expect(JSON.stringify(result.output)).toContain(`conversation #${root.id}`);
			const role = await extension.sections![0]!.render({} as never, context);
			expect(role).toContain("search your history with recall_history before guessing");
			expect(role).toContain("source incident");
			// Keep the smoke memory invariant: neither role nor incident supplies the rejected class name.
			expect(role).not.toContain(".amount");
			expect(role).not.toContain(".price-tag");
		} finally { await harness.close(context); }
	});

	it("uses the installed repair hook for real compaction and records summary usage", async () => {
		const summarize = vi.fn<Summarize>(async () => ({ ...fauxAssistantMessage("Selector decisions retained. Rejected .amount: old prices on 7/20."), provider: MODELS.fix.provider, model: MODELS.fix.modelId, usage: { input: 111, output: 22, cacheRead: 0, cacheWrite: 0, totalTokens: 133, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
		const { harness, root, extension } = await setup({ summarize, keepRecentTokens: 40 });
		try {
			await root.commit(async (tx) => { for (let i = 0; i < 12; i++) await tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage(`Investigation step ${i}: checked all prices and alternatives in detail.`)] }); }, context);
			const id = await root.compact(undefined, context);
			await harness.waitForTask(id, context);
			await harness.waitForIdle(context);
			expect(extension.hooks!.some((hook) => hook.task === "pi.compaction")).toBe(true);
			expect((await root.context(context)).head?.kind).toBe("pi.compaction");
			expect(summarize).toHaveBeenCalledOnce();
			expect(summarize.mock.calls[0]![1].messages[0]!.content).toContain(PRESERVATION_INSTRUCTIONS);
			expect(summarize.mock.calls[0]![2].maxTokens).toBe(SUMMARY_MAX_TOKENS);
			expect((await harness.snapshot(UsageDoc, root.id, context))!.models[`${MODELS.fix.provider}/${MODELS.fix.modelId}`]).toMatchObject({ input: 111, output: 22, totalTokens: 133 });
		} finally { await harness.close(context); }
	});
});
