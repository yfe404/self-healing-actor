// Records a narrated demo video of Beats 1-5 running live on the Apify platform.
// Usage: APIFY_TOKEN=.. npx tsx record.ts            -> self-healing-actor-demo.mp4 in this directory
// Real things on screen: the target site, the run logs (fetched from the Apify API), the agent's KV store,
// the steer page served by the repair run (typed into and clicked like a person would). Cards are local HTML.
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
	{ id: "title", caption: "A scraper on Apify that fixes itself when the website changes", narration: "This is a demo of a scraper on Apify that fixes itself. The website it scrapes changes, the scraper breaks, and an AI agent, a program that uses a language model plus a set of tools, wakes up, works out what changed, fixes the scraper, and asks a person for approval before the fix goes live. Everything you will see runs on the Apify platform. Nothing runs on a laptop." },
	{ id: "cast", caption: "Four pieces: the website, the scraper, the repair agent, and a web page to talk to it", narration: "Four pieces. The website is a page of twenty products that we host ourselves, so we can change it on purpose. The scraper is an ordinary Apify Actor; its scheduled runs use the version of the code labelled prod, short for production. The repair agent is another Actor. Its memory lives in an Apify key-value store, a simple place to keep named records, with one record for every step it takes. And a web page, served by the repair agent while it runs, where anyone with the link can watch it work, send it a message, and approve its fix." },
	{ id: "site-a", caption: "The website as the agent first saw it: each product has a name, a price, and a rating", narration: "Here is the website as it looked when the agent first built the scraper. Each product has a name, a price in an element marked price tag, and a rating." },
	{ id: "flip", caption: "Step 1: the website owner changes the page layout", narration: "Step one. The website owner changes the layout. In this demo that is one setting, changed by someone other than the presenter." },
	{ id: "site-b", caption: "The new layout: the price is marked differently, and a cookie banner covers the list", narration: "The page now looks like this. The price tag marker is gone, the price is split into new pieces, and a cookie banner covers the list. Nothing else was touched." },
	{ id: "red", caption: "The scraper's scheduled run fails: it found no prices", narration: "The scraper's scheduled run starts. It checks its own results before finishing. Every price is missing, so instead of quietly delivering bad data it stops, records why, and shows up red in the Apify console." },
	{ id: "repair-log", caption: "Step 2: the failed run automatically starts the repair agent. First, plain code lists what changed", narration: "Step two. The failed run automatically starts the repair agent. Watch its log. First it prints the links where people can reach it. Then it loads its memory from the key-value store. Then, before asking the language model anything, plain code compares the page with the copy the agent saved when it built the scraper: which markers are gone, which scripts and names are new, how many prices the failed run found, and a pair of before and after pictures. Only then is the agent given the case." },
	{ id: "shots", caption: "Before and after pictures of the page", narration: "The before and after pictures are drawn from the page's code. The cookie banner and the new price layout are visible at a glance." },
	{ id: "abort", caption: "Step 3: someone stops the repair run while the agent is in the middle of its work", narration: "Step three. While the agent is rebuilding the scraper, a skeptic stops the run from the console. The computer running the agent is killed in the middle of a step." },
	{ id: "memory", caption: "The agent's memory is a key-value store: one record per step, plus the saved page and the case file", narration: "The run is gone. The memory is not. This is the agent's key-value store in the console: one record for every step it took, a summary record every twenty-five steps so it starts quickly, the copy of the page it saved when it built the scraper, and the case file written a minute ago. Each record is plain readable text." },
	{ id: "resume", caption: "The presenter starts the repair agent again with the same input: it picks up where it left off", narration: "The presenter starts the repair agent again with the same input. On startup it prints what was finished and what was in progress when it was killed. The interrupted step is marked as interrupted and redone; everything that was finished stays finished. It picks up the same case where it left off. The link to its web page changed, because it is a new run, so there is also a permanent link that always points to the current run." },
	{ id: "steer-first", caption: "The agent's web page: its own notes from when it built the scraper, the case file, and its first reply", narration: "This is the agent's web page, served by the new run. Because the memory is shared, it shows everything from before the stop. The first entry is the note the agent wrote to itself when it built the scraper. Then the case file, which came from the platform, not from a person. Then the agent's first reply. It remembers that it chose the price tag marker back then and rejected another one called amount, because amount only appeared on seven of twenty products. That reasoning comes from its own notes, not from anything we wrote for the demo." },
	{ id: "steer", caption: "Step 4: someone in the audience sends the agent a message while it works", narration: "Step four. Someone in the audience opens the permanent link in their own browser and types a message: the site also added a cookie banner, handle it. The message is saved to the agent's memory, and the agent reads it at its next step without interrupting what it is doing." },
	{ id: "gate", caption: "Step 5: the agent fixes the code, builds it, tests it on the live site, then waits for a person to approve", narration: "Step five. The agent changes the scraper's code, builds it, runs the new build once against the live website as a test, and compares the result with the sample it saved when it built the scraper. Then it asks for approval. The tool that puts the fix into production only works after a person has approved. The agent cannot do it on its own." },
	{ id: "approve", caption: "A person approves from the web page; the approval is saved, so even a crash would not ask twice", narration: "A person clicks approve and gives their name. The approval is saved in the agent's memory, so even if the run crashed right now, the next run would carry on and put the fix live without asking again. The production label now points at the new build." },
	{ id: "report", caption: "The run ends with a short report", narration: "The run ends with a short report: what changed on the site, what the agent did, who approved and when, how long it took including the restart, and how much compute it used." },
	{ id: "green", caption: "The scraper's next scheduled run works again", narration: "The scraper's next scheduled run works again, with every price filled in." },
	{ id: "close", caption: "Why this matters", narration: "Without this, a broken scraper is a red run and a ticket for a developer. With it, the platform works out what changed for free, the agent that built the scraper wakes up with its own notes, people can watch it, stop it, restart it, and talk to it from a browser, and nothing goes live without a named person approving. Two things are simplified in this demo: the before and after pictures are drawn from the page's code rather than taken with a browser, and the website is one we control. Everything else is real." },
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
			log(`tts retry ${attempt} for ${s.id}`);
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
	await show(termPage(title, ["(waiting for the run to start)"], current!.caption, tail));
	return until(`log of ${runId}`, maxMs, async () => {
		const text = await runLog(runId);
		const lines = cleanLog(text);
		await show(termPage(title, lines.length ? lines : ["(container starting…)"], current!.caption, tail));
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

await scene("title", async () => showCard(`<h1>A scraper that fixes itself</h1><p>When the website changes, an AI agent on Apify finds out what changed, fixes the scraper, and asks a person before the fix goes live.</p><p style="color:#9ecbff">Recorded live and unattended. Every action is an Apify API call or a click on the agent's own web page.</p>`));
await scene("cast", async () =>
	showCard(`<h1>The cast</h1><div class="grid">
<div class="box"><h3>The website</h3><p>A page of 20 products that we host ourselves. One setting switches it between the old layout and the new one.</p></div>
<div class="box"><h3>The scraper</h3><p>An ordinary Apify Actor. Its scheduled runs use the code version labelled <code>prod</code> (production). It checks its own results.</p></div>
<div class="box"><h3>The repair agent</h3><p>Another Actor: a language model with tools. Its memory is an Apify key-value store, one record per step. A failed scraper run starts it automatically.</p></div>
<div class="box"><h3>The web page</h3><p>Served by the repair agent while it runs: watch it work live, send it a message, approve its fix.</p></div></div>`),
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
	await showCard(`<h1>Step 1: the website owner changes the layout</h1><p>One setting in a key-value store: record <code>variant</code>, a = old layout, b = new layout</p><div class="json">before: ${esc(before)}\nafter:  ${esc(after)}</div><p style="color:#9ecbff">In the Apify console: open the store, click the record, change "a" to "b", save.</p>`);
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
	await liveLog(repair1.id, `Repair run ${repair1.id}, started automatically by the failed run  [Apify console > Runs > Log]`, (t) => t.includes("waking the agent"), 120_000);
	await sleep(4000);
});
await scene("shots", async () => {
	const before = await fetch(`https://api.apify.com/v2/key-value-stores/${MEMORY_STORE}/records/fixture-screenshot.svg`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
	const after = await fetch(`https://api.apify.com/v2/key-value-stores/${MEMORY_STORE}/records/incident-${redId}-screenshot.svg`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.text());
	await showCard(`<h2>Before (saved when the scraper was built) and after (now), drawn from the page's code</h2><div class="grid" style="grid-template-columns:1fr 1fr"><div class="box" style="padding:8px;height:520px;overflow:hidden;background:#fff">${before}</div><div class="box" style="padding:8px;height:520px;overflow:hidden;background:#fff">${after}</div></div>`);
});
await scene("abort", async () => {
	await abortWatcher;
	await showCard(`<h1>Step 3: stop the run</h1><p>Apify console > repair run ${repair1!.id} > <b>Abort</b></p><p id="st" style="color:#ff7b72">status: stopping…</p>`);
	await until("ABORTED", 120_000, async () => (await runStatus(repair1!.id)) === "ABORTED");
	await page.evaluate(() => {
		const el = document.getElementById("st");
		if (el) el.textContent = "status: ABORTED. The computer that ran the agent is gone.";
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
	await showCard(`<h2>The agent's memory: key-value store shd-agent-memory-ctzTh4lGVmdeKVFDl  [Apify console > Storage]</h2><div class="grid" style="grid-template-columns:1.1fr 1fr"><div class="box"><table><tr><th>records</th><th>count</th><th>what</th></tr><tr><td>log-000000001 … ${esc(newest.key)}</td><td>${logs.length}</td><td>one record per step</td></tr><tr><td>snapshot-…</td><td>${snaps.length}</td><td>summary every 25 steps</td></tr>${others.map((k) => `<tr><td>${esc(k.key)}</td><td>${k.size} B</td><td>${k.key.startsWith("fixture") ? "saved when the scraper was built" : k.key.startsWith("incident") ? "the case file" : k.key.startsWith("repair-conversation") ? "which conversation handles which case" : ""}</td></tr>`).join("")}</table></div><div class="box"><h3>${esc(newest.key)} (newest step)</h3><div class="json">${esc(json)}</div></div></div>`);
});
let repair2 = "";
let steerUrl = "";
await scene("resume", async () => {
	const input = (await client.keyValueStore((await client.run(repair1!.id).get())!.defaultKeyValueStoreId).getRecord("INPUT"))?.value as object;
	const r = await client.actor(REPAIR).start(input);
	repair2 = r.id;
	await liveLog(repair2, `Repair run ${repair2}, started again with the same input  [Apify console > Actor > Start]`, (t) => t.includes("waiting for the agent to finish"), 120_000, 30);
	steerUrl = (await client.run(repair2).get())!.containerUrl ?? "";
	await sleep(3000);
});
await scene("steer-first", async () => {
	await until("steer page", 90_000, async () => (await fetch(steerUrl).then((r) => r.status).catch(() => 0)) === 200);
	await page.goto(steerUrl, { waitUntil: "load" });
	await until("first assistant message on the steer page", 120_000, async () => {
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
	await until("steer page", 90_000, async () => (await fetch(steerUrl).then((r) => r.status).catch(() => 0)) === 200);
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
	await showCard(`<h2>The report, stored in the run's dataset  [Apify console > Runs > Dataset]</h2><div class="json">${esc(JSON.stringify(report, null, 2)).slice(0, 2600)}</div>`);
});
await scene("green", async () => {
	const g = await client.actor(SCRAPER).start({}, { build: "prod" });
	await until("green run", 180_000, async () => ["FAILED", "SUCCEEDED"].includes(await runStatus(g.id)));
	const d = (await client.run(g.id).get())!;
	const items = (await client.dataset(d.defaultDatasetId).listItems({ limit: 6 })).items;
	await show(termPage(`Scraper run ${g.id} (build prod → ${d.buildNumber}): status ${d.status}`, [...cleanLog(await runLog(g.id)), "", "first items of the dataset:", ...items.map((i) => JSON.stringify(i))], current!.caption));
});
await scene("close", async () =>
	showCard(`<h1>What you saw</h1><p>The website changed. The scraper failed and started the repair agent. Plain code listed what changed. The agent remembered why it built the scraper the way it did. It was stopped and restarted without losing anything. Someone sent it a message mid-work. It fixed and tested the code, a person approved, and the next scraper run worked.</p><p style="color:#9ecbff">Simplified: the before and after pictures are drawn from the page's code, and the website is ours. Everything else is real and ran unattended on Apify while this was recorded.</p><p class="dim" style="font-size:18px;color:#8b949e">Runs: red ${redId}, repair ${repair1?.id} → ${repair2}. Memory store ${MEMORY_STORE}.</p>`),
);
await sleep(1500);
const videoPath = await page.video()!.path();
await ctx.close();
await browser.close();
log(`recorded ${videoPath}; muxing`);
await writeFile(join(WORK, "marks.json"), JSON.stringify(marks, null, 1));

// ---------------------------------------------------------------- mux ---------------------------------------
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
