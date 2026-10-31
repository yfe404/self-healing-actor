// Pi Durable 1.4.0 ships a BM25 ranker in `dist/search.js` but does not export it as a package path.
// This adapter loads that shipped file from the installed package, so recall uses the same ranker as `tool_search`.
// It resolves `package.json`, which the package does export, and imports the sibling file by its file URL.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type SearchDocument = { readonly name: string; readonly text: string };
export type Ranker = {
	/** Okapi BM25 (k1 1.2, b 0.75): names of the best matches with a score above 0, best first; ties keep document order. */
	rankDocuments(query: string, documents: readonly SearchDocument[], limit: number): string[];
	/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words, naively singular. */
	tokenize(text: string): string[];
};

/** The installed file the ranker comes from. Tests and logs use it to show which file was loaded. */
export function rankerUrl(): URL {
	const manifest = createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json");
	return new URL("./dist/search.js", pathToFileURL(manifest));
}

let loaded: Promise<Ranker> | undefined;

/** Load the shipped ranker once. Fails loudly if a different package version moved or renamed it. */
export function loadRanker(): Promise<Ranker> {
	loaded ??= import(rankerUrl().href).then((module: Partial<Ranker>) => {
		if (typeof module.rankDocuments !== "function" || typeof module.tokenize !== "function") {
			throw new Error(`${rankerUrl().href} does not export rankDocuments and tokenize; check the pinned pi-durable version`);
		}
		return { rankDocuments: module.rankDocuments, tokenize: module.tokenize };
	});
	return loaded;
}
