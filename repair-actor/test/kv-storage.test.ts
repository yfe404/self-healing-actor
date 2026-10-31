import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { ApifyClient } from "apify-client";
import { describe, expect, it } from "vitest";
import { ApifyKvStorage } from "../src/kvstore/apify-kv-storage.js";
import { apifyKvClient, localDirKvClient, memoryKvClient } from "../src/kvstore/kv-client.js";

const context = BACKGROUND_CONTEXT;

registerStorageConformance({ describe, expect, it }, "ApifyKvStorage over memory KV", async (use) => {
	const storage = await ApifyKvStorage.open(memoryKvClient(), { snapshotEvery: 3 });
	try {
		await use(storage);
	} finally {
		await storage.close(context);
	}
});

// The layout `apify run` keeps under ./storage/key_value_stores/<name>: one <key>.json file per record.
registerStorageConformance({ describe, expect, it }, "ApifyKvStorage over local ./storage directory", async (use) => {
	const directory = await mkdtemp(join(tmpdir(), "kv-storage-"));
	const storage = await ApifyKvStorage.open(localDirKvClient(directory), { snapshotEvery: 3 });
	try {
		await use(storage);
	} finally {
		await storage.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

// Opt in with KV_CONFORMANCE_PLATFORM=1: each case gets a fresh named store on the real platform.
if (process.env.KV_CONFORMANCE_PLATFORM === "1") {
	const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
	let counter = 0;
	registerStorageConformance({ describe, expect, it }, "ApifyKvStorage over the Apify platform", async (use) => {
		const name = `conformance-${Date.now()}-${counter++}`;
		const { id } = await client.keyValueStores().getOrCreate(name);
		const storage = await ApifyKvStorage.open(apifyKvClient(client, id), { snapshotEvery: 3 });
		try {
			await use(storage);
		} finally {
			await storage.close(context);
			await client.keyValueStore(id).delete();
		}
	});
}

describe("ApifyKvStorage reopen", () => {
	it("recovers from snapshot plus log tail and keeps minting ids above stored ones", async () => {
		const kv = memoryKvClient();
		const first = await ApifyKvStorage.open(kv, { snapshotEvery: 2 });
		await first.commit([{ type: "conversation", value: { id: 1 as never } }], context);
		await first.commit([{ type: "entry", value: { id: 2 as never, conversationId: 1 as never, kind: "a" } }], context);
		await first.commit([{ type: "entry", value: { id: 3 as never, conversationId: 1 as never, kind: "b" } }], context);
		await first.close(context);
		expect([...kv.records.keys()].sort()).toEqual(["head", "log-000000001", "log-000000002", "log-000000003", "snapshot-000000002"]);

		const second = await ApifyKvStorage.open(kv, { snapshotEvery: 2 });
		expect(second.recovery).toEqual({ snapshotSeq: 2, replayedFromLog: 1, headSeq: 3 });
		const page = await second.scanEntries({ conversationId: 1 as never }, 10, undefined, context);
		expect(page.items.map((entry) => entry.kind)).toEqual(["b", "a"]);
		expect(await second.mintId()).toBe(4);
		const seq = await second.commit([{ type: "entry", value: { id: 4 as never, conversationId: 1 as never, kind: "c" } }], context);
		expect(seq).toBe(4);
		await second.close(context);
	});
});
