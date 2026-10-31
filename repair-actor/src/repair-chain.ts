// Finished handoffs are discovered from durable history, never trusted from the optional KV cache.
import type { Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, Cursor, EntryId, EntryRecord, Harness, Storage } from "@earendil-works/pi-durable";
import { incidentText, type DiffBundle } from "./diff-bundle.js";
import type { FixtureStore } from "./fixtures.js";

export const LATEST_HANDOFF = "latest-handoff";
export const repairMappingKey = (failedRunId: string) => `repair-conversation-${failedRunId}`;
export const handoffHeader = (failedRunId: string) => `REPAIR HANDOFF\nSource incident: ${failedRunId}\n`;
export const repairHandoff = (failedRunId: string, note: string) => `${handoffHeader(failedRunId)}\n${note.trim()}`;

export type RepairMapping = {
	conversationId: ConversationId;
	forkedAt?: EntryId;
	parentConversationId?: ConversationId;
	parentFailedRunId?: string;
	bundleKey?: string;
};
export type CompletedHandoff = {
	conversationId: ConversationId;
	entryId: EntryId;
	reportEntryId: EntryId;
	failedRunId: string;
	note: string;
};

export function entryText(entry: EntryRecord): string {
	return (entry.model ?? []).flatMap((message) => typeof message.content === "string"
		? [message.content]
		: message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
}

export async function ownEntries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 100, cursor, context);
		entries.push(...page.items.filter((entry) => entry.conversationId === conversation.id));
		cursor = page.next;
	} while (cursor !== undefined);
	return entries;
}

export async function latestCompletedHandoff(harness: Harness, storage: Storage, context: Context): Promise<CompletedHandoff | undefined> {
	let latest: CompletedHandoff | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanConversations({}, 100, cursor, context);
		for (const record of page.items) {
			const conversation = await harness.conversation(record.id, context);
			if (!conversation) continue;
			const entries = await ownEntries(conversation, context);
			for (const report of entries) {
				if (report.kind !== "pi.tool-result") continue;
				for (const message of report.model ?? []) {
					if (message.role !== "toolResult" || message.toolName !== "write_report" || message.isError) continue;
					const details = message.details as { failedRunId?: string; repairHandoff?: string } | undefined;
					if (!details?.failedRunId || !details.repairHandoff?.startsWith(handoffHeader(details.failedRunId))) continue;
					const submission = await storage.submissionByRequest(record.id, details.failedRunId, context);
					if (submission?.type !== "input" || submission.status !== "done") continue;
					const incident = entries.find((entry) => entry.id === submission.entry && entry.kind === "apify.incident");
					if (!incident || incident.id >= report.id || (incident.data as { failedRunId?: string } | undefined)?.failedRunId !== details.failedRunId) continue;
					// Queued human entries may follow this reset. Fork at the reset itself, not at the tail.
					const reset = entries.find((entry) => entry.kind === "pi.reset" && entry.head === entry.id && entry.id > report.id && entryText(entry) === details.repairHandoff);
					if (!reset || (latest && latest.entryId >= reset.id)) continue;
					latest = { conversationId: record.id, entryId: reset.id, reportEntryId: report.id, failedRunId: details.failedRunId, note: details.repairHandoff };
				}
			}
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return latest;
}

export async function reconcileLatestHandoff(harness: Harness, storage: Storage, fixtures: FixtureStore, context: Context): Promise<CompletedHandoff | undefined> {
	// Scan all completions even on an old incident's restart. The cache cannot regress to that old incident.
	const latest = await latestCompletedHandoff(harness, storage, context);
	if (latest) await fixtures.put(LATEST_HANDOFF, latest, "application/json");
	return latest;
}

export async function countOwnToolResults(storage: Storage, conversationId: ConversationId, context: Context): Promise<number> {
	let count = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
		count += page.items.filter((entry) => entry.conversationId === conversationId && entry.kind === "pi.tool-result").length;
		cursor = page.next;
	} while (cursor !== undefined);
	return count;
}

/** Run before opening the Harness. abort()/submit()/wait() can all implicitly start its scheduler. */
export async function markStaleWork(storage: Storage, keep: ConversationId | undefined, context: Context): Promise<ConversationId[]> {
	const stale = new Set<ConversationId>();
	const tasks = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanTasks({}, 100, cursor, context);
		for (const task of page.items) {
			if (task.conversationId === keep || task.state.status === "terminal") continue;
			stale.add(task.conversationId);
			tasks.push({ type: "task" as const, value: { ...task, abortRequested: true } });
		}
		cursor = page.next;
	} while (cursor !== undefined);
	cursor = undefined;
	do {
		const page = await storage.scanSubmissions({}, 100, cursor, context);
		for (const submission of page.items) {
			if (submission.conversationId !== keep && (submission.status === "queued" || submission.status === "placed")) stale.add(submission.conversationId);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	// All stale tasks are marked in ONE durable step before the first abort can start any scheduler.
	if (tasks.length) await storage.commit(tasks, context);
	return [...stale];
}

export async function abandonMarkedWork(harness: Harness, conversations: readonly ConversationId[], context: Context, log: (line: string) => void): Promise<void> {
	// Admit withdrawal of every stale queued input before abort() enables scheduling. abortSubmission does not resume.
	const inspection = await harness.inspect(context);
	for (const submission of inspection.submissions) {
		if (conversations.includes(submission.conversationId) && submission.status === "queued") await harness.abortSubmission(submission.id, context);
	}
	for (const id of conversations) {
		const conversation = await harness.conversation(id, context);
		if (!conversation) continue;
		log(`abandoning stale investigation in conversation #${String(id)}: this run is for a different incident`);
		await conversation.abort(context, { background: true });
	}
}

/** Also covers a crash after the mapping was saved but before incident admission. */
export async function submitSavedIncident(conversation: Conversation, failedRunId: string, fixtures: FixtureStore, context: Context) {
	const bundleKey = `incident-${failedRunId}`;
	const bundle = (await fixtures.get(bundleKey))?.value as DiffBundle | undefined;
	if (!bundle || bundle.failedRunId !== failedRunId) throw new Error(`missing saved incident ${bundleKey}; refusing to replace it with a placeholder`);
	const content = incidentText(bundle);
	return conversation.submit({ requestId: failedRunId, type: "input", content, entry: { kind: "apify.incident", data: { summary: content, bundleKey, failedRunId } } }, context);
}
