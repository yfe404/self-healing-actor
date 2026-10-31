// The agent uses these tools to read pages, change code, test it, and put an approved fix live.
// `replay: "safe"` lets the framework repeat a tool call after a restart. Writes specify the full target
// state: a file list, a build of a version, a label pointing to a build, or a record under one key.
// The `promote` approval check reads a saved record. After approval, a restarted run proceeds without asking again.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, hook, section, ToolTask, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { Actor } from "apify";
import { FIXTURE, type FixtureStore } from "./fixtures.js";
import { repairHandoff } from "./repair-chain.js";
import { compactionHook, conversationCommit, type Summarize } from "./compaction.js";
import { recallHistoryTool } from "./history.js";
import { MODELS } from "./models.js";
import { client } from "./platform.js";
import { pageFacts, renderPageSvg } from "./render-svg.js";
import {
	buildScraper,
	fetchTargetPage,
	PROD_TAG,
	readRun,
	readScraperSource,
	runScraper,
	tagBuild,
	writeScraperFile,
} from "./scraper-platform.js";

export type ToolEnv = {
	scraperActorId: string;
	/** Empty while the agent first builds the scraper and saves its notes. */
	failedRunId: string;
	targetUrl: string;
	fixtures: FixtureStore;
	log: (line: string) => void;
	/** Lazy full handle lookup, installed by repair startup after Harness.open. Build sessions need no lookup. */
	getConversation?: (id: ConversationId, context: Context) => Promise<Conversation | undefined>;
	/** Stops the run at its limit. `toolCallsSoFar` counts tool results saved in the conversation transcript. */
	budget: { maxToolCalls: number; maxElapsedMs: number; startedAt: number; toolCallsSoFar: (conversationId: unknown) => Promise<number> };
};

const text = (value: unknown) => [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];

/** POST /approve saves this approval record. The approval check reads it again after a restart. */
export const ApprovalDoc = defineDoc<{ approved: boolean; by: string; at: string; buildId: string }>({
	kind: "demo.approval",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ approved: false, by: "", at: "", buildId: "" }),
	checkpointWhen: () => true,
});

/** The agent web page shows this status line. The agent updates it with `set_status`. */
export const StatusDoc = defineDoc<{ phase: string; note: string; proposedBuildId: string }>({
	kind: "demo.status",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ phase: "idle", note: "", proposedBuildId: "" }),
	checkpointWhen: () => true,
});

export function pageTools(env: ToolEnv, allowFixtureWrites = true) {
	const fetchPage = defineTool({
		name: "fetch_page",
		description: "Fetch the live target page and return its HTML (first 30000 chars) plus facts: script tags, class names, element ids.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			const html = await fetchTargetPage(env.targetUrl);
			const facts = pageFacts(html, {});
			return { output: text({ url: env.targetUrl, bytes: html.length, scripts: facts.scripts, classes: facts.classes, ids: facts.ids, html: html.slice(0, 30_000) }) };
		},
	});

	const snapshotPage = defineTool({
		name: "snapshot_page",
		description: "Fetch the live page and store it as the build-time fixture (`fixture-html`) with a rendered screenshot (`fixture-screenshot.svg`). Absolute write; safe to repeat.",
		parameters: Type.Object({ label: Type.String({ description: "Caption for the screenshot, e.g. 'build time'" }) }),
		replay: "safe",
		execute: async (args) => {
			const html = await fetchTargetPage(env.targetUrl);
			const htmlUrl = await env.fixtures.put(FIXTURE.html, html, "text/html; charset=utf-8");
			const svgUrl = await env.fixtures.put(FIXTURE.screenshot, renderPageSvg(html, args.label), "image/svg+xml");
			env.log(`reference saved: ${htmlUrl} and ${svgUrl}`);
			return { output: text({ stored: [FIXTURE.html, FIXTURE.screenshot], htmlUrl, svgUrl, facts: pageFacts(html, {}) }) };
		},
	});

	const readFixture = defineTool({
		name: "read_fixture",
		description: `Read an immutable original build reference from the agent's store, not the latest production layout. Names: ${Object.values(FIXTURE).join(", ")}.`,
		parameters: Type.Object({ name: Type.String() }),
		replay: "safe",
		execute: async (args) => {
			const record = await env.fixtures.get(args.name);
			if (!record) return { isError: true, output: text(`no fixture named ${args.name}`) };
			const value = typeof record.value === "string" ? record.value.slice(0, 30_000) : record.value;
			return { output: text({ name: args.name, contentType: record.contentType, value }) };
		},
	});

	const storeFixture = defineTool({
		name: "store_fixture",
		description: `Store a JSON fixture under one of: ${FIXTURE.expectedSample} (first 5 expected items), ${FIXTURE.invariants} ({ fillRateThresholds: {field: 0..1}, itemCountMin, itemCountMax }), ${FIXTURE.selectors} ({ item, name, price, rating }). Absolute write; safe to repeat.`,
		parameters: Type.Object({ name: Type.String(), value: Type.Any() }),
		replay: "safe",
		execute: async (args) => {
			if (!(Object.values(FIXTURE) as string[]).includes(args.name)) return { isError: true, output: text(`unknown fixture name ${args.name}`) };
			const url = await env.fixtures.put(args.name, args.value as object, "application/json");
			env.log(`reference saved: ${url}`);
			return { output: text({ stored: args.name, url }) };
		},
	});

	return allowFixtureWrites ? [fetchPage, snapshotPage, readFixture, storeFixture] : [fetchPage, readFixture];
}

export function scraperTools(env: ToolEnv) {
	const readSource = defineTool({
		name: "read_scraper_source",
		description: "Read the scraper Actor's source files. With `file`, returns that file's content; without, lists files and returns selectors.js.",
		parameters: Type.Object({ file: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args) => {
			const files = await readScraperSource(env.scraperActorId);
			const wanted = args.file ?? "selectors.js";
			const file = files.find((f) => f.name === wanted);
			return { output: text({ files: files.map((f) => f.name), file: wanted, content: file?.content ?? null }) };
		},
	});

	const writeFile = defineTool({
		name: "write_scraper_file",
		description: "Replace one source file of the scraper Actor with the given full content (absolute write of the whole file list). Does not build.",
		parameters: Type.Object({ name: Type.String(), content: Type.String() }),
		execute: async (args) => {
			const result = await writeScraperFile(env.scraperActorId, args.name, args.content);
			env.log(`scraper source written: ${args.name} (${args.content.length} chars)`);
			return { output: text({ written: args.name, files: result.files }) };
		},
	});

	const build = defineTool({
		name: "build_scraper",
		description: "Build the scraper Actor from its current source files and tag the build `candidate`. Returns buildId. Takes about a minute.",
		parameters: Type.Object({}),
		execute: async () => {
			const result = await buildScraper(env.scraperActorId, "candidate");
			env.log(`scraper build ${result.buildId} ${result.status} (${result.buildNumber})`);
			await Actor.setValue("LAST_CANDIDATE_BUILD", result);
			return { output: text(result), isError: result.status !== "SUCCEEDED" };
		},
	});

	const canary = defineTool({
		name: "run_canary",
		description: "Run a given build of the scraper against the live site, wait for it, and return status, item count, field fill rates, the first 5 items, the DIAGNOSIS record if any, and the log tail. Use the buildId from build_scraper, or a tag like `prod`.",
		parameters: Type.Object({ build: Type.String() }),
		execute: async (args) => {
			const stats = await runScraper(env.scraperActorId, args.build);
			env.log(`canary run ${stats.runId} ${stats.status}: ${stats.itemCount} items, fill ${JSON.stringify(stats.fillRates)}`);
			return { output: text(stats) };
		},
	});

	const readRunTool = defineTool({
		name: "read_run",
		description: "Read a scraper run: status, item count, field fill rates, first 5 items, DIAGNOSIS record, log tail.",
		parameters: Type.Object({ runId: Type.String() }),
		replay: "safe",
		execute: async (args) => ({ output: text(await readRun(args.runId)) }),
	});

	const compare = defineTool({
		name: "compare_canary",
		description: "Compare a canary run's output with the immutable original expected sample and invariants: same field names, fill rates above thresholds, item count within range. Sample value differences are diagnostic, not automatic failures, because products may change. Returns a verdict.",
		parameters: Type.Object({ runId: Type.String() }),
		replay: "safe",
		execute: async (args) => {
			const stats = await readRun(args.runId);
			const expected = (await env.fixtures.get(FIXTURE.expectedSample))?.value as Record<string, unknown>[] | undefined;
			const invariants = (await env.fixtures.get(FIXTURE.invariants))?.value as { fillRateThresholds?: Record<string, number>; itemCountMin?: number; itemCountMax?: number } | undefined;
			const problems: string[] = [];
			if (stats.status !== "SUCCEEDED") problems.push(`run status ${stats.status}`);
			const expectedFields = expected?.[0] ? Object.keys(expected[0]).sort() : [];
			const actualFields = (stats.sample[0] as Record<string, unknown> | undefined) ? Object.keys(stats.sample[0] as object).sort() : [];
			if (expectedFields.length && expectedFields.join() !== actualFields.join()) problems.push(`schema differs: expected [${expectedFields}] got [${actualFields}]`);
			for (const [field, threshold] of Object.entries(invariants?.fillRateThresholds ?? {})) {
				if ((stats.fillRates[field] ?? 0) < threshold) problems.push(`fill rate of ${field} is ${((stats.fillRates[field] ?? 0) * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%`);
			}
			if (invariants?.itemCountMin !== undefined && stats.itemCount < invariants.itemCountMin) problems.push(`item count ${stats.itemCount} < ${invariants.itemCountMin}`);
			if (invariants?.itemCountMax !== undefined && stats.itemCount > invariants.itemCountMax) problems.push(`item count ${stats.itemCount} > ${invariants.itemCountMax}`);
			const sampleDiff = (expected ?? []).slice(0, 5).map((item, i) => {
				const actual = stats.sample[i] as Record<string, unknown> | undefined;
				const diffs = Object.keys(item).filter((k) => JSON.stringify(item[k]) !== JSON.stringify(actual?.[k]));
				return diffs.length ? `item ${i}: fields differ ${diffs.join(",")} (expected ${JSON.stringify(item)}, got ${JSON.stringify(actual)})` : `item ${i}: equal`;
			});
			const verdict = problems.length === 0 ? "PASS" : "FAIL";
			env.log(`compare_canary ${args.runId}: ${verdict} ${problems.join("; ")}`);
			return { output: text({ verdict, problems, itemCount: stats.itemCount, fillRates: stats.fillRates, sampleDiff }) };
		},
	});

	return [readSource, writeFile, build, canary, readRunTool, compare];
}

export function promotionTools(env: ToolEnv) {
	const setStatus = defineTool({
		name: "set_status",
		description: "Update the one-line status shown to the people watching (phase + note), and the build you intend to promote. Call it when your plan changes.",
		parameters: Type.Object({ phase: Type.String(), note: Type.String(), proposedBuildId: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			await api.commit(async (tx) => {
				const doc = await tx.doc(StatusDoc, api.conversationId);
				doc.phase = args.phase;
				doc.note = args.note;
				if (args.proposedBuildId) doc.proposedBuildId = args.proposedBuildId;
			}, context);
			env.log(`status: ${args.phase}: ${args.note}`);
			return { output: text("status updated") };
		},
	});

	const promote = defineTool({
		name: "promote",
		description: `Point the scraper's \`${PROD_TAG}\` build tag at the given build, so the scheduled runs use it. This call BLOCKS until a human approves on the steer page; call set_status with the proposedBuildId first so they know what they approve.`,
		parameters: Type.Object({ buildId: Type.String(), summary: Type.String({ description: "One sentence on what the fix changes" }) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const approval = await api.snapshot(ApprovalDoc, api.conversationId, context);
			if (!approval?.approved) return { isError: true, output: text("promotion was not approved") };
			const result = await tagBuild(env.scraperActorId, args.buildId);
			env.log(`PROMOTED: ${PROD_TAG} -> build ${result.buildId} (${result.buildNumber}), approved by ${approval.by} at ${approval.at}`);
			return { output: text({ ...result, approvedBy: approval.by, approvedAt: approval.at }) };
		},
	});

	// Intentionally not replay safe: a crash after pushData cannot prove that the dataset append was absent.
	const writeReport = defineTool({
		name: "write_report",
		description: "Write the final repair report and leave fresh notes for the next incident. Call exactly once, alone at the end (also when giving up). The handoff replaces your old notes: include current selectors for each field and why, rejected alternatives and reasons, what the site looked like, this incident's changes, build IDs, the outcome and unresolved work. Distinguish attempted changes from the build actually live. Include two separate lines, 'Price decision: <current selector and reason>' and 'Rejected price alternative: <selector and reason>', so your future self can quote the relevant evidence exactly. Carry forward still-relevant rejected alternatives. Do not append all past notes: older decisions remain in history.",
		parameters: Type.Object({
			whatChanged: Type.String(),
			whatWasDone: Type.String(),
			outcome: Type.String({ description: "promoted | not promoted | gave up" }),
			promotedBuildId: Type.Optional(Type.String()),
			handoffNote: Type.String({ minLength: 1, maxLength: 16000, description: "Fresh notes: current selectors and evidence, rejected alternatives and reasons, site layout and changes, build IDs, outcome and unresolved work. Include separate plain-text lines starting exactly 'Price decision:' and 'Rejected price alternative:', each with its selector and reason." }),
		}),
		execute: async (args, api, context) => {
			if (!args.handoffNote.trim()) return { isError: true, output: text("handoffNote must contain fresh notes for the next investigation") };
			if (!/^Price decision:[ \t]*\S.+$/im.test(args.handoffNote) || !/^Rejected price alternative:[ \t]*\S.+$/im.test(args.handoffNote)) {
				return { isError: true, output: text("Before writing the report, include two separate plain-text lines in handoffNote: 'Price decision: <current selector and reason>' and 'Rejected price alternative: <selector and reason>'. Keep the other required incident, build and unresolved-work notes too.") };
			}
			const approval = await api.snapshot(ApprovalDoc, api.conversationId, context);
			// Elapsed time starts when the page comparison records the failure. It includes earlier repair runs.
			const incident = (await env.fixtures.get(`incident-${env.failedRunId}`))?.value as { computedAt?: string } | undefined;
			const since = incident?.computedAt ? Date.parse(incident.computedAt) : env.budget.startedAt;
			const thisRun = process.env.ACTOR_RUN_ID ? await client.run(process.env.ACTOR_RUN_ID).get() : undefined;
			const report = {
				...args,
				approvedBy: approval?.approved ? approval.by : null,
				approvedAt: approval?.approved ? approval.at : null,
				elapsedSeconds: Math.round((Date.now() - since) / 1000),
				computeUnitsThisRun: (thisRun as { usage?: { ACTOR_COMPUTE_UNITS?: number } } | undefined)?.usage?.ACTOR_COMPUTE_UNITS ?? null,
				runId: process.env.ACTOR_RUN_ID ?? null,
				failedRunId: env.failedRunId,
				finishedAt: new Date().toISOString(),
			};
			await Actor.pushData(report);
			await Actor.setValue("REPORT", report);
			env.log(`REPORT: ${JSON.stringify(report)}`);
			const handoff = repairHandoff(env.failedRunId, args.handoffNote);
			env.log(`handoff prepared (${handoff.length} chars) for incident ${env.failedRunId}; the framework will commit it at the turn boundary`);
			return { output: text("report written; fresh handoff prepared; you are done"), details: { failedRunId: env.failedRunId, repairHandoff: handoff }, control: { terminate: true, handoff } };
		},
	});

	// The approval check makes `promote` wait for a saved approval record.
	// A restarted run can repeat `promote`. A saved approval lets it proceed without asking again.
	const gate = hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			if (call.name !== "promote") return undefined;
			const args = call.arguments as { buildId: string; summary: string };
			let approval = await api.snapshot(ApprovalDoc, api.conversationId, context);
			if (approval?.approved) {
				env.log(`gate: promotion of ${args.buildId} already approved by ${approval.by}; not asking again`);
				return undefined;
			}
			env.log(`gate: WAITING FOR APPROVAL to promote build ${args.buildId}: ${args.summary}`);
			const deadline = Date.now() + 30 * 60_000;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				approval = await api.snapshot(ApprovalDoc, api.conversationId, context);
				if (approval?.approved) {
					env.log(`gate: approved by ${approval.by} at ${approval.at}`);
					return undefined;
				}
			}
			return { block: "no approval arrived within 30 minutes; promotion refused" };
		},
	});

	// Count tool calls and refuse further calls at the limit, so the model writes the report and stops.
	const budget = hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			const elapsed = Date.now() - env.budget.startedAt;
			if (call.name === "write_report") return undefined;
			const count = await env.budget.toolCallsSoFar(api.conversationId);
			if (count >= env.budget.maxToolCalls || elapsed > env.budget.maxElapsedMs) {
				env.log(`budget exceeded (${count} tool calls, ${Math.round(elapsed / 1000)}s): blocking ${call.name}`);
				return { block: `Budget exceeded (${count} tool calls, ${Math.round(elapsed / 60_000)} min). Call write_report now with outcome "gave up" and stop.` };
			}
			return undefined;
		},
	});

	return { tools: [setStatus, promote, writeReport], hooks: [gate, budget] };
}

export function buildTools(env: ToolEnv) {
	const finish = defineTool({
		name: "finish_build",
		description:
			"End the build session with a handoff note. The note is the ONLY thing your future self will see at the start of a repair, so it must state: which selectors you chose for each field and WHY, which alternatives you rejected and why (e.g. a class that appears only on some items), the fixtures you stored, the invariants, and the build id tagged prod.",
		parameters: Type.Object({ handoffNote: Type.String() }),
		execute: async (args) => {
			env.log(`handoff note (${args.handoffNote.length} chars) recorded; build session ends`);
			return { output: text("build session closed"), control: { terminate: true, handoff: args.handoffNote } };
		},
	});
	const promoteNow = defineTool({
		name: "tag_prod",
		description: "Point the scraper's `prod` tag at a build (build session only, no approval needed).",
		parameters: Type.Object({ buildId: Type.String() }),
		execute: async (args) => {
			const result = await tagBuild(env.scraperActorId, args.buildId);
			env.log(`prod -> ${result.buildId} (${result.buildNumber})`);
			return { output: text(result) };
		},
	});
	return [finish, promoteNow];
}

export const BuildExtension = (env: ToolEnv) =>
	defineExtension({
		name: "shd-build",
		sections: [
			section(
				"role",
				() =>
					`You are the agent that builds and maintains the scraper Actor ${env.scraperActorId} for ${env.targetUrl}. Work step by step with the tools. Be explicit about selector choices and the evidence behind them: your notes are read by your future self during incidents.`,
				{ tag: false },
			),
		],
		tools: [...pageTools(env), ...scraperTools(env), ...buildTools(env)],
	});

export const RepairExtension = (env: ToolEnv, options: { summarize?: Summarize } = {}) => {
	const promotion = promotionTools(env);
	const getConversation = (id: ConversationId, context: Context) => {
		if (!env.getConversation) throw new Error("repair memory conversation lookup is not installed");
		return env.getConversation(id, context);
	};
	return defineExtension({
		name: "shd-repair",
		sections: [
			section(
				"role",
				() =>
					`You are the agent that built scraper Actor ${env.scraperActorId} for ${env.targetUrl}, now handling an incident. The platform has already computed what changed (the incident entry). Your FIRST message, before any tool call, must be one short paragraph that quotes your latest handoff note: name the source incident if the note has one, the current selector it records for each affected field, and a rejected alternative and its reason (name both classes). If the note has 'Price decision:' and 'Rejected price alternative:' lines, quote the contents of BOTH lines verbatim in that paragraph, including their reasons. If the note is the original build handoff, quote the actual chosen selector, rejected alternative, and rejection evidence from that note, not only the incident. Relate those notes to the incident. The incident compares the ORIGINAL accepted layout, so its selectors may differ from your latest notes after prior repairs or a demo reset. If your notes do not explain a selector, search your history with recall_history before guessing. Its search covers the build, previous repairs, and entries hidden by compaction; fetch a matching entry by id for the full evidence. Only then investigate with the tools, change selectors.js, build, run a canary, compare it with the expected sample, set_status with the proposed build id, and call promote (it waits for a human). Finish with write_report and a fresh, self-contained handoffNote covering current selectors and evidence, rejected alternatives and reasons, the site layout, incident changes, build IDs, outcome and unresolved work. People may steer you mid-run; acknowledge steers in your next message and act on them. Keep messages short and concrete.`,
				{ tag: false },
			),
		],
		tools: [...pageTools(env, false), ...scraperTools(env), ...promotion.tools, recallHistoryTool(getConversation)],
		hooks: [...promotion.hooks, compactionHook({ model: MODELS.fix, commit: conversationCommit(getConversation), summarize: options.summarize, log: env.log })],
	});
};
