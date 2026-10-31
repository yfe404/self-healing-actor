// Cheerio, an HTML-reading library, extracts products from the target site into the run's dataset.
// The scraper then checks the share of products with a price. If that share falls below the threshold,
// the scraper writes a DIAGNOSIS record and fails the run.
import { Actor } from "apify";
import * as cheerio from "cheerio";
import { SELECTORS, extract } from "./selectors.js";

await Actor.init();
const input = (await Actor.getInput()) || {};
const url = input.url || process.env.TARGET_URL;
const threshold = input.priceFillRateThreshold ?? 0.9;
if (!url) throw new Error("Input `url` or env TARGET_URL is required");

const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } });
if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
const html = await response.text();
const $ = cheerio.load(html);

const items = $(SELECTORS.item)
	.map((_, el) => extract($, $(el)))
	.get();
await Actor.pushData(items);

const fill = (field) => (items.length === 0 ? 0 : items.filter((i) => i[field] !== null && i[field] !== undefined && i[field] !== "").length / items.length);
const fillRates = { name: fill("name"), price: fill("price"), rating: fill("rating") };
const summary = { url, itemCount: items.length, fillRates, selectors: SELECTORS, threshold };
console.log(`scraped ${items.length} items. Share of items with each field ${JSON.stringify(fillRates)}`);

if (items.length === 0 || fillRates.price < threshold) {
	const diagnosis = {
		...summary,
		verdict: `price fill rate ${(fillRates.price * 100).toFixed(0)}% is below ${(threshold * 100).toFixed(0)}%${items.length === 0 ? " (no items matched the item selector)" : ""}`,
		sampleItem: items[0] ?? null,
	};
	await Actor.setValue("DIAGNOSIS", diagnosis);
	await Actor.fail(`Output validation failed: ${diagnosis.verdict}`);
} else {
	await Actor.setValue("SUMMARY", summary);
	await Actor.exit();
}
