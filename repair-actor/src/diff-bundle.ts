// The diff bundle: plain code, no model. Computed before the agent wakes, so its first job is interpretation.
import { FIXTURE, type FixtureStore } from "./fixtures.js";
import { pageFacts, renderPageSvg, SUSPICIOUS } from "./render-svg.js";
import { fetchTargetPage, readRun, type RunStats } from "./scraper-platform.js";

export type DiffBundle = {
	failedRunId: string;
	computedAt: string;
	targetUrl: string;
	selectors: Record<string, string>;
	selectorMatches: { field: string; selector: string; atBuildTime: number; now: number; verdict: "still matches" | "MISSING" | "fewer" | "more" }[];
	newScripts: string[];
	removedScripts: string[];
	newClasses: string[];
	removedClasses: string[];
	suspiciousNewClasses: string[];
	newIds: string[];
	failedRun: { status: string; itemCount: number; fillRates: Record<string, number>; diagnosis: unknown; buildNumber: string | undefined };
	screenshots: { before: string; after: string };
	bytes: { before: number; now: number };
};

export async function computeDiffBundle(opts: { failedRunId: string; targetUrl: string; fixtures: FixtureStore; log: (l: string) => void }): Promise<DiffBundle> {
	const { fixtures, log } = opts;
	const fixtureHtml = (await fixtures.get(FIXTURE.html))?.value;
	if (typeof fixtureHtml !== "string") throw new Error("no fixture-html in the agent store: the build session did not run");
	const selectors = ((await fixtures.get(FIXTURE.selectors))?.value as Record<string, string> | undefined) ?? {};
	const now = await fetchTargetPage(opts.targetUrl);
	const before = pageFacts(fixtureHtml, selectors);
	const after = pageFacts(now, selectors);
	const selectorMatches = Object.entries(selectors).map(([field, selector]) => {
		const a = before.selectorMatches[field] ?? 0;
		const b = after.selectorMatches[field] ?? 0;
		const verdict = b === 0 && a > 0 ? "MISSING" : b === a ? "still matches" : b < a ? "fewer" : "more";
		return { field, selector, atBuildTime: a, now: b, verdict } as DiffBundle["selectorMatches"][number];
	});
	const newClasses = after.classes.filter((c) => !before.classes.includes(c));
	const removedClasses = before.classes.filter((c) => !after.classes.includes(c));
	const failed: RunStats = await readRun(opts.failedRunId);
	const afterUrl = await fixtures.put(`incident-${opts.failedRunId}-screenshot.svg`, renderPageSvg(now, `now (failed run ${opts.failedRunId})`), "image/svg+xml");
	const bundle: DiffBundle = {
		failedRunId: opts.failedRunId,
		computedAt: new Date().toISOString(),
		targetUrl: opts.targetUrl,
		selectors,
		selectorMatches,
		newScripts: after.scripts.filter((s) => !before.scripts.includes(s)),
		removedScripts: before.scripts.filter((s) => !after.scripts.includes(s)),
		newClasses,
		removedClasses,
		suspiciousNewClasses: newClasses.filter((c) => SUSPICIOUS.test(c)),
		newIds: after.ids.filter((i) => !before.ids.includes(i)),
		failedRun: { status: failed.status, itemCount: failed.itemCount, fillRates: failed.fillRates, diagnosis: failed.diagnosis, buildNumber: failed.buildNumber },
		screenshots: { before: fixtures.url(FIXTURE.screenshot), after: afterUrl },
		bytes: { before: fixtureHtml.length, now: now.length },
	};
	await fixtures.put(`incident-${opts.failedRunId}`, bundle, "application/json");
	for (const line of summarize(bundle)) log(line);
	return bundle;
}

export function summarize(b: DiffBundle): string[] {
	const lines = [
		`=== DIFF BUNDLE (deterministic, computed before any model call) for failed run ${b.failedRunId} ===`,
		`page: ${b.targetUrl} (${b.bytes.before} bytes at build time, ${b.bytes.now} now)`,
		"selectors from the build-time fixture:",
		...b.selectorMatches.map((m) => `  ${m.field.padEnd(7)} ${m.selector.padEnd(14)} build time: ${m.atBuildTime} matches, now: ${m.now}  -> ${m.verdict}`),
		`new script tags: ${b.newScripts.length ? b.newScripts.join(", ") : "none"}`,
		`new class names: ${b.newClasses.length ? b.newClasses.join(", ") : "none"}${b.suspiciousNewClasses.length ? `  (suspicious: ${b.suspiciousNewClasses.join(", ")})` : ""}`,
		`removed class names: ${b.removedClasses.length ? b.removedClasses.join(", ") : "none"}`,
		`new element ids: ${b.newIds.length ? b.newIds.join(", ") : "none"}`,
		`failed run: ${b.failedRun.status}, ${b.failedRun.itemCount} items, fill rates ${JSON.stringify(b.failedRun.fillRates)}`,
		`diagnosis: ${JSON.stringify(b.failedRun.diagnosis)}`,
		`screenshots: before ${b.screenshots.before}  after ${b.screenshots.after}`,
		"=== end of diff bundle ===",
	];
	return lines;
}

/** What the model reads as the incident. Facts only; no interpretation. */
export function incidentText(b: DiffBundle): string {
	return [
		`INCIDENT (computed by the platform, not by a model) for scraper run ${b.failedRunId}.`,
		...summarize(b).slice(1, -1),
		"The screenshots are SVG renders of the parsed page (before = build-time fixture, after = now).",
		"Before calling any tool: in one paragraph, recall from your handoff note which selector you chose for the affected field and which alternative you rejected and why, then relate that to the changes above.",
	].join("\n");
}
