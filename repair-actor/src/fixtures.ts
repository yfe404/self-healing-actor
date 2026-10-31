// Saved build references use `fixture-*` keys in the agent's key-value store.
// Keep large files, such as page HTML and the drawn page picture, outside the records of saved steps.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { client, self } from "./platform.js";

export interface FixtureStore {
	put(key: string, value: string | object, contentType: string): Promise<string>; // returns a URL/path
	get(key: string): Promise<{ value: unknown; contentType: string } | undefined>;
	url(key: string): string;
}

export function platformFixtureStore(storeId: string): FixtureStore {
	const store = client.keyValueStore(storeId);
	return {
		async put(key, value, contentType) {
			await store.setRecord({ key, value: typeof value === "string" ? value : (value as never), contentType });
			return this.url(key);
		},
		async get(key) {
			const record = await store.getRecord(key);
			return record ? { value: record.value, contentType: record.contentType ?? "application/json" } : undefined;
		},
		url: (key) => `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`,
	};
}

export function localFixtureStore(directory: string): FixtureStore {
	const ext = (contentType: string) => (contentType.includes("svg") ? ".svg" : contentType.includes("html") ? ".html" : contentType.includes("json") ? ".json" : ".txt");
	const meta = join(directory, "_fixture-types.json");
	const types = async (): Promise<Record<string, string>> => JSON.parse(await readFile(meta, "utf8").catch(() => "{}")) as Record<string, string>;
	return {
		async put(key, value, contentType) {
			await mkdir(directory, { recursive: true });
			const current = await types();
			current[key] = contentType;
			await writeFile(meta, JSON.stringify(current));
			await writeFile(join(directory, key + ext(contentType)), typeof value === "string" ? value : JSON.stringify(value, null, 2));
			return this.url(key);
		},
		async get(key) {
			const contentType = (await types())[key];
			if (!contentType) return undefined;
			const text = await readFile(join(directory, key + ext(contentType)), "utf8");
			return { value: contentType.includes("json") ? JSON.parse(text) : text, contentType };
		},
		url: (key) => `${directory}/${key}`,
	};
}

export function openFixtureStore(storeId: string): FixtureStore {
	if (!self.onPlatform && process.env.APIFY_LOCAL_STORAGE_DIR) return localFixtureStore(`${process.env.APIFY_LOCAL_STORAGE_DIR}/key_value_stores/${storeId}`);
	return platformFixtureStore(storeId);
}

export const FIXTURE = {
	html: "fixture-html",
	screenshot: "fixture-screenshot.svg",
	expectedSample: "fixture-expected-sample",
	invariants: "fixture-invariants",
	selectors: "fixture-selectors",
} as const;
