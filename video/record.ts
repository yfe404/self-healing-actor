// Record a narrated video of Steps 1 to 5 on the live Apify platform.
// Usage: APIFY_TOKEN=YOUR_TOKEN npx tsx record.ts -> self-healing-actor-demo.mp4 in this directory
// YOUR_TOKEN is your Apify API token. The recording shows the real target site, API run logs,
// agent key-value store, and agent web page. Local cards display text and live platform data.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ApifyClient } from "apify-client";
import { chromium, type Page } from "playwright-core";

const run = promisify(execFile);
const token = process.env.APIFY_TOKEN ?? "";
if (!token) throw new Error("APIFY_TOKEN missing");
const client = new ApifyClient({ token });
const SCRAPER = "straightforward_understanding/shd-scraper";
const REPAIR = "straightforward_understanding/shd-repair-agent";
const SITE = "https://straightforward-under--shd-target-site.apify.actor/";
const STABLE = "https://straightforward-under--shd-repair-link.apify.actor/";
const MEMORY_STORE = "iHR5PW7OXNXvrEBiC";
const ORIGINAL_PROD_BUILD = "x1nrd0s8qY8NVe6aK";
const STEER_TEXT = "the site also added a cookie banner, handle it";
const APPROVER = "Dana (audience)";
const OUT = import.meta.dirname;
const WORK = join(OUT, "work");
await mkdir(WORK, { recursive: true });

const t0 = Date.now();
const log = (line: string) => console.log(`[rec ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false>, every = 3000): Promise<T> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const v = await probe();
		if (v) return v;
		await sleep(every);
	}
	throw new Error(`timed out waiting for ${what}`);
}
const runLog = async (id: string) => (await client.run(id).log().get()) ?? "";
const runStatus = async (id: string) => (await client.run(id).get())?.status ?? "?";
const site = (path: string) => fetch(`${SITE}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------- narration -----------------------------------
type Scene = { id: string; caption: string; narration: string };
const SCENES: Scene[] = [
	{ id: "title", caption: "A scraper repair demo on Apify, with human approval before the fix goes live", narration: "This demo shows an AI agent repairing a scraper on Apify. The agent uses a language model and tools. When the website changes, the scraper fails. The agent works out what changed and fixes the code. A person approves before the fix goes live. The website, scraper, and repair agent run on Apify. A local recorder shows you their work." },
	{ id: "cast", caption: "Four pieces: the website, the scraper, the repair agent, and the agent web page", narration: "The website is a page of twenty products that we host ourselves. We can change its layout on purpose. The scraper is an Apify Actor. Its scheduled runs use a build, a packaged version of the code, labelled prod for production. The repair agent is another Actor. Its memory lives in an Apify key-value store, which holds named records. It saves one record per step. The agent web page lets anyone with the link watch, send a message, and approve a fix." },
	{ id: "site-a", caption: "The original page: each product has a name, a price, and a rating", narration: "This is the page layout the agent sees when it first builds the scraper. Each product has a name, a price, and a rating. The page marks the price element with the name price tag." },
	{ id: "flip", caption: "Step 1: the website owner changes the page layout", narration: "Step one. The website owner changes one setting to switch the layout. During a presentation, someone other than the presenter makes this change. This unattended recording uses the Apify API, the interface programs use to send platform requests." },
	{ id: "site-b", caption: "The new layout changes the price element and adds a cookie banner over the list", narration: "The price tag marker is gone. The page splits the price into new pieces and adds a cookie banner over the list. The scraper code stays unchanged." },
	{ id: "red", caption: "The scraper run fails because it finds no prices", narration: "The recorder starts the scraper to represent a scheduled run. The scraper checks its own results before finishing. Every price is missing, so it stops and records why. You see a failed run in Apify Console." },
	{ id: "repair-log", caption: "Step 2: the failed run starts the repair agent. Plain code lists the page changes first", narration: "Step two. The failed run starts the repair agent. Watch its log. The agent prints its web links and loads its memory from the key-value store. Plain code computes a page comparison before the model receives the incident, the stored information about this failure. It compares the live page with build references, the page copy and chosen element markers from the initial build. You see missing page markers, new scripts and names, the failed run's price results, and before and after pictures." },
	{ id: "shots", caption: "Before and after pictures drawn from the page code", narration: "The recorder shows before and after pictures drawn from the page code. These are generated drawings rather than browser screenshots. You can see the cookie banner and the changed price layout." },
	{ id: "abort", caption: "Step 3: stop the repair run while the agent works", narration: "Step three. The recorder stops the repair run while the agent works. This sends the same request as Abort in Apify Console. The computer running the agent stops in the middle of its work." },
	{ id: "memory", caption: "The key-value store keeps saved steps, build references, and the incident", narration: "The key-value store keeps the agent's memory after the run stops. You see one record per saved step. Every twenty-five steps, a combined record holds all steps so far to reduce startup reads. The store also keeps build references and the incident. You can read each record as text." },
	{ id: "resume", caption: "Restart the repair agent with the same input to continue the investigation", narration: "The recorder starts the repair agent again with the same input. The run prints the status of saved work before it continues. The agent framework, the code that manages the agent's work, can repeat tools marked safe to repeat. It reports other interrupted tools to the model. Finished tool calls stay finished. The investigation keeps the same conversation transcript. Each run has its own agent web page address. The permanent link keeps one address and opens the current repair run when one is active." },
	{ id: "steer-first", caption: "The agent web page shows saved build notes, the incident, and the first reply", narration: "The new run serves the agent web page. Shared memory lets you see entries from before the stop. First come the agent's saved build notes, the note it writes during the initial scraper build. Then you see the platform's incident and the agent's first reply. The agent recalls why it chose the price tag marker. It rejected amount because that marker appears on seven of twenty products. The reasoning comes from its saved build notes." },
	{ id: "steer", caption: "Step 4: send the agent a message while it works", narration: "Step four. An audience member can open the permanent link and send a message. The recorder types: the site also added a cookie banner, handle it. The agent saves the message in memory. It reads the message before its next response without interrupting its current work." },
	{ id: "gate", caption: "Step 5: the agent fixes and tests the code, then waits for approval", narration: "Step five. The agent changes the scraper code and builds it. A test run uses the new build against the live website. The agent compares the result with its build references. The approval check then waits for a person. The tool that puts the fix live requires a saved approval record." },
	{ id: "approve", caption: "Approve on the agent web page. The saved approval survives a restart", narration: "The recorder clicks Approve and enters a person's name. The agent saves the approval in memory. If the run stops after approval, a restart can put the fix live without asking again. The production build label now points to the new build." },
	{ id: "report", caption: "The run ends with a repair report", narration: "The report lists the site's changes, the agent's actions, the approver's name, and the approval time. It includes elapsed time across the restart and the compute used by this run." },
	{ id: "green", caption: "The next scraper run works with prices filled in", narration: "The recorder starts the scraper again to represent its next scheduled run. The scraper succeeds with every price filled in." },
	{ id: "close", caption: "The repair process and its demo simplifications", narration: "A failed scraper run starts a repair investigation. Plain code lists page changes without a model call. The agent uses its saved build notes to fix and test the scraper. You can watch, stop, restart, and message it from a browser. The approval check requires a saved approval before the fix goes live. The demo uses a website we control and draws page pictures from its code. The recording uses live platform data and automates the presentation actions." },
];
const audio = new Map<string, { file: string; seconds: number }>();
for (const s of SCENES) {
	const file = join(WORK, `${s.id}.mp3`);
	for (let attempt = 1; ; attempt++) {
		try {
			await run("uvx", ["edge-tts", "--voice", "en-US-AndrewNeural", "--rate", "+5%", "--text", s.narration, "--write-media", file]);
			break;
		} catch (error) {
			if (attempt >= 4) throw error;
			log(`speech generation retry ${attempt} for ${s.id}`);
			await sleep(3000 * attempt);
		}
	}
	const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
	audio.set(s.id, { file, seconds: Number(stdout.trim()) });
}
log(`narration ready: ${[...audio.values()].reduce((a, b) => a + b.seconds, 0).toFixed(0)}s total`);

// ---------------------------------------------------------------- pages ---------------------------------------
const CSS = `<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e8e8e8;width:1280px;height:720px;overflow:hidden;position:relative}
.card{padding:56px 72px}h1{font-size:46px;margin:0 0 18px}h2{font-size:30px;margin:0 0 14px;color:#9ecbff}p{font-size:24px;line-height:1.4;margin:8px 0}
.cap{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.82);color:#fff;font-size:22px;padding:14px 28px;line-height:1.3;border-top:2px solid #4a90e2}
.term{background:#0b0e13;color:#d6d6d6;font:15px/1.35 ui-monospace,Menlo,monospace;padding:16px 22px;height:620px;overflow:hidden;white-space:pre-wrap;word-break:break-all}
.term .hl{color:#ffd166}.term .ok{color:#7ee787}.term .bad{color:#ff7b72}.term .dim{color:#8b949e}
.bar{background:#1b1f27;color:#cfd8e3;font-size:18px;padding:10px 22px;border-bottom:1px solid #2b3040}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:10px}.box{background:#1b1f27;border:1px solid #2b3040;border-radius:10px;padding:18px 22px}.box h3{margin:0 0 8px;font-size:24px;color:#9ecbff}.box p{font-size:19px;margin:4px 0}
table{border-collapse:collapse;font-size:18px}td,th{padding:6px 14px;border-bottom:1px solid #2b3040;text-align:left}th{color:#9ecbff}
.json{font:15px/1.35 ui-monospace,monospace;white-space:pre-wrap;background:#0b0e13;padding:14px;border-radius:8px;max-height:430px;overflow:hidden}
</style>`;
const cap = (text: string) => `<div class="cap">${esc(text)}</div>`;
const card = (body: string, caption: string) => `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body><div class="card">${body}</div>${cap(caption)}</body></html>`;
const colorize = (line: string) => {
	const e = esc(line);
	if (/FAILED|MISSING|ERROR|abort/i.test(line)) return `<span class="bad">${e}</span>`;
	if (/SUCCEEDED|PASS|PROMOTED|approved|green/.test(line)) return `<span class="ok">${e}</span>`;
	if (/DIFF BUNDLE|task tree|gate:|REPORT|STEER|resuming|forked|incident submitted|memory recovered|interrupted|abandoning/.test(line)) return `<span class="hl">${e}</span>`;
	if (/^\s*\[kv-storage\]|snapshot written/.test(line)) return `<span class="dim">${e}</span>`;
	return e;
};
const cleanLog = (text: string) =>
	text
		.split("\n")
		.filter((l) => !/transcript:|DeprecationWarning|trace-deprecation|System info|Pulling container|Creating container|Starting container|^\s*$/.test(l))
		.map((l) => l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z /, "").replace(/\u001b\[[0-9;]*m/g, ""));
const termPage = (title: string, lines: string[], caption: string, tail = 38) =>
	`<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body><div class="bar">${esc(title)}</div><div class="term" id="t">${lines.slice(-tail).map((l) => colorize(l.length > 230 ? `${l.slice(0, 230)}…` : l)).join("\n")}</div>${cap(caption)}</body></html>`;

// ---------------------------------------------------------------- recording -----------------------------------
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: WORK, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept(APPROVER));
let videoStart = 0;
const marks: { id: string; at: number }[] = [];
let current: Scene | undefined;
async function scene(id: string, action: (s: Scene) => Promise<void>, minSeconds?: number): Promise<void> {
	const s = SCENES.find((x) => x.id === id);
	if (!s) throw new Error(`no scene ${id}`);
	current = s;
	const started = Date.now();
	marks.push({ id, at: (started - videoStart) / 1000 });
	log(`scene ${id}`);
	await action(s);
	const need = Math.max(minSeconds ?? 0, (audio.get(id)?.seconds ?? 0) + 0.8) * 1000 - (Date.now() - started);
	if (need > 0) await sleep(need);
}
const show = async (html: string) => page.setContent(html, { waitUntil: "load" });
const showCard = (body: string) => show(card(body, current!.caption));
async function liveLog(runId: string, title: string, done: (text: string) => boolean, maxMs: number, tail = 38): Promise<string> {
	await show(termPage(title, ["Waiting for the run to start"], current!.caption, tail));
	return until(`log of ${runId}`, maxMs, async () => {
		const text = await runLog(runId);
		const lines = cleanLog(text);
		await show(termPage(title, lines.length ? lines : ["Starting the run's computer…"], current!.caption, tail));
		return done(text) ? text : undefined;
	}, 2500);
}
async function injectCaption(text: string): Promise<void> {
	await page.evaluate((t) => {
		let el = document.getElementById("__cap");
		if (!el) {
			el = document.createElement("div");
			el.id = "__cap";
			el.style.cssText = "position:fixed;left:0;right:0;bottom:62px;background:rgba(0,0,0,.82);color:#fff;font:22px/1.3 system-ui,sans-serif;padding:14px 28px;border-top:2px solid #4a90e2;z-index:99999;pointer-events:none";
			document.body.appendChild(el);
		}
		el.textContent = t;
	}, text);
}
async function reset(): Promise<void> {
	await site("variant?set=a");
	const original = await readFile(join(OUT, "..", "actors", "scraper", "selectors.js"), "utf8");
	const actor = (await client.actor(SCRAPER).get())!;
	const version = await client.actor(SCRAPER).version("0.0").get();
	const files = ((version as { sourceFiles?: { name: string; content: string }[] })?.sourceFiles ?? []).map((f) => (f.name === "selectors.js" ? { ...f, content: original } : f));
	await client.actor(SCRAPER).version("0.0").update({ sourceFiles: files } as never);
	const build = await client.build(ORIGINAL_PROD_BUILD).get();
	await client.actor(SCRAPER).update({ taggedBuilds: { ...((actor as { taggedBuilds?: object }).taggedBuilds ?? {}), prod: { buildId: ORIGINAL_PROD_BUILD, buildNumber: build?.buildNumber } } } as never);
}
async function findRepairRun(failedRunId: string, notBefore: number) {
	const runs = await client.actor(REPAIR).runs().list({ desc: true, limit: 10 });
	for (const r of runs.items) {
		if (new Date(r.startedAt).getTime() < notBefore) continue;
		const d = await client.run(r.id).get();
		const input = (await client.keyValueStore(d!.defaultKeyValueStoreId).getRecord("INPUT"))?.value as { failedRunId?: string } | undefined;
		if (input?.failedRunId === failedRunId) return { id: r.id, containerUrl: d!.containerUrl ?? "" };
	}
	return undefined;
}

log("reset to baseline");
await reset();
await show(card("<h1></h1>", ""));
await sleep(600);
videoStart = Date.now();

await scene("title", async () => showCard(`<h1>A scraper repair demo</h1><p>When the website changes, an AI agent on Apify identifies the page changes, fixes the scraper, and asks a person before the fix goes live.</p><p style="color:#9ecbff">Recorded live and unattended. The recorder sends requests to Apify and clicks the agent web page.</p>`));
await scene("cast", async () =>
	showCard(`<h1>The four pieces</h1><div class="grid">
<div class="box"><h3>The website</h3><p>A page of 20 products that we host ourselves. One setting switches it between the old layout and the new one.</p></div>
<div class="box"><h3>The scraper</h3><p>An Apify Actor that checks its own results. Scheduled runs use the build labelled <code>prod</code>, short for production. A build packages the code for a run.</p></div>
<div class="box"><h3>The repair agent</h3><p>Another Actor: a language model with tools. Its memory is an Apify key-value store, which holds named records. A failed scraper run starts it.</p></div>
<div class="box"><h3>The agent web page</h3><p>The repair agent serves this page while it runs. You can watch it work, send it a message, and approve its fix.</p></div></div>`),
);
await scene("site-a", async () => {
	await page.goto(`${SITE}?token=${token}`, { waitUntil: "load" });
	await injectCaption(current!.caption);
});
let failedAt = 0;
await scene("flip", async () => {
	const before = await site("variant");
	const after = await site("variant?set=b");
	failedAt = Date.now();
	await showCard(`<h1>Step 1: the website owner changes the layout</h1><p>The <code>variant</code> record selects the layout: a = old, b = new.</p><div class="json">before: ${esc(before)}\nafter:  ${esc(after)}</div><p style="color:#9ecbff">In Apify Console:</p><ol><li>Open the store.</li><li>Open the <code>variant</code> record.</li><li>Change "a" to "b".</li><li>Save the record.</li></ol>`);
});
await scene("site-b", async () => {
	await page.goto(`${SITE}?token=${token}`, { waitUntil: "load" });
	await injectCaption(current!.caption);
});
let redId = "";
await scene("red", async () => {
	const red = await client.actor(SCRAPER).start({}, { build: "prod" });
	redId = red.id;
	await liveLog(redId, `Scraper run ${redId} (build prod)  [Apify Console > Runs > Log]`, (t) => /Output validation failed/.test(t), 180_000);
	await until("red run to finish", 180_000, async () => ["FAILED", "SUCCEEDED"].includes(await runStatus(redId)));
	const text = await runLog(redId);
	await show(termPage(`Scraper run ${redId} (build prod): status FAILED  [Apify Console > Runs > Log]`, cleanLog(text), current!.caption));
});
let repair1: { id: string; containerUrl: string } | undefined;
let abortWatcher: Promise<void> = Promise.resolve();
await scene("repair-log", async () => {
	repair1 = await until("webhook to start the repair run", 120_000, () => findRepairRun(redId, failedAt), 4000);
	abortWatcher = until("abort point", 180_000, async () => (await runLog(repair1!.id)).includes("scraper source written"), 1500)
		.catch(() => log("abort point not seen; aborting anyway"))
		.then(async () => {
			await client.run(repair1!.id).abort();
			log(`aborted ${repair1!.id} at the abort point`);
		});
	await liveLog(repair1.id, `Repair run ${repair1.id}, started automatically by the failed run  [Apify Console > Runs > Log]`, (t) => t.includes("waking the agent"), 120_000);
	await sleep(4000);
});
await scene("shots", async () => {
	const before = await fetch(`https://api.apify.com/v2/key-value-stores/${MEMORY_STORE}/records/fixture-screenshot.svg`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
	const after = await fetch(`https://api.apify.com/v2/key-value-stores/${MEMORY_STORE}/records/incident-${redId}-screenshot.svg`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
	await showCard(`<h2>Page drawings: the saved build layout and the current layout</h2><div class="grid" style="grid-template-columns:1fr 1fr"><div class="box" style="padding:8px;height:520px;overflow:hidden;background:#fff">${before}</div><div class="box" style="padding:8px;height:520px;overflow:hidden;background:#fff">${after}</div></div>`);
});
await scene("abort", async () => {
	await abortWatcher;
	await showCard(`<h1>Step 3: stop the run</h1><p>To stop repair run ${repair1!.id}, click <b>Abort</b> in Apify Console.</p><p id="st" style="color:#ff7b72">status: stopping…</p>`);
	await until("ABORTED", 120_000, async () => (await runStatus(repair1!.id)) === "ABORTED");
	await page.evaluate(() => {
		const el = document.getElementById("st");
		if (el) el.textContent = "status: ABORTED. The agent's computer stops.";
	});
	const text = await runLog(repair1!.id);
	await sleep(1500);
	await show(termPage(`Repair run ${repair1!.id}: ABORTED  [the log stops in the middle of a step]`, cleanLog(text), current!.caption));
});
await scene("memory", async () => {
	const keys = (await client.keyValueStore(MEMORY_STORE).listKeys({ limit: 1000 })).items;
	const logs = keys.filter((k) => k.key.startsWith("log-"));
	const snaps = keys.filter((k) => k.key.startsWith("snapshot-"));
	const others = keys.filter((k) => !k.key.startsWith("log-") && !k.key.startsWith("snapshot-"));
	const newest = logs[logs.length - 1]!;
	const rec = await client.keyValueStore(MEMORY_STORE).getRecord(newest.key);
	const json = JSON.stringify(rec?.value, null, 1).slice(0, 1400);
	await showCard(`<h2>The agent's memory: key-value store shd-agent-memory-ctzTh4lGVmdeKVFDl  [Apify Console > Storage]</h2><div class="grid" style="grid-template-columns:1.1fr 1fr"><div class="box"><table><tr><th>records</th><th>count</th><th>what</th></tr><tr><td>log-000000001 … ${esc(newest.key)}</td><td>${logs.length}</td><td>one record per saved step</td></tr><tr><td>snapshot-…</td><td>${snaps.length}</td><td>all saved steps, combined every 25 steps</td></tr>${others.map((k) => `<tr><td>${esc(k.key)}</td><td>${k.size} B</td><td>${k.key.startsWith("fixture") ? "build references" : k.key.startsWith("incident") ? "the incident" : k.key.startsWith("repair-conversation") ? "which conversation handles which failure" : ""}</td></tr>`).join("")}</table></div><div class="box"><h3>${esc(newest.key)} (newest step)</h3><div class="json">${esc(json)}</div></div></div>`);
});
let repair2 = "";
let steerUrl = "";
await scene("resume", async () => {
	const input = (await client.keyValueStore((await client.run(repair1!.id).get())!.defaultKeyValueStoreId).getRecord("INPUT"))?.value as object;
	const r = await client.actor(REPAIR).start(input);
	repair2 = r.id;
	await liveLog(repair2, `Repair run ${repair2}, started again with the same input  [Apify Console > Actor > Start]`, (t) => t.includes("waiting for the agent to finish"), 120_000, 30);
	steerUrl = (await client.run(repair2).get())!.containerUrl ?? "";
	await sleep(3000);
});
await scene("steer-first", async () => {
	await until("agent web page", 90_000, async () => (await fetch(steerUrl).then((r) => r.status).catch(() => 0)) === 200);
	await page.goto(steerUrl, { waitUntil: "load" });
	await until("first agent message on the agent web page", 120_000, async () => {
		const n = await page.locator(".ev.assistant").count();
		return n > 0;
	}, 2000);
	await injectCaption(current!.caption);
	await page.evaluate(() => {
		const l = document.getElementById("log");
		if (l) l.scrollTop = 0;
	});
	await sleep(6000);
	await page.evaluate(() => {
		const inc = document.querySelector(".ev.incident");
		inc?.scrollIntoView({ block: "start" });
	});
	await sleep(8000);
	await page.evaluate(() => {
		const a = document.querySelector(".ev.assistant");
		a?.scrollIntoView({ block: "start" });
	});
});
await scene("steer", async () => {
	await until("agent web page", 90_000, async () => (await fetch(steerUrl).then((r) => r.status).catch(() => 0)) === 200);
	await page.goto(`${STABLE}?token=${token}`, { waitUntil: "load" }).catch(() => page.goto(steerUrl, { waitUntil: "load" }));
	if (!page.url().startsWith(steerUrl)) await page.goto(steerUrl, { waitUntil: "load" });
	await sleep(2000);
	await injectCaption(current!.caption);
	await page.locator("#t").pressSequentially(STEER_TEXT, { delay: 45 });
	await sleep(600);
	await page.locator("#f button[type=submit], #f button:not(#approve)").first().click();
	await sleep(3000);
});
await scene("gate", async () => {
	await until("gate waiting", 600_000, async () => (await runLog(repair2)).includes("gate: WAITING FOR APPROVAL"), 3000);
	await injectCaption(current!.caption);
	await page.evaluate(() => {
		const l = document.getElementById("log");
		if (l) l.scrollTop = l.scrollHeight;
	});
});
await scene("approve", async () => {
	await page.locator("#approve").click();
	await until("PROMOTED", 180_000, async () => (await runLog(repair2)).includes("PROMOTED"), 2000);
	await page.evaluate(() => {
		const l = document.getElementById("log");
		if (l) l.scrollTop = l.scrollHeight;
	});
	await sleep(3000);
	const text = await runLog(repair2);
	await show(termPage(`Repair run ${repair2}  [the wait for approval, the approval, the fix going live]`, cleanLog(text).filter((l) => /gate|APPROVED|PROMOTED|STEER|canary|compare|build|status:|REPORT/.test(l)), current!.caption, 30));
});
await scene("report", async () => {
	await until("run finished", 300_000, async () => ["SUCCEEDED", "FAILED"].includes(await runStatus(repair2)));
	const d = (await client.run(repair2).get())!;
	const report = (await client.dataset(d.defaultDatasetId).listItems()).items[0];
	await showCard(`<h2>The report, stored in the run's dataset  [Apify Console > Runs > Dataset]</h2><div class="json">${esc(JSON.stringify(report, null, 2)).slice(0, 2600)}</div>`);
});
await scene("green", async () => {
	const g = await client.actor(SCRAPER).start({}, { build: "prod" });
	await until("green run", 180_000, async () => ["FAILED", "SUCCEEDED"].includes(await runStatus(g.id)));
	const d = (await client.run(g.id).get())!;
	const items = (await client.dataset(d.defaultDatasetId).listItems({ limit: 6 })).items;
	await show(termPage(`Scraper run ${g.id} (build prod → ${d.buildNumber}): status ${d.status}`, [...cleanLog(await runLog(g.id)), "", "first items of the dataset:", ...items.map((i) => JSON.stringify(i))], current!.caption));
});
await scene("close", async () =>
	showCard(`<h1>The repair process</h1><p>The website changes. The scraper fails and starts the repair agent. Plain code lists the changes. Saved build notes guide the investigation. A restart keeps the saved work. A message reaches the agent while it works. The agent fixes and tests the code. A person approves before the next scraper run succeeds.</p><p style="color:#9ecbff">Simplified: the website is ours, and the page pictures are drawings. The recorder automates the presentation actions and displays live platform data.</p><p class="dim" style="font-size:18px;color:#8b949e">Runs: failed ${redId}, repair ${repair1?.id} → ${repair2}. Memory store ${MEMORY_STORE}.</p>`),
);
await sleep(1500);
const videoPath = await page.video()!.path();
await ctx.close();
await browser.close();
log(`recorded ${videoPath}. Combining video and narration`);
await writeFile(join(WORK, "marks.json"), JSON.stringify(marks, null, 1));

// Combine video and narration.
const inputs: string[] = ["-i", videoPath];
const filters: string[] = [];
const labels: string[] = [];
marks.forEach((m, i) => {
	const a = audio.get(m.id)!;
	inputs.push("-i", a.file);
	const ms = Math.max(0, Math.round(m.at * 1000));
	filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
	labels.push(`[a${i}]`);
});
filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[a]`);
const out = join(OUT, "self-healing-actor-demo.mp4");
await run("ffmpeg", ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "128k", "-shortest", out], { maxBuffer: 64 * 1024 * 1024 });
const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
log(`done: ${out} (${Number(stdout).toFixed(0)}s)`);
await reset();
log("reset to baseline");
