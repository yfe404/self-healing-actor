import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type Conversation, type EntryDraft, type EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { loadRanker, rankerUrl } from "../src/durable-internals.js";
import {
	chunkEnd,
	collectHistory,
	FETCH_MAX_BYTES,
	fetchHistoryEntry,
	formatHits,
	historyDoc,
	recallHistoryTool,
	RECALL_OUTPUT_LIMITS,
	SEARCH_MAX_LIMIT,
	searchHistory,
} from "../src/history.js";

const context = BACKGROUND_CONTEXT;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): EntryDraft => ({
	kind: "pi.assistant",
	model: [{ role: "assistant", content, api: "anthropic-messages", provider: "openrouter", model: "anthropic/claude-sonnet-4.5", usage, stopReason, timestamp: 0 }],
});
const say = (text: string) => assistant([{ type: "text", text }], "stop");
const note = (text: string): EntryDraft => ({ kind: "pi.reset", head: "self", model: [{ role: "user", content: text, timestamp: 0 }] });
const append = (conversation: Conversation, drafts: readonly EntryDraft[]) =>
	conversation.commit(async (tx) => {
		const out: EntryRecord[] = [];
		for (const draft of drafts) out.push(await tx.appendEntry(conversation.id, draft));
		return out;
	}, context);
const fork = (conversation: Conversation, at: EntryRecord) => conversation.fork(at.id, { ownership: { kind: "ownerless" } }, context);

/**
 * build (root) -> repair A (fork at the build note) -> repair C (fork at A's note)
 *              -> repair B (sibling of A, also forked at the build note)
 * A writes more after C was forked; C must not see that either.
 */
async function chain() {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	const root = await harness.root(context);
	const [buildChoice, buildCall, buildResult, buildSystem, buildThinking, buildNote] = await append(root, [
		say("Chose .price-tag for price: it is on 20 of 20 products. Rejected .amount: it appears on only 7 of 20 products, as a struck-through old price."),
		assistant([{ type: "toolCall", id: "c1", name: "write_scraper_file", arguments: { name: "selectors.js", content: "price: '.price-tag'" } }]),
		{ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "fetch_page", content: [{ type: "text", text: "amount amount amount <span class=amount>" }], isError: false, timestamp: 0 }] },
		{ kind: "pi.system", model: [{ role: "system", content: "amount rules for the system prompt", timestamp: 0 }] },
		assistant([{ type: "thinking", thinking: "secret thinking about amount" }, { type: "text", text: "Building now." }], "stop"),
		note("Build notes: price uses .price-tag (20/20). Rejected .amount, old prices on 7/20. Prod build x1nrd0s8qY8NVe6aK."),
	]);
	const a = await fork(root, buildNote!);
	const [aChoice, aSummary, aNote] = await append(a, [
		say("Incident: .price-tag is gone. New class product-price on all 20 items; .value inside it. Choosing .value."),
		{ kind: "pi.compaction", head: buildNote!.id, data: { reason: "threshold" }, model: [{ role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nSelector decisions: .value for price. Candidate build cand0001.\n</summary>" }], timestamp: 0 }] },
		note("REPAIR HANDOFF\nSource incident: failed-1\n\nprice now .value; .amount still rejected; promoted build cand0001."),
	]);
	const c = await fork(a, aNote!);
	const [cChoice] = await append(c, [say("Second incident: checking .value again.")]);
	const [aLater] = await append(a, [say("A later message in repair A about cookie-banner-after-fork.")]);
	const b = await fork(root, buildNote!);
	const [bSecret] = await append(b, [say("Sibling investigation chose .bogus-sibling-selector.")]);
	return { harness, root, a, b, c, ids: { buildChoice, buildCall, buildResult, buildSystem, buildThinking, buildNote, aChoice, aSummary, aNote, cChoice, aLater, bSecret } };
}

describe("recall_history", () => {
	it("uses the ranker shipped in the installed pi-durable package", async () => {
		expect(rankerUrl().pathname).toMatch(/node_modules\/@earendil-works\/pi-durable\/dist\/search\.js$/);
		const ranker = await loadRanker();
		expect(ranker.tokenize("priceTag amounts")).toEqual(["price", "tag", "amount"]);
	});

	it("keeps assistant text, tool calls with arguments, handoff notes, and summaries; drops everything else", async () => {
		const { harness, c, ids } = await chain();
		try {
			const docs = await collectHistory(c, context);
			const byId = new Map(docs.map((doc) => [doc.id, doc]));
			expect(docs.map((doc) => doc.id)).toEqual([ids.cChoice, ids.aNote, ids.aSummary, ids.aChoice, ids.buildNote, ids.buildThinking, ids.buildCall, ids.buildChoice].map((entry) => entry!.id));
			expect(byId.get(ids.buildCall!.id)).toMatchObject({ source: "assistant", conversationId: ids.buildCall!.conversationId });
			expect(byId.get(ids.buildCall!.id)!.text).toContain("tool call write_scraper_file");
			expect(byId.get(ids.buildCall!.id)!.text).toContain("price: '.price-tag'");
			expect(byId.get(ids.buildThinking!.id)!.text).toBe("Building now.");
			expect(byId.get(ids.buildNote!.id)!.source).toBe("handoff");
			expect(byId.get(ids.aSummary!.id)).toMatchObject({ source: "summary", text: "Selector decisions: .value for price. Candidate build cand0001." });
			for (const left of [ids.buildResult, ids.buildSystem, ids.aLater, ids.bSecret]) expect(byId.has(left!.id)).toBe(false);
			expect(historyDoc({ id: 1 as never, conversationId: 1 as never, kind: "pi.reset", head: 1 as never })).toBeUndefined();
			expect(historyDoc({ id: 1 as never, conversationId: 1 as never, kind: "apify.steer", model: [{ role: "user", content: "hi", timestamp: 0 }] })).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("finds ancestral decisions the model can no longer see, best match first, with short excerpts", async () => {
		const { harness, c, ids } = await chain();
		try {
			const visible = JSON.stringify((await c.context(context)).messages);
			expect(visible).not.toContain("struck-through");
			const docs = await collectHistory(c, context);
			// Every entry mentioning the rejected class is found, across the build, repair A, and this repair.
			const broad = (await searchHistory(docs, "why was amount rejected")).map((hit) => hit.id);
			expect(broad).toEqual(expect.arrayContaining([ids.buildChoice!.id, ids.buildNote!.id, ids.aNote!.id]));
			const hits = await searchHistory(docs, "amount struck through");
			expect(hits[0]).toMatchObject({ id: ids.buildChoice!.id, conversationId: ids.buildChoice!.conversationId, source: "assistant" });
			expect(hits[0]!.excerpt).toContain("Rejected .amount");
			expect(hits.every((hit) => hit.excerpt.length <= 302)).toBe(true);
			expect(hits.map((hit) => hit.id)).not.toContain(ids.buildResult!.id);
			expect(hits.map((hit) => hit.id)).not.toContain(ids.buildThinking!.id);
		} finally {
			await harness.close(context);
		}
	});

	it("bounds the result count, keeps newest first on ties, and reports no match", async () => {
		const docs = Array.from({ length: 30 }, (_, i) => ({ id: (100 - i) as never, conversationId: 1 as never, source: "assistant" as const, text: "same words about selectors" }));
		const hits = await searchHistory(docs, "selectors", 50);
		expect(hits).toHaveLength(SEARCH_MAX_LIMIT);
		expect(hits.map((hit) => hit.id)).toEqual(docs.slice(0, SEARCH_MAX_LIMIT).map((doc) => doc.id));
		expect(await searchHistory(docs, "selectors", 0)).toHaveLength(1);
		expect(await searchHistory(docs, "zzzz unmatched")).toEqual([]);
		expect(await searchHistory(docs, "the and of")).toEqual([]);
		expect(formatHits("zzzz", [], 30)).toContain("No saved entry matches \"zzzz\" (30 entries searched)");
	});

	it("reads every page of history, with no cap on the number of entries", async () => {
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
		try {
			const root = await harness.root(context);
			const [first] = await append(root, [say("needle-oldest decision")]);
			await append(root, Array.from({ length: 450 }, (_, i) => say(`filler ${i}`)));
			const child = await fork(root, (await root.entries({}, 1, undefined, context)).items[0]!);
			await append(child, Array.from({ length: 30 }, (_, i) => say(`child ${i}`)));
			const spy = vi.spyOn(child, "entries");
			const docs = await collectHistory(child, context, 7);
			expect(docs).toHaveLength(481);
			expect(spy.mock.calls.length).toBe(Math.ceil(481 / 7));
			expect((await searchHistory(docs, "needle oldest"))[0]!.id).toBe(first!.id);
		} finally {
			await harness.close(context);
		}
	});

	it("fetches one entry in full and refuses siblings, later ancestor entries, unknown ids, and excluded kinds", async () => {
		const { harness, c, ids } = await chain();
		try {
			const own = await fetchHistoryEntry(c, ids.buildChoice!.id, 0, context);
			expect(own).toMatchObject({ id: ids.buildChoice!.id, source: "assistant", offset: 0, totalChars: own.text.length });
			expect(own.nextOffset).toBeUndefined();
			await expect(fetchHistoryEntry(c, ids.bSecret!.id, 0, context)).rejects.toThrow("not part of this investigation's history");
			await expect(fetchHistoryEntry(c, ids.aLater!.id, 0, context)).rejects.toThrow("not part of this investigation's history");
			await expect(fetchHistoryEntry(c, 999_999, 0, context)).rejects.toThrow("not part of this investigation's history");
			await expect(fetchHistoryEntry(c, ids.buildResult!.id, 0, context)).rejects.toThrow("pi.tool-result entry");
			await expect(fetchHistoryEntry(c, ids.buildChoice!.id, 10_000, context)).rejects.toThrow("outside entry");
		} finally {
			await harness.close(context);
		}
	});

	it("returns a long entry in parts that fit the tool output limit and add up to the whole text", async () => {
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
		try {
			const root = await harness.root(context);
			const long = `${"é🙂 selectors.js line\n".repeat(9_000)}END`;
			const [entry] = await append(root, [say(long)]);
			let text = "";
			let offset: number | undefined = 0;
			let parts = 0;
			while (offset !== undefined) {
				const chunk = await fetchHistoryEntry(root, entry!.id, offset, context);
				expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(FETCH_MAX_BYTES);
				expect(chunk.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
				text += chunk.text;
				offset = chunk.nextOffset;
				parts++;
			}
			expect(text).toBe(long);
			expect(parts).toBeGreaterThan(1);
			expect(FETCH_MAX_BYTES + 1024).toBeLessThan(RECALL_OUTPUT_LIMITS.maxBytes);
			expect(chunkEnd("abc", 0, 1)).toBe(1);
		} finally {
			await harness.close(context);
		}
	});

	it("works as a replay-safe tool through an injected full conversation lookup", async () => {
		const { harness, c, ids } = await chain();
		try {
			const tool = recallHistoryTool((id, ctx) => harness.conversation(id, ctx));
			expect(tool.replay).toBe("safe");
			expect(tool.outputLimits).toEqual(RECALL_OUTPUT_LIMITS);
			const api = { conversationId: c.id } as never;
			const run = async (args: object) => {
				const result = await tool.execute(args as never, api, context);
				return { isError: result.isError ?? false, text: (result.output as { text: string }[])[0]!.text };
			};
			const search = await run({ query: "amount rejected", limit: 2 });
			expect(search.isError).toBe(false);
			expect(search.text).toContain(`#${String(ids.buildChoice!.id)} (assistant, conversation #${String(ids.buildChoice!.conversationId)})`);
			const fetched = await run({ entryId: ids.aNote!.id });
			expect(fetched.text).toContain("Source incident: failed-1");
			expect(fetched.text).toContain("complete");
			expect(await run({ entryId: ids.bSecret!.id })).toMatchObject({ isError: true });
			expect(await run({})).toMatchObject({ isError: true, text: "give a query to search, or an entryId to read one entry" });
		} finally {
			await harness.close(context);
		}
	});
});
