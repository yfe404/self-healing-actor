// Prints the durable task tree with the status of every task. This is what the audience sees on a resumed
// run: finished tool calls stay finished, the interrupted one shows as interrupted, the rest continues.
import type { Context } from "@earendil-works/chord";
import type { Harness, HarnessInspection, Storage, TaskInspection } from "@earendil-works/pi-durable";

type Rec = {
	id: unknown;
	kind?: string;
	conversationId?: unknown;
	owner?: unknown; // the owning task's id, absent for top-level work
	input?: { kind?: string; assistant?: unknown; callId?: string } | undefined;
	state?: { status?: string; checkpoint?: { phase?: string } } | undefined;
};

/** A tool task's input names the assistant entry and call id; the tool name lives in that entry. */
async function toolName(storage: Storage, record: Rec, context: Context): Promise<string | undefined> {
	if (record.kind !== "pi.tool" || record.input?.assistant === undefined || record.conversationId === undefined) return undefined;
	try {
		const read = (await storage.entry(record.conversationId as never, record.input.assistant as never, context)) as
			| { entry?: { model?: { content?: { type: string; id?: string; name?: string }[] }[] } }
			| undefined;
		const call = read?.entry?.model?.flatMap((message) => message.content ?? []).find((part) => part.type === "toolCall" && part.id === record.input?.callId);
		return call?.name;
	} catch {
		return undefined;
	}
}

export async function formatTaskTree(inspection: HarnessInspection, storage: Storage, context: Context): Promise<string[]> {
	const byOwner = new Map<string, TaskInspection[]>();
	for (const task of inspection.tasks) {
		const owner = (task.record as Rec).owner;
		const live = new Set(inspection.tasks.map((t) => String((t.record as Rec).id)));
		// A task whose owner is no longer live (already settled) is shown at the top level.
		const key = owner === undefined || owner === null || !live.has(String(owner)) ? "root" : String(owner);
		byOwner.set(key, [...(byOwner.get(key) ?? []), task]);
	}
	const lines: string[] = [`scheduling: ${inspection.scheduling}; live tasks: ${inspection.tasks.length}; submissions: ${inspection.submissions.length}`];
	const walk = async (key: string, depth: number): Promise<void> => {
		for (const task of byOwner.get(key) ?? []) {
			const record = task.record as Rec;
			const name = await toolName(storage, record, context);
			const phase = record.state?.checkpoint?.phase;
			const verdict =
				record.kind === "pi.tool" && task.state.kind === "ready" && (phase === "execute" || phase === "call") ? " <- was running when the previous run died; a replay-safe tool (reads, promote) is re-run, any other is reported to the model as interrupted" : "";
			lines.push(`${"  ".repeat(depth)}- ${record.kind ?? "task"}${name ? ` ${name}` : ""} #${String(record.id)} [${task.state.kind}${phase ? `, phase ${phase}` : ""}]${verdict}`);
			await walk(String(record.id), depth + 1);
		}
	};
	await walk("root", 1);
	for (const submission of inspection.submissions) {
		const s = submission as { id: unknown; status?: string; type?: string; requestId?: string };
		lines.push(`  submission #${String(s.id)} ${s.type ?? ""} ${s.status ?? ""}${s.requestId ? ` request=${s.requestId}` : ""}`);
	}
	if (inspection.tasks.length === 0) lines.push("  (no live tasks: nothing was interrupted)");
	return lines;
}

export async function printTaskTree(harness: Harness, storage: Storage, context: Context, log: (line: string) => void, title: string): Promise<HarnessInspection> {
	const inspection = await harness.inspect(context);
	log(`=== ${title} ===`);
	for (const line of await formatTaskTree(inspection, storage, context)) log(line);
	return inspection;
}
