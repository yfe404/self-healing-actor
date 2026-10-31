// Pure helpers shared by the platform smoke script and offline tests. Importing this file starts no runs.
export type SmokeEntry = {
	id: number;
	conversationId: number;
	kind: string;
	data?: { failedRunId?: string };
	model?: { role?: string; content: string | { type: string; text?: string }[] }[];
};
export type SmokeSnapshot = { type: "snapshot"; entries: SmokeEntry[] };

/** Headers can arrive first, frames can be fragmented, and UTF-8 characters can span chunks. */
export async function readSnapshotStream(body: ReadableStream<Uint8Array>): Promise<SmokeSnapshot | undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let boundary: RegExpExecArray | null;
			while ((boundary = /\r?\n\r?\n/.exec(pending))) {
				const frame = pending.slice(0, boundary.index);
				pending = pending.slice(boundary.index + boundary[0].length);
				const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
				if (!data) continue;
				const event = JSON.parse(data) as { type?: string; entries?: unknown };
				if (event.type === "snapshot" && Array.isArray(event.entries)) return event as SmokeSnapshot;
			}
			if (done) return undefined;
		}
	} finally {
		// Reading one snapshot must not leave an open event stream attached to the running Actor.
		try { await reader.cancel(); } finally { reader.releaseLock(); }
	}
}

export function smokeEntryText(entry: SmokeEntry): string {
	return (entry.model ?? []).flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

export function firstIncidentResponse(snapshot: SmokeSnapshot, failedRunId: string, conversationId: number): string | undefined {
	const incidentAt = snapshot.entries.findIndex((entry) => entry.kind === "apify.incident" && entry.conversationId === conversationId && entry.data?.failedRunId === failedRunId);
	if (incidentAt < 0) return undefined;
	const response = snapshot.entries.slice(incidentAt + 1).find((entry) => entry.kind === "pi.assistant" && entry.conversationId === conversationId);
	return response ? smokeEntryText(response).trim() || undefined : undefined;
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
/** Exact relevant quotations, not merely any selector shared by old and new notes. */
export function latestPriceEvidence(message: string, note: string, sourceIncident: string): boolean {
	const decision = /^Price decision:\s*(.+)$/im.exec(note)?.[1]?.trim();
	const rejected = /^Rejected price alternative:\s*(.+)$/im.exec(note)?.[1]?.trim();
	return !!decision && !!rejected && message.includes(sourceIncident) && normalized(message).includes(normalized(decision)) && normalized(message).includes(normalized(rejected));
}
