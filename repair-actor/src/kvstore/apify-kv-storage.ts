// Pi Durable storage on an Apify key-value store, as a commit log.
//
// Layout of the store:
//   log-000000123        one record per committed batch: { seq, writes }. Written with a single PUT, so a
//                        commit is either fully present or absent. The zero-padded seq makes keys sort.
//   snapshot-000000100   every `snapshotEvery` commits: { seq, commits: [{ seq, writes }, ...] } holding every
//                        commit up to seq, so startup reads one record plus the log tail instead of N records.
//   head                 { seq } optimisation only; startup derives the true head by listing `log-`.
//
// The working set is a MemoryStorage (the package's reference backend). Every read is answered from memory;
// the KV store is a write-ahead log, read only at startup. A commit is not done until its PUT returned.
// This mirrors the package's own JSONL backend, which is MemoryStorage plus an append-only file.
import type { Context } from "@earendil-works/chord";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	ConversationQuery,
	Cursor,
	DocumentAddress,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	EntryId,
	EntryQuery,
	Id,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	SubmissionQuery,
	TaskId,
	TaskQuery,
} from "@earendil-works/pi-durable";
import type { KvClient } from "./kv-client.js";

type StoredCommit = { readonly seq: number; readonly writes: readonly StorageWrite[] };
type SnapshotRecord = { readonly seq: number; readonly commits: readonly StoredCommit[] };

export const LOG_PREFIX = "log-"; // `/` is allowed in keys but the record API treats it as a path separator
export const SNAPSHOT_PREFIX = "snapshot-";
export const HEAD_KEY = "head";

export const logKey = (seq: number): string => `${LOG_PREFIX}${String(seq).padStart(9, "0")}`;
const snapshotKey = (seq: number): string => `${SNAPSHOT_PREFIX}${String(seq).padStart(9, "0")}`;
const seqOfKey = (key: string, prefix: string): number => Number(key.slice(prefix.length));

export type ApifyKvStorageOptions = {
	/** Write a snapshot record every this many commits. Default 25. */
	readonly snapshotEvery?: number;
	/** Where startup and commit diagnostics go. Default: silent. */
	readonly log?: (line: string) => void;
};

export type RecoveryReport = {
	readonly snapshotSeq: number | undefined;
	readonly replayedFromLog: number;
	readonly headSeq: number;
};

export class ApifyKvStorage implements Storage {
	private readonly memory = new MemoryStorage();
	private readonly commits: StoredCommit[] = [];
	private readonly snapshotEvery: number;
	private readonly log: (line: string) => void;
	private closed = false;
	private poisoned: Error | undefined;
	public recovery: RecoveryReport = { snapshotSeq: undefined, replayedFromLog: 0, headSeq: 0 };

	private constructor(
		private readonly kv: KvClient,
		options: ApifyKvStorageOptions,
	) {
		this.snapshotEvery = options.snapshotEvery ?? 25;
		this.log = options.log ?? (() => {});
	}

	/** Open the store: load the newest snapshot, then replay every `log/` record after it, in seq order. */
	static async open(kv: KvClient, options: ApifyKvStorageOptions = {}): Promise<ApifyKvStorage> {
		const storage = new ApifyKvStorage(kv, options);
		await storage.recover();
		return storage;
	}

	private async recover(): Promise<void> {
		let snapshotSeq: number | undefined;
		const snapshotKeys = await this.kv.listKeys(SNAPSHOT_PREFIX);
		if (snapshotKeys.length > 0) {
			const newest = snapshotKeys[snapshotKeys.length - 1]!;
			const snapshot = (await this.kv.get(newest)) as SnapshotRecord | undefined;
			if (snapshot !== undefined) {
				for (const commit of snapshot.commits) this.replay(commit);
				snapshotSeq = snapshot.seq;
			}
		}
		// The true head comes from the listing, never from the `head` record.
		const logKeys = await this.kv.listKeys(LOG_PREFIX);
		let replayed = 0;
		for (const key of logKeys) {
			const seq = seqOfKey(key, LOG_PREFIX);
			if (snapshotSeq !== undefined && seq <= snapshotSeq) continue;
			const commit = (await this.kv.get(key)) as StoredCommit | undefined;
			if (commit === undefined) throw new Error(`Log record ${key} listed but unreadable`);
			this.replay(commit);
			replayed++;
		}
		const headSeq = this.commits.length === 0 ? 0 : this.commits[this.commits.length - 1]!.seq;
		this.recovery = { snapshotSeq, replayedFromLog: replayed, headSeq };
		this.log(
			`[kv-storage] recovered: snapshot=${snapshotSeq ?? "none"} log records replayed=${replayed} head seq=${headSeq}`,
		);
	}

	private replay(commit: StoredCommit): void {
		const last = this.commits[this.commits.length - 1];
		if (last !== undefined && commit.seq <= last.seq) throw new Error(`Log seq ${commit.seq} out of order`);
		this.memory.prepareCommit(commit.writes, commit.seq as Seq).apply();
		this.commits.push(commit);
	}

	private assertUsable(): void {
		if (this.closed) throw new Error("ApifyKvStorage is closed");
		if (this.poisoned !== undefined) throw new Error("ApifyKvStorage failed earlier and must be reopened", { cause: this.poisoned });
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertUsable();
		// Validation and detaching happen in memory first; a refused batch changes nothing and never reaches the store.
		const prepared = this.memory.prepareCommit(writes);
		const record: StoredCommit = { seq: prepared.seq, writes: prepared.writes };
		try {
			await this.kv.put(logKey(prepared.seq), record);
		} catch (error) {
			// Nothing was applied in memory, so the storage is still consistent; the Session treats this as fatal anyway.
			this.poisoned = error instanceof Error ? error : new Error(String(error));
			throw this.poisoned;
		}
		const seq = prepared.apply();
		this.commits.push(record);
		if (seq % this.snapshotEvery === 0) {
			// Best effort: a lost snapshot only costs startup time, the log stays authoritative.
			try {
				await this.kv.put(snapshotKey(seq), { seq, commits: this.commits } satisfies SnapshotRecord);
				await this.kv.put(HEAD_KEY, { seq });
				this.log(`[kv-storage] snapshot written at seq ${seq}`);
			} catch (error) {
				this.log(`[kv-storage] snapshot at seq ${seq} failed: ${(error as Error).message}`);
			}
		}
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertUsable();
		return this.memory.mintId<I>();
	}

	async conversation(id: ConversationId, context: Context) {
		this.assertUsable();
		return this.memory.conversation(id, context);
	}
	async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		this.assertUsable();
		return this.memory.scanConversations(query, limit, cursor, context);
	}
	entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>;
	async entry(a: EntryId | ConversationId, b: Context | EntryId, c?: Context) {
		this.assertUsable();
		return c === undefined
			? this.memory.entry(a as EntryId, b as Context)
			: this.memory.entry(a as ConversationId, b as EntryId, c);
	}
	async findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context) {
		this.assertUsable();
		return this.memory.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
	}
	async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		this.assertUsable();
		return this.memory.scanEntries(query, limit, cursor, context);
	}
	async task(id: TaskId, context: Context) {
		this.assertUsable();
		return this.memory.task(id, context);
	}
	async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		this.assertUsable();
		return this.memory.scanTasks(query, limit, cursor, context);
	}
	async submission(id: SubmissionId, context: Context) {
		this.assertUsable();
		return this.memory.submission(id, context);
	}
	async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		this.assertUsable();
		return this.memory.scanSubmissions(query, limit, cursor, context);
	}
	async submissionByRequest(conversationId: ConversationId, requestId: string, context: Context) {
		this.assertUsable();
		return this.memory.submissionByRequest(conversationId, requestId, context);
	}
	async findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
		this.assertUsable();
		return this.memory.findDocument(address, at, context);
	}
	async document(id: DocumentId, at: DocumentPoint, context: Context) {
		this.assertUsable();
		return this.memory.document(id, at, context);
	}
	async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		this.assertUsable();
		return this.memory.scanDocuments(query, limit, cursor, context);
	}

	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.memory.close(context);
	}
}
