import { describe, expect, it } from "vitest";
import { firstIncidentResponse, latestPriceEvidence, readSnapshotStream, type SmokeSnapshot } from "../src/smoke-observation.js";

const snapshot: SmokeSnapshot = { type: "snapshot", entries: [
	{ id: 1, conversationId: 1, kind: "pi.reset", model: [{ content: "latest notes" }] },
	{ id: 2, conversationId: 2, kind: "apify.incident", data: { failedRunId: "new" } },
	{ id: 3, conversationId: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", text: "PRIVATE" }, { type: "text", text: "Source old: current .value, all 20 products." }] }] },
] };

function stream(chunks: string[]) {
	let cancelled = false;
	return { body: new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); }, cancel() { cancelled = true; } }), cancelled: () => cancelled };
}

describe("smoke observations", () => {
	it("skips header events before the actual snapshot and closes the stream", async () => {
		const source = stream([`data: ${JSON.stringify({ type: "header", text: "starting" })}\n\n`, `data: ${JSON.stringify(snapshot)}\n\n`]);
		expect(await readSnapshotStream(source.body)).toEqual(snapshot);
		expect(source.cancelled()).toBe(true);
	});
	it("reads fragmented CRLF frames and UTF-8 characters split across chunks", async () => {
		const bytes = new TextEncoder().encode(`data: {"type":"header"}\r\n\r\ndata: ${JSON.stringify({ ...snapshot, label: "café" })}\r\n\r\n`);
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); }, cancel() { cancelled = true; } });
		expect(await readSnapshotStream(body)).toEqual({ ...snapshot, label: "café" });
		expect(cancelled).toBe(true);
	});
	it("reads assistant text after the matching incident regardless of thinking-block order", () => {
		expect(firstIncidentResponse(snapshot, "new", 2)).toBe("Source old: current .value, all 20 products.");
		expect(firstIncidentResponse(snapshot, "missing", 2)).toBeUndefined();
		expect(firstIncidentResponse(snapshot, "new", 1)).toBeUndefined();
	});
	it("requires the latest price choice and rejected-alternative reason, not source-labelled old build decisions", () => {
		const note = "Source incident: old\nPrice decision: .value chosen because it has current prices on all 20 products.\nRejected price alternative: .amount rejected because it showed old prices on only 7 of 20 products.";
		expect(latestPriceEvidence("Source old: .price-tag chosen; .amount rejected on 7 of 20 old prices.", note, "old")).toBe(false);
		expect(latestPriceEvidence("Source old: .value and .amount.", note, "old")).toBe(false);
		expect(latestPriceEvidence("From old: .value chosen because it has current prices on all 20 products. .amount rejected because it showed old prices on only 7 of 20 products.", note, "old")).toBe(true);
	});
});
