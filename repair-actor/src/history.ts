// `recall_history` lets the agent search everything it has decided before, across the fork chain:
// the build session, every earlier repair, and parts of this repair that compaction or a handoff hid from the model.
// It reads `Conversation.entries()`, which returns this conversation's entries and its ancestors' entries up to each
// fork point, and never a sibling investigation. It makes no model call. See D20 in DECISIONS.md.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { loadRanker } from "./durable-internals.js";

/** Returns a full Conversation handle. A tool's own `api.conversation()` handle has no `entries()`. */
export type GetConversation = (id: ConversationId, context: Context) => Promise<Pick<Conversation, "id" | "entries"> | undefined>;

/** One searchable entry: assistant text and tool calls, a handoff note, or a compaction summary. */
export type HistoryDoc = {
	id: EntryId;
	conversationId: ConversationId;
	/** `assistant`, `handoff` (a `pi.reset` note), or `summary` (a `pi.compaction` summary). */
	source: "assistant" | "handoff" | "summary";
	text: string;
};

export type SearchHit = { id: EntryId; conversationId: ConversationId; source: HistoryDoc["source"]; excerpt: string };

export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;
export const EXCERPT_CHARS = 300;
/** Entries per `entries()` page. Every page is read; this only sets the size of each read. */
export const HISTORY_PAGE_SIZE = 200;
/** One fetched chunk stays under this many UTF-8 bytes, well below the tool's output limit, so nothing is cut silently. */
export const FETCH_MAX_BYTES = 48 * 1024;
export const RECALL_OUTPUT_LIMITS = { maxBytes: 64 * 1024, maxLines: 100_000 } as const;

const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** The searchable text of an entry, or undefined for entries recall leaves out (tool results, system, thinking, and others). */
export function historyDoc(entry: EntryRecord): HistoryDoc | undefined {
	const base = { id: entry.id, conversationId: entry.conversationId };
	if (entry.kind === "pi.assistant") {
		const parts: string[] = [];
		for (const message of entry.model ?? []) {
			if (message.role !== "assistant") continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") parts.push(`[answer cut off: ${message.stopReason}]`);
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) parts.push(block.text);
				// Thinking blocks are left out on purpose: providers return summaries of the real reasoning.
				if (block.type === "toolCall") parts.push(`tool call ${block.name} ${JSON.stringify(block.arguments, null, 2)}`);
			}
		}
		return parts.length ? { ...base, source: "assistant", text: parts.join("\n") } : undefined;
	}
	if (entry.kind === "pi.reset") {
		// A plain reset carries no note.
		const text = (entry.model ?? []).map((message) => textOf(message.content)).join("\n").trim();
		return text ? { ...base, source: "handoff", text } : undefined;
	}
	if (entry.kind === "pi.compaction") {
		let text = (entry.model ?? []).map((message) => textOf(message.content)).join("\n");
		if (text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)) text = text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length);
		return text.trim() ? { ...base, source: "summary", text } : undefined;
	}
	return undefined;
}

/** Every searchable entry visible from this conversation, newest first. Reads pages until the history ends. */
export async function collectHistory(conversation: Pick<Conversation, "entries">, context: Context, pageSize = HISTORY_PAGE_SIZE): Promise<HistoryDoc[]> {
	const docs: HistoryDoc[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, pageSize, cursor, context);
		for (const entry of page.items) {
			const doc = historyDoc(entry);
			if (doc) docs.push(doc);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return docs;
}

/** About `EXCERPT_CHARS` around the first word that matches a query term, on one line. */
export function excerpt(text: string, queryTerms: ReadonlySet<string>, tokenize: (text: string) => string[], size = EXCERPT_CHARS): string {
	let at = 0;
	for (const word of text.matchAll(/[A-Za-z0-9]+/g)) {
		if (tokenize(word[0]).some((term) => queryTerms.has(term))) {
			at = word.index ?? 0;
			break;
		}
	}
	const start = Math.max(0, Math.min(at - Math.floor(size / 3), text.length - size));
	const slice = text.slice(start, start + size).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${slice}${start + size < text.length ? "…" : ""}`;
}

/**
 * Rank documents with the package's BM25 ranker. Only documents sharing a query term are returned.
 * Equal scores keep document order, which is newest first from `collectHistory`.
 */
export async function searchHistory(docs: readonly HistoryDoc[], query: string, limit = SEARCH_DEFAULT_LIMIT): Promise<SearchHit[]> {
	const { rankDocuments, tokenize } = await loadRanker();
	const bounded = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
	const byName = new Map(docs.map((doc) => [String(doc.id), doc]));
	const terms = new Set(tokenize(query));
	return rankDocuments(query, docs.map((doc) => ({ name: String(doc.id), text: doc.text })), bounded).flatMap((name) => {
		const doc = byName.get(name);
		return doc ? [{ id: doc.id, conversationId: doc.conversationId, source: doc.source, excerpt: excerpt(doc.text, terms, tokenize) }] : [];
	});
}

export type FetchedChunk = {
	id: EntryId;
	conversationId: ConversationId;
	source: HistoryDoc["source"];
	/** Characters `offset` up to `end` of the entry's text. */
	text: string;
	offset: number;
	end: number;
	totalChars: number;
	/** Present when more of the entry remains. Fetch again with this offset. */
	nextOffset?: number;
};

/** Largest chunk from `offset` whose UTF-8 size fits `maxBytes`, never splitting a surrogate pair. */
export function chunkEnd(text: string, offset: number, maxBytes = FETCH_MAX_BYTES): number {
	let end = Math.min(text.length, offset + maxBytes);
	while (end > offset && Buffer.byteLength(text.slice(offset, end), "utf8") > maxBytes) end = offset + Math.floor((end - offset) * 0.75);
	const last = text.charCodeAt(end - 1);
	if (end < text.length && end - 1 > offset && last >= 0xd800 && last <= 0xdbff) end--;
	// Always make progress, even with a tiny limit.
	return Math.max(end, Math.min(text.length, offset + 1));
}

/**
 * One searchable entry by id, in chunks. Throws if the entry is not visible from this conversation (a sibling
 * investigation, a later part of an ancestor, or an unknown id) or is a kind recall does not return.
 */
export async function fetchHistoryEntry(conversation: Pick<Conversation, "entries">, entryId: number, offset: number, context: Context, maxBytes = FETCH_MAX_BYTES): Promise<FetchedChunk> {
	if (!Number.isSafeInteger(entryId) || entryId < 0) throw new Error(`entry id ${entryId} is not a valid id`);
	const id = entryId as EntryId;
	// The fork-aware scan only returns entries this conversation can see, so it doubles as the ancestry check.
	const entry = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
	if (!entry) throw new Error(`entry #${entryId} is not part of this investigation's history`);
	const doc = historyDoc(entry);
	if (!doc) throw new Error(`entry #${entryId} is a ${entry.kind} entry; recall only returns assistant messages, handoff notes, and summaries`);
	if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= doc.text.length)) throw new Error(`offset ${offset} is outside entry #${entryId}, which has ${doc.text.length} characters`);
	const end = chunkEnd(doc.text, offset, maxBytes);
	return { id: doc.id, conversationId: doc.conversationId, source: doc.source, text: doc.text.slice(offset, end), offset, end, totalChars: doc.text.length, ...(end < doc.text.length ? { nextOffset: end } : {}) };
}

export function formatHits(query: string, hits: readonly SearchHit[], searched: number): string {
	if (!hits.length) return `No saved entry matches "${query}" (${searched} entries searched). Try other words, such as a class name or a tool name.`;
	return [
		`${hits.length} best matches for "${query}" among ${searched} saved entries. Fetch one in full with recall_history({ entryId }).`,
		...hits.map((hit) => `#${String(hit.id)} (${hit.source}, conversation #${String(hit.conversationId)}): ${hit.excerpt}`),
	].join("\n");
}

export function formatChunk(chunk: FetchedChunk): string {
	const range = chunk.offset === 0 && chunk.nextOffset === undefined ? `${chunk.totalChars} characters, complete` : `characters ${chunk.offset} to ${chunk.end} of ${chunk.totalChars}`;
	const more = chunk.nextOffset === undefined ? "" : `\n[more follows: call recall_history({ entryId: ${String(chunk.id)}, offset: ${chunk.nextOffset} })]`;
	return `entry #${String(chunk.id)} (${chunk.source}, conversation #${String(chunk.conversationId)}, ${range})\n${chunk.text}${more}`;
}

/** The `recall_history` tool. Register it in the repair extension; `getConversation` is usually `harness.conversation`. */
export function recallHistoryTool(getConversation: GetConversation) {
	return defineTool({
		name: "recall_history",
		description:
			"Search your own saved history: the build session, every earlier repair, and parts of this investigation you can no longer see. It covers your messages, your tool calls with their arguments, handoff notes, and summaries, not tool results. Give `query` (words such as a class name, field, or build id) to get the best few matches with entry ids and short excerpts. Give `entryId` to read that entry in full; long entries come in parts, so repeat with the `offset` it gives you.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words to search for, for example 'price selector amount rejected'" })),
			entryId: Type.Optional(Type.Number({ description: "Read this entry in full instead of searching" })),
			offset: Type.Optional(Type.Number({ description: "With entryId: where to continue a long entry" })),
			limit: Type.Optional(Type.Number({ description: `With query: how many matches, 1 to ${SEARCH_MAX_LIMIT} (default ${SEARCH_DEFAULT_LIMIT})` })),
		}),
		replay: "safe",
		outputLimits: RECALL_OUTPUT_LIMITS,
		execute: async (args, api, context) => {
			const text = (value: string) => [{ type: "text" as const, text: value }];
			try {
				const conversation = await getConversation(api.conversationId, context);
				if (!conversation) throw new Error(`conversation #${String(api.conversationId)} was not found`);
				if (args.entryId !== undefined) return { output: text(formatChunk(await fetchHistoryEntry(conversation, args.entryId, args.offset ?? 0, context))) };
				const query = args.query?.trim();
				if (!query) throw new Error("give a query to search, or an entryId to read one entry");
				const docs = await collectHistory(conversation, context);
				return { output: text(formatHits(query, await searchHistory(docs, query, args.limit ?? SEARCH_DEFAULT_LIMIT), docs.length)) };
			} catch (error) {
				return { isError: true, output: text(error instanceof Error ? error.message : String(error)) };
			}
		},
	});
}
