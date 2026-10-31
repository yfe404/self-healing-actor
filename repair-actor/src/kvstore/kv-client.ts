// Read and write named records for the agent's storage.
// Use the Apify client on the platform or a local directory with the same file layout for tests.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApifyClient } from "apify-client";

export interface KvClient {
	/** Parsed JSON value of a record, or undefined when the key is absent. */
	get(key: string): Promise<unknown>;
	/** Store one JSON record. Return only after the platform acknowledges the write. */
	put(key: string, value: unknown): Promise<void>;
	/** List every key with this prefix, sorted as text. */
	listKeys(prefix: string): Promise<string[]>;
}

/** The platform store. `storeId` is the id returned by `keyValueStores().getOrCreate(name)`. */
export function apifyKvClient(client: ApifyClient, storeId: string): KvClient {
	const store = client.keyValueStore(storeId);
	return {
		async get(key) {
			const record = await store.getRecord(key);
			return record?.value;
		},
		async put(key, value) {
			await store.setRecord({ key, value: value as never, contentType: "application/json" });
		},
		async listKeys(prefix) {
			const keys: string[] = [];
			let exclusiveStartKey: string | undefined;
			for (;;) {
				const page = await store.listKeys({ prefix, exclusiveStartKey, limit: 1000 });
				for (const item of page.items) keys.push(item.key);
				if (!page.isTruncated) break;
				exclusiveStartKey = page.nextExclusiveStartKey;
			}
			return keys.sort();
		},
	};
}

/**
 * A directory of `<key>.json` files, the layout `apify run` uses under `./storage/key_value_stores/<name>`.
 * A `/` in a key becomes a subdirectory, as it does in Apify's local storage.
 */
export function localDirKvClient(directory: string): KvClient {
	const pathOf = (key: string) => join(directory, `${key}.json`);
	return {
		async get(key) {
			try {
				return JSON.parse(await readFile(pathOf(key), "utf8")) as unknown;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		async put(key, value) {
			const path = pathOf(key);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, JSON.stringify(value));
		},
		async listKeys(prefix) {
			const keys: string[] = [];
			const walk = async (dir: string, rel: string): Promise<void> => {
				let entries: import("node:fs").Dirent[];
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
					if (entry.isDirectory()) await walk(join(dir, entry.name), relPath);
					else if (entry.name.endsWith(".json")) keys.push(relPath.slice(0, -".json".length));
				}
			};
			await walk(directory, "");
			return keys.filter((key) => key.startsWith(prefix)).sort();
		},
	};
}

/** In-memory client for fast tests. */
export function memoryKvClient(): KvClient & { readonly records: Map<string, string> } {
	const records = new Map<string, string>();
	return {
		records,
		async get(key) {
			const text = records.get(key);
			return text === undefined ? undefined : (JSON.parse(text) as unknown);
		},
		async put(key, value) {
			records.set(key, JSON.stringify(value));
		},
		async listKeys(prefix) {
			return [...records.keys()].filter((key) => key.startsWith(prefix)).sort();
		},
	};
}
