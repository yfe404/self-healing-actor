// Bounded context for long investigations. See D19 in DECISIONS.md.
// Compaction replaces older entries the model sees with a summary; the original entries stay in storage.
// 1. `compactionSettings` targets blocking compaction at or below 120,000 tokens per model. Failed summaries
//    are declined, not replaced by an uninstructed fallback, so estimates and failures can exceed that target.
// 2. `compactionHook` writes the summary itself. Pi Durable 1.4.0 lets a `beforeCompact` hook decline or supply a
//    finished summary, but not add instructions to the built-in summarizer. So this hook makes its own model request
//    with preservation instructions, and copies the handoff note and every human message word for word in code.
// 3. The hook's model spend goes into `pi.usage` once per summary, guarded by a saved marker in the same commit.
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import type { Api, AssistantMessage, Context as ModelContext, Message, Model, Models, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import {
	CompactionTask,
	defineDoc,
	hook,
	UsageDoc,
	type CompactionHooks,
	type CompactionPolicy,
	type CompactionSettings,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type HookApi,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";

/** The largest active context, in tokens, at which the next request waits for a compaction. */
export const ACTIVE_CONTEXT_TARGET = 120_000;
/** Room kept free for the model's answer, where the window allows it. */
export const MIN_RESERVE_TOKENS = 32_768;
/** Roughly how much recent context stays verbatim after a compaction. */
export const KEEP_RECENT_TOKENS = 20_000;
/** How far below the blocking threshold a compaction starts in the background. */
export const BACKGROUND_TOKENS = 32_768;
/** Output limit of one summary request. The package's own summarizer would use 80% of the reserve, up to 64,000. */
export const SUMMARY_MAX_TOKENS = 8_192;
/** Characters of tool output the summarizer sees per result, like the package's summarizer. */
export const TOOL_RESULT_MAX_CHARS = 2_000;
/** Upper size of the block of notes and human messages copied word for word. */
export const VERBATIM_MAX_CHARS = 30_000;

/**
 * Thresholds for one context window. Large windows reserve `window - 120000`, so compaction blocks at 120,000
 * tokens and starts in the background 32,768 tokens earlier. Smaller windows keep at least 32,768 tokens free and
 * block earlier. Windows under 65,536 tokens keep half free. Keep and background shrink so both stay below the
 * blocking threshold.
 */
export function compactionPolicyFor(contextWindow: number): CompactionPolicy {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new Error(`context window ${contextWindow} is not a positive number of tokens`);
	const window = Math.floor(contextWindow);
	const reserveTokens = window >= 2 * MIN_RESERVE_TOKENS ? Math.max(MIN_RESERVE_TOKENS, window - ACTIVE_CONTEXT_TARGET) : Math.floor(window / 2);
	const blocking = window - reserveTokens;
	return {
		enabled: true,
		reserveTokens,
		keepRecentTokens: Math.min(KEEP_RECENT_TOKENS, Math.floor(blocking / 2)),
		backgroundTokens: Math.min(BACKGROUND_TOKENS, Math.floor(blocking / 3)),
	};
}

/**
 * `settings.compaction` with an exact `provider/modelId` override for each given model, from its catalog window.
 * Throws if a model is missing from the catalog, because an unknown window would leave context unbounded.
 * Models not listed fall back to the harness-wide values, which reserve 32,768 tokens of their own window.
 */
export function compactionSettings(models: Pick<Models, "getModel">, refs: readonly ModelRef[]): CompactionSettings & { modelOverrides: Record<string, CompactionPolicy> } {
	const modelOverrides: Record<string, CompactionPolicy> = {};
	for (const ref of refs) {
		const model = models.getModel(ref.provider, ref.modelId);
		if (!model) throw new Error(`model ${ref.provider}/${ref.modelId} is not in the installed catalog; cannot size its compaction`);
		modelOverrides[`${ref.provider}/${ref.modelId}`] = compactionPolicyFor(model.contextWindow);
	}
	return { enabled: true, reserveTokens: MIN_RESERVE_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS, backgroundTokens: BACKGROUND_TOKENS, modelOverrides };
}

export const SUMMARY_SYSTEM_PROMPT =
	"You summarize the working history of an agent that builds and repairs a web scraper. Do NOT continue the conversation and do NOT answer questions in it. Output only the summary in the requested format.";

export const PRESERVATION_INSTRUCTIONS = `Write a checkpoint summary that the same agent will use to continue its work. If the history starts with an earlier summary or handoff note, keep everything it says and fold the newer messages into it.

These rules come first:
1. Copy VERBATIM every selector decision: the field, the exact selector, and the evidence for it (such as match counts).
2. Copy VERBATIM every rejected alternative: the exact selector or class name and the reason it was rejected.
3. List every build id, build number, run id, and failed run id that appears, and say what each one is (candidate build, promoted build, canary run, failed run).
4. Copy VERBATIM every message from a human, word for word. Messages from a human are [User] lines that are not an incident or a handoff note.
5. Give the current content of selectors.js if it was written, and the latest test results (verdict, fill rates, item counts).
6. Say what is still open.
Never paraphrase a selector, class name, or id. If something is uncertain, say that it is uncertain instead of guessing.

Use exactly these headings:
## Selector decisions
## Rejected alternatives
## Builds and runs
## Human messages
## Current state
## Open work`;

/** How the package wraps a summary in the stored `pi.compaction` entry. */
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const SUMMARY_SUFFIX = "\n</summary>";
const VERBATIM_OPEN = "<verbatim-notes>";
const VERBATIM_CLOSE = "</verbatim-notes>";
const VERBATIM_HEADER = "Copied word for word by code from the entries this summary replaces. Originals stay stored; recall_history retrieves eligible decisions, notes, and summaries, not individual human messages.";
/** Entry kinds written by a person. `apify.steer` comes from the agent web page; `pi.user` is a plain user input. */
export const HUMAN_ENTRY_KINDS: readonly string[] = ["apify.steer", "pi.user"];

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function entryText(entry: EntryRecord): string {
	return (entry.model ?? []).map((message) => contentText(message.content)).join("\n");
}

/** Messages as a plain transcript, so the summarizer reads it instead of continuing it. Thinking and system prompts are left out. */
export function serializeForSummary(messages: readonly Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text) parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : []));
			if (text) parts.push(`[Assistant]: ${text}`);
			if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = contentText(message.content);
			const cut = text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters cut]` : text;
			if (cut) parts.push(`[Tool result ${message.toolName}]: ${cut}`);
		}
	}
	return parts.join("\n\n");
}

/**
 * The block copied word for word: the previous block carried forward from an earlier summary, the handoff note at
 * the head, and every human message in the replaced range. When it exceeds `maxChars`, the oldest human messages
 * are dropped and the block says which entries they were. Their originals stay stored.
 */
export function verbatimBlock(entries: readonly EntryRecord[], maxChars = VERBATIM_MAX_CHARS): string {
	const carried: string[] = [];
	const notes: string[] = [];
	const human: { id: string; text: string }[] = [];
	entries.forEach((entry, index) => {
		const text = entryText(entry);
		if (!text.trim()) return;
		if (index === 0 && entry.kind === "pi.compaction") {
			const open = text.indexOf(VERBATIM_OPEN);
			const close = text.lastIndexOf(VERBATIM_CLOSE);
			if (open >= 0 && close > open) {
				const raw = text.slice(open + VERBATIM_OPEN.length, close);
				const framing = `\n${VERBATIM_HEADER}\n\n`;
				// Strip only our framing, not whitespace that belonged to a human's message.
				const inner = raw.startsWith(framing) ? raw.slice(framing.length).replace(/\n$/, "") : raw;
				if (inner) carried.push(inner);
			}
		} else if (entry.kind === "pi.reset") notes.push(`[handoff note, entry #${String(entry.id)}]\n${text}`);
		else if (HUMAN_ENTRY_KINDS.includes(entry.kind)) human.push({ id: String(entry.id), text: `[human message, entry #${String(entry.id)}]\n${text}` });
	});
	const fixed = [...carried, ...notes];
	const prefix = `${VERBATIM_OPEN}\n${VERBATIM_HEADER}\n\n`;
	const suffix = `\n${VERBATIM_CLOSE}`;
	const budget = Math.max(0, maxChars - prefix.length - suffix.length);
	const omitted: string[] = [];
	const items = () => [...fixed, ...(omitted.length ? [`[${omitted.length} older human messages left out to bound this block: entries #${omitted.slice(0, 10).join(", #")}${omitted.length > 10 ? ", and others" : ""}]`] : []), ...human.map((item) => item.text)];
	// Include wrapper and omission-notice overhead when deciding how many human messages fit.
	while (human.length && items().join("\n\n").length > budget) omitted.push(human.shift()!.id);
	if (!items().length) return "";
	// Earlier summaries can carry omission notices and old human messages inside `fixed`. Bound that carried
	// text too: otherwise one small omission notice per compaction would grow forever. The newest copied text
	// stays exact; the explicit notice makes the loss visible, and original notes remain available through recall.
	let body = items().join("\n\n");
	if (body.length > budget) {
		const notice = "[Older copied text omitted to bound these notes; original entries remain in storage.]\n";
		const keep = Math.max(0, budget - notice.length);
		body = notice.slice(0, budget) + (keep ? body.slice(-keep) : "");
		if (body.length > budget) body = body.slice(0, budget);
	}
	return `${prefix}${body}${suffix}`;
}

/** The summary text the package wraps and stores as the `pi.compaction` entry. */
export function composeSummary(verbatim: string, modelSummary: string): string {
	return verbatim ? `${verbatim}\n\n${modelSummary.trim()}` : modelSummary.trim();
}

/** Whether a response is a usable summary: a clean stop with text and no tool call. A `length` stop is incomplete. */
export function summaryText(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop" || message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
	return text || undefined;
}

/** Keys of usage this hook has already added to `pi.usage`, so a repeated step does not add it twice. */
export const CompactionUsageDoc = defineDoc<{ recorded: string[] }>({
	kind: "demo.compaction-usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ recorded: [] }),
	checkpointWhen: () => true,
});

/** Same arithmetic as the package's own (unexported) `addUsage`. */
export function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/**
 * Add `usage` under `modelKey` in `pi.usage` unless `marker` is already recorded. Both changes are one commit.
 * Without a marker the usage is always added, for spend that no repeated step can reuse.
 */
export async function recordUsageOnce(tx: Tx, conversationId: ConversationId, marker: string | undefined, modelKey: string, usage: Usage): Promise<boolean> {
	if (marker !== undefined) {
		const markers = await tx.doc(CompactionUsageDoc, conversationId);
		if (markers.recorded.includes(marker)) return false;
		markers.recorded.push(marker);
	}
	const models = (await tx.doc(UsageDoc, conversationId)).models as unknown as Record<string, Usage>;
	const total = Object.hasOwn(models, modelKey) ? models[modelKey] : undefined;
	if (total === undefined) models[modelKey] = copyJson(usage, { omitUndefinedProperties: true }) as unknown as Usage;
	else addUsage(total, usage);
	return true;
}

export type CommitFn = (conversationId: ConversationId, change: (tx: Tx) => Promise<unknown>, context: Context) => Promise<void>;

/** A `CommitFn` through full Conversation handles, for example `conversationCommit((id, c) => harness.conversation(id, c))`. */
export function conversationCommit(get: (id: ConversationId, context: Context) => Promise<Pick<Conversation, "commit"> | undefined>): CommitFn {
	return async (conversationId, change, context) => {
		const conversation = await get(conversationId, context);
		if (!conversation) throw new Error(`conversation #${String(conversationId)} was not found`);
		await conversation.commit(change, context);
	};
}

export type Summarize = (model: Model<Api>, request: ModelContext, options: SimpleStreamOptions) => Promise<AssistantMessage>;

export type CompactionHookDeps = {
	/** The model that writes summaries, normally the fix model. */
	model: ModelRef;
	/** Commits to the conversation being compacted. A hook's own api cannot commit. */
	commit: CommitFn;
	/** Defaults to `api.models.completeSimple`. Tests pass a fake. */
	summarize?: Summarize;
	maxSummaryTokens?: number;
	log?: (line: string) => void;
};

type SavedSummary = { summary: string; modelKey: string; usage: Usage };
type BeforeCompact = CompactionHooks["beforeCompact"];

/**
 * The `beforeCompact` handler. It returns `{ summary }` when its own summary succeeds and `{ decline: true }` on any
 * failure; it never throws except on abort, because a thrown error would let the package summarize without these
 * instructions. A declined compaction leaves the context as it was, and the next request tries again.
 */
export function createBeforeCompact(deps: CompactionHookDeps): BeforeCompact {
	const log = deps.log ?? (() => {});
	return async (compaction, api: HookApi, context) => {
		const where = `conversation #${String(api.conversationId)}, first kept entry #${String(compaction.firstKept)}`;
		try {
			const memoKey = `shd.summary:${String(compaction.firstKept)}`;
			let saved = (await api.memo<JsonValue>(memoKey, context)) as unknown as SavedSummary | undefined;
			if (!saved) {
				const model = api.models.getModel(deps.model.provider, deps.model.modelId);
				if (!model) throw new Error(`summary model ${deps.model.provider}/${deps.model.modelId} is not available`);
				const request: ModelContext = {
					systemPrompt: SUMMARY_SYSTEM_PROMPT,
					messages: [{ role: "user", content: `<conversation>\n${serializeForSummary(compaction.messages)}\n</conversation>\n\n${PRESERVATION_INSTRUCTIONS}${compaction.instructions ? `\n\nAdditional focus: ${compaction.instructions}` : ""}`, timestamp: Date.now() }],
				};
				const maxTokens = Math.floor(Math.min(SUMMARY_MAX_TOKENS, deps.maxSummaryTokens ?? SUMMARY_MAX_TOKENS, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY));
				if (maxTokens <= 0) throw new Error("summary output limit must be positive");
				const summarize = deps.summarize ?? ((m, r, o) => api.models.completeSimple(m, r, o));
				const message = await summarize(model, request, { maxTokens, cacheRetention: "none", ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
				context.abortSignal?.throwIfAborted();
				const modelKey = `${message.provider}/${message.model}`;
				const text = summaryText(message);
				if (text === undefined) {
					// A failed attempt still cost tokens, as the package counts its own failed attempts. No repeated step
					// reuses a failed answer, so it needs no marker; a crash before this commit loses this record.
					await deps.commit(api.conversationId, (tx) => recordUsageOnce(tx, api.conversationId, undefined, modelKey, message.usage), context);
					throw new Error(`summary request ended with ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ""}`);
				}
				const candidate: SavedSummary = { summary: composeSummary(verbatimBlock(compaction.entries), text), modelKey, usage: copyJson(message.usage, { omitUndefinedProperties: true }) as unknown as Usage };
				// The first saved summary wins, so a repeated step reuses it instead of asking the model again.
				saved = (await api.memo<JsonValue>(memoKey, candidate as unknown as JsonValue, context)) as unknown as SavedSummary;
			}
			const summary = saved;
			const marker = `${String(api.taskId)}:${String(compaction.firstKept)}`;
			await deps.commit(api.conversationId, (tx) => recordUsageOnce(tx, api.conversationId, marker, summary.modelKey, summary.usage), context);
			log(`compaction (${compaction.reason}) of ${compaction.entries.length} entries in ${where}: summary of ${summary.summary.length} characters`);
			return { summary: summary.summary };
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			log(`compaction declined in ${where}: ${error instanceof Error ? error.message : String(error)}. The context stays as it is; the next request tries again.`);
			return { decline: true };
		}
	};
}

/** The hook registration for an extension's `hooks` list. */
export function compactionHook(deps: CompactionHookDeps) {
	return hook(CompactionTask, { beforeCompact: createBeforeCompact(deps) });
}
