import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, InboxDoc, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { Actor } from "apify";
import { RepairExtension, type ToolEnv } from "../src/agent-tools.js";
import type { DiffBundle } from "../src/diff-bundle.js";
import type { FixtureStore } from "../src/fixtures.js";
import { ApifyKvStorage } from "../src/kvstore/apify-kv-storage.js";
import { memoryKvClient } from "../src/kvstore/kv-client.js";
import { abandonMarkedWork, countOwnToolResults, entryText, latestCompletedHandoff, markStaleWork, ownEntries, reconcileLatestHandoff, repairHandoff, submitSavedIncident } from "../src/repair-chain.js";

const context = BACKGROUND_CONTEXT;
function fixtureStore(): FixtureStore {
	const records = new Map<string, { value: unknown; contentType: string }>();
	return { async get(key) { return records.get(key); }, async put(key, value, contentType) { records.set(key, { value, contentType }); return key; }, url: (key) => key };
}
async function open() {
	const storage = new MemoryStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
	const root = await harness.root(context);
	const reset = await root.commit((tx) => tx.appendEntry(root.id, { kind: "pi.reset", head: "self", model: [{ role: "user", content: "Build notes: .price-tag chosen; .amount rejected, only 7/20 old prices.", timestamp: 0 }] }), context);
	return { storage, harness, root, reset };
}

// Write the same durable records as a report round, without a model or platform request.
async function complete(conversation: Conversation, id: string, options: { reportError?: boolean; reset?: boolean; settled?: boolean } = {}) {
	const note = repairHandoff(id, "Current price .value: all products. Reject .amount: old prices on 7/20. Layout b, cookie banner; build candidate-1 promoted. No unresolved work.");
	return conversation.commit(async (tx) => {
		const incident = await tx.appendEntry(conversation.id, { kind: "apify.incident", data: { failedRunId: id } });
		const answer = await tx.appendEntry(conversation.id, { kind: "pi.assistant" });
		const report = await tx.appendEntry(conversation.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "write_report", toolCallId: "report", content: [{ type: "text", text: "report written" }], isError: options.reportError ?? false, details: { failedRunId: id, repairHandoff: note }, timestamp: 0 }] });
		const reset = options.reset === false ? undefined : await tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self", model: [{ role: "user", content: note, timestamp: 0 }] });
		await tx.createSubmission(options.settled === false
			? { conversationId: conversation.id, requestId: id, type: "input", status: "placed", entry: incident.id }
			: { conversationId: conversation.id, requestId: id, type: "input", status: "done", entry: incident.id, answer: answer.id });
		return { incident, report, reset, note };
	}, context);
}

describe("repair chain", () => {
	it("chains two repairs, preserving ancestral history but showing only latest notes", async () => {
		const { harness, storage, root, reset } = await open();
		try {
			expect(await latestCompletedHandoff(harness, storage, context)).toBeUndefined();
			const first = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			const finished = await complete(first, "failed-1");
			const latest = await latestCompletedHandoff(harness, storage, context);
			expect(latest).toMatchObject({ conversationId: first.id, entryId: finished.reset!.id, failedRunId: "failed-1" });
			const second = await first.fork(latest!.entryId, { ownership: { kind: "ownerless" } }, context);
			expect((await second.context(context)).messages).toMatchObject([{ content: finished.note }]);
			expect((await second.entries({}, 100, undefined, context)).items.some((entry) => entry.id === reset.id)).toBe(true);
			const finished2 = await complete(second, "failed-2");
			expect(await latestCompletedHandoff(harness, storage, context)).toMatchObject({ conversationId: second.id, entryId: finished2.reset!.id, failedRunId: "failed-2" });
		} finally { await harness.close(context); }
	});

	it.each([
		{ reportError: true }, { reset: false }, { settled: false },
	])("rejects incomplete completion %j and never counts an inherited reset", async (options) => {
		const { harness, storage, root, reset } = await open();
		try {
			const repair = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			await complete(repair, "unfinished", options);
			expect(await latestCompletedHandoff(harness, storage, context)).toBeUndefined();
		} finally { await harness.close(context); }
	});

	it("does not mistake an inherited successful report for the child's completion", async () => {
		const { harness, storage, root, reset } = await open();
		try {
			const first = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			const finished = await complete(first, "parent");
			const child = await first.fork(finished.reset!.id, { ownership: { kind: "ownerless" } }, context);
			await child.commit((tx) => tx.appendEntry(child.id, { kind: "pi.reset", head: "self", model: [{ role: "user", content: finished.note, timestamp: 1 }] }), context);
			expect(await latestCompletedHandoff(harness, storage, context)).toMatchObject({ conversationId: first.id, entryId: finished.reset!.id });
		} finally { await harness.close(context); }
	});

	it("forks at the report reset even when queued human entries follow it", async () => {
		const { harness, storage, root, reset } = await open();
		try {
			const repair = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			const finished = await complete(repair, "queued-steer");
			await repair.commit((tx) => tx.appendEntry(repair.id, { kind: "apify.steer", model: [{ role: "user", content: "Thanks, another question", timestamp: 1 }] }), context);
			const latest = await latestCompletedHandoff(harness, storage, context);
			expect(latest!.entryId).toBe(finished.reset!.id);
			const next = await repair.fork(latest!.entryId, { ownership: { kind: "ownerless" } }, context);
			expect((await next.context(context)).messages).toHaveLength(1);
			expect(entryText((await next.context(context)).head!)).toBe(finished.note);
		} finally { await harness.close(context); }
	});

	it("reconciles missed cache publication and old restarts cannot regress it", async () => {
		const { harness, storage, root, reset } = await open();
		const fixtures = fixtureStore();
		try {
			const first = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			const a = await complete(first, "a");
			const second = await first.fork(a.reset!.id, { ownership: { kind: "ownerless" } }, context);
			await complete(second, "b");
			expect(await fixtures.get("latest-handoff")).toBeUndefined();
			await reconcileLatestHandoff(harness, storage, fixtures, context);
			expect((await fixtures.get("latest-handoff"))?.value).toMatchObject({ failedRunId: "b", conversationId: second.id });
			// A restart of a maps back to first but reconciliation always scans the whole store.
			await harness.conversation(first.id, context);
			await reconcileLatestHandoff(harness, storage, fixtures, context);
			expect((await fixtures.get("latest-handoff"))?.value).toMatchObject({ failedRunId: "b" });
		} finally { await harness.close(context); }
	});

	it("paginates and counts only the current repair's tool results", async () => {
		const { harness, storage, root, reset } = await open();
		try {
			await root.commit(async (tx) => { for (let i = 0; i < 125; i++) await tx.appendEntry(root.id, { kind: "pi.tool-result" }); }, context);
			const tail = (await root.entries({}, 1, undefined, context)).items[0]!;
			const repair = await root.fork(tail.id, { ownership: { kind: "ownerless" } }, context);
			await repair.commit(async (tx) => { for (let i = 0; i < 205; i++) await tx.appendEntry(repair.id, { kind: i % 2 ? "pi.tool-result" : "pi.assistant" }); }, context);
			expect(await countOwnToolResults(storage, repair.id, context)).toBe(102);
			expect(await ownEntries(repair, context)).toHaveLength(205);
			expect(reset.id).toBeLessThan(tail.id);
		} finally { await harness.close(context); }
	});

	it("recovers mapping-before-submit with the actual incident and same request ID", async () => {
		const fixtures = fixtureStore();
		const bundle = { failedRunId: "saved", targetUrl: "https://example.test", bytes: { before: 1, now: 2 }, selectorMatches: [], newScripts: [], newClasses: [], removedClasses: [], suspiciousNewClasses: [], newIds: [], failedRun: { status: "FAILED", itemCount: 0, fillRates: {}, diagnosis: null }, screenshots: { before: "before", after: "after" } } as unknown as DiffBundle;
		await fixtures.put("incident-saved", bundle, "application/json");
		const { harness, root, reset } = await open();
		try {
			const mapped = await root.fork(reset.id, { ownership: { kind: "ownerless" } }, context);
			await fixtures.put("repair-conversation-saved", { conversationId: mapped.id, forkedAt: reset.id, parentConversationId: root.id }, "application/json");
			const first = await submitSavedIncident(mapped, "saved", fixtures, context);
			await first.wait(context); // No model is configured, so the incident settles unanswered without external calls.
			const again = await submitSavedIncident(mapped, "saved", fixtures, context);
			expect(again.id).toBe(first.id);
			const entries = await ownEntries(mapped, context);
			const incidents = entries.filter((entry) => entry.kind === "apify.incident");
			expect(incidents).toHaveLength(1);
			expect(incidents[0]!.data).toMatchObject({ failedRunId: "saved", bundleKey: "incident-saved" });
			expect(entryText(incidents[0]!)).toContain("INCIDENT (computed by the platform");
			expect(entryText(incidents[0]!)).not.toContain("(resubmitted)");
			await expect(submitSavedIncident(mapped, "missing", fixtures, context)).rejects.toThrow("missing saved incident");
		} finally { await harness.close(context); }
	});

	it("marks all stale tasks before an abort implicitly starts scheduling", async () => {
		const kv = memoryKvClient();
		let storage = await ApifyKvStorage.open(kv);
		const executed: string[] = [];
		const Task = defineTask<{ label: string }, { phase: "run" }, null>({ name: "test.side-effect", version: 1, initial: () => ({ phase: "run" as const }), phases: { run: async (task, api, ctx) => { executed.push(task.input.label); await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx); } }, abort: async (_task, api, ctx) => { await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test", tasks: [Task] }));
		let harness = await Harness.open(storage, { models: createModels(), registry }, context);
		try {
			const a = await harness.root(context);
			const b = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			const current = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			await a.commit((tx) => tx.createTask(Task, { label: "stale-a" }, { ownership: { kind: "conversation" } }), context);
			await b.commit((tx) => tx.createTask(Task, { label: "stale-b" }, { ownership: { kind: "conversation" } }), context);
			const currentTask = await current.commit((tx) => tx.createTask(Task, { label: "current" }, { ownership: { kind: "conversation" } }), context);
			const queue = (conversation: Conversation, requestId: string) => conversation.commit(async (tx) => {
				const submission = await tx.createSubmission({ conversationId: conversation.id, requestId, type: "input", status: "queued" });
				(await tx.doc(InboxDoc, conversation.id)).items.push({ id: submission.id, mode: "followUp", content: "queued human instruction" });
				return submission.id;
			}, context);
			const staleInput = await queue(b, "stale-input");
			const currentInput = await queue(current, "current-input");
			await harness.close(context);
			storage = await ApifyKvStorage.open(kv);
			const stale = await markStaleWork(storage, current.id, context);
			expect(stale).toEqual([a.id, b.id]);
			expect((await storage.task(currentTask, context))!.abortRequested).toBe(false);
			harness = await Harness.open(storage, { models: createModels(), registry }, context);
			await abandonMarkedWork(harness, stale, context, () => {});
			await harness.waitForIdle(context);
			expect(executed).toEqual(["current"]);
			expect((await storage.submission(staleInput, context))!.status).toBe("unanswered");
			expect((await storage.submission(currentInput, context))!.status).toBe("queued");
			expect((await harness.snapshot(InboxDoc, b.id, context))!.items).toHaveLength(0);
			expect((await harness.snapshot(InboxDoc, current.id, context))!.items).toHaveLength(1);
			expect((await harness.inspect(context)).tasks).toHaveLength(0);
		} finally { await harness.close(context); }
	});

	it("writes a source-labelled terminating handoff without platform calls", async () => {
		const push = vi.spyOn(Actor, "pushData").mockResolvedValue(undefined as never);
		vi.spyOn(Actor, "setValue").mockResolvedValue(undefined);
		vi.stubEnv("ACTOR_RUN_ID", "");
		try {
			const env: ToolEnv = { scraperActorId: "scraper", failedRunId: "incident", targetUrl: "https://example.test", fixtures: fixtureStore(), log() {}, budget: { maxToolCalls: 60, maxElapsedMs: 1, startedAt: Date.now(), toolCallsSoFar: async () => 0 } };
			const report = RepairExtension(env).tools!.find((tool) => tool.name === "write_report")!;
			const note = "Price decision: .value, all 20 products.\nRejected price alternative: .amount, old prices on 7.\nLayout b has cookie banner. Build fix-1 promoted, no unresolved work.";
			const incomplete = await report.execute({ whatChanged: "layout", whatWasDone: "selector fix", outcome: "promoted", promotedBuildId: "fix-1", handoffNote: "Missing the explicit price decision and rejection evidence." } as never, { snapshot: async () => undefined } as never, context);
			expect(incomplete.isError).toBe(true);
			expect(push).not.toHaveBeenCalled();
			const result = await report.execute({ whatChanged: "layout", whatWasDone: "selector fix", outcome: "promoted", promotedBuildId: "fix-1", handoffNote: note } as never, { snapshot: async () => undefined } as never, context);
			expect(push).toHaveBeenCalledOnce();
			expect(result.control).toEqual({ terminate: true, handoff: repairHandoff("incident", note) });
			expect(result.details).toEqual({ failedRunId: "incident", repairHandoff: repairHandoff("incident", note) });
		} finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
	});

	it("exposes no fixture mutation tools to repairs and keeps report replay unsafe", () => {
		const env: ToolEnv = { scraperActorId: "scraper", failedRunId: "incident", targetUrl: "https://example.test", fixtures: fixtureStore(), log() {}, budget: { maxToolCalls: 60, maxElapsedMs: 1, startedAt: 0, toolCallsSoFar: async () => 0 } };
		const extension = RepairExtension(env);
		expect(extension.tools?.map((tool) => tool.name)).not.toContain("snapshot_page");
		expect(extension.tools?.map((tool) => tool.name)).not.toContain("store_fixture");
		const report = extension.tools?.find((tool) => tool.name === "write_report");
		expect(report?.replay).not.toBe("safe");
		expect((report?.parameters as { required?: string[] }).required).toContain("handoffNote");
	});
});
