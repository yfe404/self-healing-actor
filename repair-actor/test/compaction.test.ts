import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Context as ModelContext, Message, Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, defineExtension, Harness, MemoryStorage, UsageDoc, type EntryDraft, type EntryRecord, type HookApi, type ModelRef } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import {
	ACTIVE_CONTEXT_TARGET,
	compactionHook,
	compactionPolicyFor,
	compactionSettings,
	CompactionUsageDoc,
	conversationCommit,
	createBeforeCompact,
	PRESERVATION_INSTRUCTIONS,
	serializeForSummary,
	SUMMARY_MAX_TOKENS,
	SUMMARY_PREFIX,
	SUMMARY_SUFFIX,
	verbatimBlock,
	type Summarize,
} from "../src/compaction.js";
import { MODELS } from "../src/models.js";

const context = BACKGROUND_CONTEXT;
const FIX = `${MODELS.fix.provider}/${MODELS.fix.modelId}`;
const usage = (input: number, output: number, total: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const answer = (text: string, stopReason: AssistantMessage["stopReason"] = "stop", spent = usage(1000, 200, 0.01)): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "openrouter",
	model: MODELS.fix.modelId,
	usage: spent,
	stopReason,
	timestamp: 1,
});
const say = (text: string): EntryDraft => ({ kind: "pi.assistant", model: [answer(text, "stop", usage(0, 0, 0))] });
const user = (kind: string, text: string): EntryDraft => ({ kind, model: [{ role: "user", content: text, timestamp: 0 }] });
const NOTE = "Build notes: price uses .price-tag (20/20). Rejected .amount: old prices on 7/20. Prod build x1nrd0s8qY8NVe6aK.";
const STEER = "the site also added a cookie banner, handle it";

function catalog() {
	const models = createModels();
	models.setProvider(openrouterProvider());
	return models;
}

describe("compaction policy", () => {
	it("sizes the fix model from the installed catalog: 1,000,000-token window, blocking at 120,000", () => {
		const models = catalog();
		expect(models.getModel(MODELS.fix.provider, MODELS.fix.modelId)?.contextWindow).toBe(1_000_000);
		expect(models.getModel(MODELS.narrate.provider, MODELS.narrate.modelId)?.contextWindow).toBe(200_000);
		const settings = compactionSettings(models, [MODELS.fix, MODELS.narrate, MODELS.build]);
		expect(settings.modelOverrides[FIX]).toEqual({ enabled: true, reserveTokens: 880_000, keepRecentTokens: 20_000, backgroundTokens: 32_768 });
		expect(settings.modelOverrides[`openrouter/${MODELS.narrate.modelId}`]).toEqual({ enabled: true, reserveTokens: 80_000, keepRecentTokens: 20_000, backgroundTokens: 32_768 });
		expect(settings).toMatchObject({ enabled: true, reserveTokens: 32_768, keepRecentTokens: 20_000, backgroundTokens: 32_768 });
		expect(() => compactionSettings(models, [{ provider: "openrouter", modelId: "no/such-model" }])).toThrow("not in the installed catalog");
	});

	it.each([
		[1_000_000, 880_000, 20_000, 32_768],
		[200_000, 80_000, 20_000, 32_768],
		[152_768, 32_768, 20_000, 32_768],
		[128_000, 32_768, 20_000, 31_744],
		[65_536, 32_768, 16_384, 10_922],
		[40_000, 20_000, 10_000, 6_666],
	])("window %i reserves %i, keeps %i, starts %i early", (window, reserve, keep, background) => {
		expect(compactionPolicyFor(window)).toEqual({ enabled: true, reserveTokens: reserve, keepRecentTokens: keep, backgroundTokens: background });
	});

	it("never blocks above 120,000 tokens and keeps every threshold inside the window", () => {
		for (const window of [8_000, 32_768, 65_535, 100_000, 152_767, 400_000, 2_000_000, 10_000_000]) {
			const policy = compactionPolicyFor(window);
			const blocking = window - policy.reserveTokens;
			expect(blocking).toBeLessThanOrEqual(ACTIVE_CONTEXT_TARGET);
			expect(blocking).toBeGreaterThan(0);
			expect(policy.reserveTokens).toBeGreaterThanOrEqual(Math.min(32_768, Math.floor(window / 2)));
			expect(policy.keepRecentTokens).toBeLessThan(blocking);
			expect(blocking - policy.backgroundTokens).toBeGreaterThan(0);
		}
		expect(() => compactionPolicyFor(0)).toThrow();
		expect(() => compactionPolicyFor(Number.NaN)).toThrow();
	});
});

describe("summary content", () => {
	it("serializes the transcript without thinking or system prompts and cuts long tool results", () => {
		const messages: Message[] = [
			{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
			{ role: "user", content: STEER, timestamp: 0 },
			{ ...answer("Chose .value."), content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "Chose .value." }, { type: "toolCall", id: "1", name: "build_scraper", arguments: {} }] },
			{ role: "toolResult", toolCallId: "1", toolName: "fetch_page", content: [{ type: "text", text: "x".repeat(5000) }], isError: false, timestamp: 0 },
		];
		const text = serializeForSummary(messages);
		expect(text).toContain(`[User]: ${STEER}`);
		expect(text).toContain("[Assistant]: Chose .value.");
		expect(text).toContain("[Assistant tool calls]: build_scraper({})");
		expect(text).toContain("[... 3000 more characters cut]");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("SYSTEM PROMPT");
	});

	it("copies the head note and every human message word for word, carries an earlier block forward, and stays bounded", () => {
		const entry = (id: number, draft: EntryDraft) => ({ ...draft, id, conversationId: 1 }) as EntryRecord;
		const first = verbatimBlock([entry(1, { ...user("pi.reset", NOTE), head: "self" }), entry(2, say("ok")), entry(3, user("apify.steer", STEER)), entry(4, user("apify.incident", "INCIDENT text"))]);
		expect(first).toContain(`[handoff note, entry #1]\n${NOTE}`);
		expect(first).toContain(`[human message, entry #3]\n${STEER}`);
		expect(first).not.toContain("INCIDENT text");
		const previous = entry(10, { kind: "pi.compaction", head: 5 as never, model: [{ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}${first}\n\nmodel part${SUMMARY_SUFFIX}` }], timestamp: 0 }] });
		const second = verbatimBlock([previous, entry(11, user("apify.steer", "second human message"))]);
		expect(second).toContain(NOTE);
		expect(second).toContain(STEER);
		expect(second).toContain("second human message");
		expect(second).not.toContain("model part");
		expect(second.match(/Copied word for word/g)).toHaveLength(1);
		const many = Array.from({ length: 50 }, (_, i) => entry(100 + i, user("apify.steer", `message ${i} ${"y".repeat(200)}`)));
		const bounded = verbatimBlock([entry(1, { ...user("pi.reset", NOTE), head: "self" }), ...many], 3000);
		expect(bounded.length).toBeLessThan(3500);
		expect(bounded).toContain(NOTE);
		expect(bounded).toContain("message 49");
		expect(bounded).toMatch(/older human messages left out to bound this block: entries #100, #101/);
		expect(verbatimBlock([entry(2, say("only the agent"))])).toBe("");
	});

	it("preserves human-message whitespace when copying and carrying the bounded block", () => {
		const human = "  Keep the exact spaces.\n\n";
		const entry = { id: 1, conversationId: 1, kind: "apify.steer", model: [{ role: "user", content: human, timestamp: 0 }] } as unknown as EntryRecord;
		const first = verbatimBlock([entry]);
		expect(first).toContain(`[human message, entry #1]\n${human}\n</verbatim-notes>`);
		const prior = { id: 2, conversationId: 1, kind: "pi.compaction", model: [{ role: "user", content: `${SUMMARY_PREFIX}${first}${SUMMARY_SUFFIX}`, timestamp: 0 }] } as unknown as EntryRecord;
		expect(verbatimBlock([prior])).toBe(first);
	});

	it("bounds carried notes and omission notices across repeated compactions", () => {
		let copied = "";
		for (let i = 0; i < 100; i++) {
			const entries = [
				...(copied ? [{ id: i * 2 + 1, conversationId: 1, kind: "pi.compaction", model: [{ role: "user", content: `${SUMMARY_PREFIX}${copied}${SUMMARY_SUFFIX}`, timestamp: 0 }] }] : []),
				{ id: i * 2 + 2, conversationId: 1, kind: "apify.steer", model: [{ role: "user", content: `human ${i}: ${"x".repeat(500)}`, timestamp: 0 }] },
			] as unknown as EntryRecord[];
			copied = verbatimBlock(entries, 3000);
			expect(copied.length).toBeLessThanOrEqual(3000);
		}
		expect(copied).toMatch(/left out|omitted/);
	});
});

/** A HookApi stand-in with an in-memory memo store that, like the real one, keeps the first value written. */
function fakeApi(conversationId: unknown, memos = new Map<string, unknown>()) {
	const models = catalog();
	return {
		memos,
		api: {
			taskId: 77,
			conversationId,
			models,
			memo: async (name: string, ...rest: unknown[]) => {
				if (rest.length === 1) return memos.get(name);
				if (!memos.has(name)) memos.set(name, rest[0]);
				return memos.get(name);
			},
		} as unknown as HookApi,
	};
}

async function openHarness(extension?: ReturnType<typeof defineExtension>, settings: object = {}) {
	const registry = createRegistry();
	if (extension) registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models: catalog(), registry, settings }, context);
	const root = await harness.root(context, { agent: { model: MODELS.fix } });
	return { harness, root };
}

function compactionInput(entries: EntryRecord[]) {
	return { reason: "threshold" as const, entries, messages: entries.flatMap((entry) => [...(entry.model ?? [])]), firstKept: 99 as never };
}

describe("beforeCompact hook", () => {
	it("asks for verbatim decisions, rejected alternatives, build ids, and human messages, and bounds the output", async () => {
		const { harness, root } = await openHarness();
		try {
			const entries = await root.commit(async (tx) => [
				await tx.appendEntry(root.id, { ...user("pi.reset", NOTE), head: "self" }),
				await tx.appendEntry(root.id, user("apify.steer", STEER)),
				await tx.appendEntry(root.id, say("Chose .value; rejected .amount again. Candidate build cand0001.")),
			], context);
			const requests: { request: ModelContext; maxTokens?: number }[] = [];
			const summarize: Summarize = async (_model, request, options) => {
				requests.push({ request, maxTokens: options.maxTokens });
				return answer("## Selector decisions\nprice .value");
			};
			const hookFn = createBeforeCompact({ model: MODELS.fix, commit: conversationCommit((id, c) => harness.conversation(id, c)), summarize, maxSummaryTokens: 1_000_000 });
			const result = await hookFn(compactionInput(entries), fakeApi(root.id).api, context);
			const prompt = JSON.stringify(requests[0]!.request);
			for (const rule of ["VERBATIM every selector decision", "VERBATIM every rejected alternative", "every build id", "VERBATIM every message from a human", "## Rejected alternatives"]) expect(prompt).toContain(rule);
			expect(requests[0]!.request.messages[0]!.content).toContain(PRESERVATION_INSTRUCTIONS);
			expect(prompt).toContain("Candidate build cand0001");
			expect(requests[0]!.maxTokens).toBe(SUMMARY_MAX_TOKENS);
			expect(result).toEqual({ summary: expect.stringContaining(NOTE) });
			const summary = (result as { summary: string }).summary;
			expect(summary).toContain(STEER);
			expect(summary.endsWith("## Selector decisions\nprice .value")).toBe(true);
		} finally {
			await harness.close(context);
		}
	});

	it("records summary spend in pi.usage exactly once, even when the step is repeated", async () => {
		const { harness, root } = await openHarness();
		try {
			const entries = await root.commit(async (tx) => [await tx.appendEntry(root.id, say("Chose .value."))], context);
			const summarize = vi.fn<Summarize>(async () => answer("summary", "stop", usage(1000, 200, 0.25)));
			const hookFn = createBeforeCompact({ model: MODELS.fix, commit: conversationCommit((id, c) => harness.conversation(id, c)), summarize });
			const { api, memos } = fakeApi(root.id);
			const first = await hookFn(compactionInput(entries), api, context);
			// A crash after the memo was saved repeats the step: same memo, same marker, no second request or charge.
			const again = await hookFn(compactionInput(entries), fakeApi(root.id, memos).api, context);
			expect(again).toEqual(first);
			expect(summarize).toHaveBeenCalledOnce();
			const spent = (await harness.snapshot(UsageDoc, root.id, context))!.models[FIX]!;
			expect(spent).toMatchObject({ input: 1000, output: 200, totalTokens: 1200, cost: { total: 0.25 } });
			expect((await harness.snapshot(CompactionUsageDoc, root.id, context))!.recorded).toEqual([`77:99`]);
			expect((await harness.usage(context)).models[FIX]!.totalTokens).toBe(1200);
		} finally {
			await harness.close(context);
		}
	});

	it("declines on an incomplete, failed, or missing summary and records the failed attempt's spend; rethrows an abort", async () => {
		const { harness, root } = await openHarness();
		try {
			const entries = await root.commit(async (tx) => [await tx.appendEntry(root.id, say("Chose .value."))], context);
			const lines: string[] = [];
			const make = (summarize: Summarize, model: ModelRef = MODELS.fix) => createBeforeCompact({ model, commit: conversationCommit((id, c) => harness.conversation(id, c)), summarize, log: (line) => lines.push(line) });
			expect(await make(async () => answer("cut off", "length", usage(500, 8192, 0.5)))(compactionInput(entries), fakeApi(root.id).api, context)).toEqual({ decline: true });
			expect(await make(async () => ({ ...answer(""), content: [{ type: "toolCall", id: "x", name: "fetch_page", arguments: {} }] }))(compactionInput(entries), fakeApi(root.id).api, context)).toEqual({ decline: true });
			expect(await make(async () => { throw new Error("network down"); })(compactionInput(entries), fakeApi(root.id).api, context)).toEqual({ decline: true });
			expect(await make(async () => answer("x"), { provider: "openrouter", modelId: "no/such" })(compactionInput(entries), fakeApi(root.id).api, context)).toEqual({ decline: true });
			expect(lines.filter((line) => line.startsWith("compaction declined"))).toHaveLength(4);
			expect(lines.join("\n")).toContain("network down");
			// The two answered attempts still cost tokens, so their usage counts.
			expect((await harness.snapshot(UsageDoc, root.id, context))!.models[FIX]).toMatchObject({ input: 1500, output: 8392 });
			const controller = new AbortController();
			const aborted = make(async () => { controller.abort(); throw new Error("aborted"); });
			await expect(aborted(compactionInput(entries), fakeApi(root.id).api, { ...context, abortSignal: controller.signal })).rejects.toThrow();
		} finally {
			await harness.close(context);
		}
	});

	it("places the summary as the new context head through a real compaction, keeping the originals stored", async () => {
		let harnessRef: Harness | undefined;
		const summarize = vi.fn<Summarize>(async () => answer("## Selector decisions\nprice .value (all 20 items)"));
		const extension = defineExtension({ name: "test-compaction", hooks: [compactionHook({ model: MODELS.fix, commit: conversationCommit((id, c) => harnessRef!.conversation(id, c)), summarize })] });
		const { harness, root } = await openHarness(extension, { compaction: { keepRecentTokens: 40 } });
		harnessRef = harness;
		try {
			const appended = await root.commit(async (tx) => {
				const out = [await tx.appendEntry(root.id, { ...user("pi.reset", NOTE), head: "self" }), await tx.appendEntry(root.id, user("apify.steer", STEER))];
				for (let i = 0; i < 12; i++) out.push(await tx.appendEntry(root.id, say(`Step ${i}: investigated the price selector and the cookie banner in detail.`)));
				return out;
			}, context);
			const taskId = await root.compact(undefined, context);
			const settled = await harness.waitForTask(taskId, context);
			expect(settled.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
			await harness.waitForIdle(context);
			const view = await root.context(context);
			expect(view.head?.kind).toBe("pi.compaction");
			const text = (view.head!.model![0]!.content as { text: string }[])[0]!.text;
			expect(text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)).toBe(true);
			expect(text).toContain(NOTE);
			expect(text).toContain(STEER);
			expect(text).toContain("price .value (all 20 items)");
			expect(view.entries.map((entry) => entry.id)).not.toContain(appended[0]!.id);
			const stored = (await root.entries({}, 100, undefined, context)).items.map((entry) => entry.id);
			for (const entry of appended) expect(stored).toContain(entry.id);
			expect(summarize).toHaveBeenCalledOnce();
			expect((await harness.snapshot(UsageDoc, root.id, context))!.models[FIX]).toMatchObject({ input: 1000, output: 200 });
		} finally {
			await harness.close(context);
		}
	});
});
