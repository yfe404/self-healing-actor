// Connect the repair run to Apify, identify the run, and open the agent's memory store.
// Check that another repair run is not using the same store. Provide the two links you can open.
import { ApifyClient } from "apify-client";
import { ApifyKvStorage } from "./kvstore/apify-kv-storage.js";
import { apifyKvClient, localDirKvClient } from "./kvstore/kv-client.js";

export const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

export const AGENT_STORE_PREFIX = "shd-agent-memory-";
export const REDIRECTOR_URL = "https://straightforward-under--shd-repair-link.apify.actor/";

export type RepairInput = { actorId: string; failedRunId: string; mode?: "repair" | "probe"; targetUrl?: string };
export const TARGET_URL = "https://straightforward-under--shd-target-site.apify.actor/";

export const self = {
	runId: process.env.ACTOR_RUN_ID,
	actorId: process.env.ACTOR_ID,
	onPlatform: process.env.APIFY_IS_AT_HOME === "1",
	webPort: Number(process.env.ACTOR_WEB_SERVER_PORT ?? 4321),
	webUrl: process.env.ACTOR_WEB_SERVER_URL ?? `http://localhost:${process.env.ACTOR_WEB_SERVER_PORT ?? 4321}`,
};

export const agentStoreName = (scraperActorId: string): string => `${AGENT_STORE_PREFIX}${scraperActorId}`;

/** Open the agent's memory in a named key-value store, or under ./storage/key_value_stores/<name> locally. */
export async function openAgentStorage(scraperActorId: string, log: (line: string) => void): Promise<{ storage: ApifyKvStorage; storeId: string; storeUrl: string }> {
	const name = agentStoreName(scraperActorId);
	if (!self.onPlatform && process.env.APIFY_LOCAL_STORAGE_DIR) {
		const dir = `${process.env.APIFY_LOCAL_STORAGE_DIR}/key_value_stores/${name}`;
		const storage = await ApifyKvStorage.open(localDirKvClient(dir), { log });
		return { storage, storeId: name, storeUrl: dir };
	}
	const { id } = await client.keyValueStores().getOrCreate(name);
	const storage = await ApifyKvStorage.open(apifyKvClient(client, id), { log });
	return { storage, storeId: id, storeUrl: `https://console.apify.com/storage/key-value-stores/${id}` };
}

/** Find another RUNNING repair run for the same scraper actorId. This run must exit if one exists. */
export async function otherOwnerRunning(scraperActorId: string): Promise<string | undefined> {
	if (!self.actorId || !self.runId) return undefined;
	const runs = await client.actor(self.actorId).runs().list({ status: "RUNNING", limit: 20, desc: true });
	for (const run of runs.items) {
		if (run.id === self.runId) continue;
		const detail = await client.run(run.id).get();
		if (!detail) continue;
		const input = (await client.keyValueStore(detail.defaultKeyValueStoreId).getRecord("INPUT"))?.value as RepairInput | undefined;
		if (input?.actorId === scraperActorId) return run.id;
	}
	return undefined;
}

export const runUrl = (runId: string): string => `https://console.apify.com/actors/runs/${runId}`;
