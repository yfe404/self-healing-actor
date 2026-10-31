# Build the "self-healing Actor" demo (MVP, must work live)

You are building a demo, not a product. The only success criterion is that the demo script below runs end to end, live, three times in a row, with nothing running on a developer machine. Every hour spent on robustness, generality or cleanliness that the demo does not exercise is wasted. Hardcode IDs. Skip auth. Skip tests except one smoke script that drives the demo path. Prefer the ugliest thing that works over the elegant thing that might.

Read this whole file before writing code. Then read the Pi Durable README and its examples in the `packages/durable` directory of the earendil-works/pi repository, because the API is experimental and changes between releases; trust the README over anything written here about its API. Pin the exact Pi version you install.

## What we are demonstrating

An Apify Actor that was built by an agent. The agent's memory (conversation, task tree, handoff note with build decisions) lives in an Apify key-value store, not in a process. When the Actor breaks, a repair run starts. Before it wakes the agent, plain deterministic code in the repair Actor (no model involved) computes what changed: it re-fetches the target page and compares it against the fixtures the agent stored at build time (which selectors still match, which elements and scripts are new, screenshot then vs now), and reads the failed run's dataset and diagnosis to get field fill rates. It writes that "diff bundle" into the agent's conversation as the first entry, then wakes the agent. So the agent starts with the facts already in hand, and the model's first job is interpretation, not discovery. The agent then investigates, proposes a fix, canaries it, asks for approval, and promotes it. The repair run can be aborted mid-investigation and resumed with nothing lost. Several people can watch and steer the running agent at the same time, from any browser.

The substrate is Pi Durable (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`), running inside an Apify Actor. Apify primitives do the rest: KV store = memory, run log = audit trail, webhook = sensor, container URL = multiplayer surface.

## The demo script (this is the acceptance test)

Two roles. The **site owner** changes the site; in real life that is a third party we do not control, so in the demo it is played by someone other than the presenter (an audience member) or by a scheduled run, never by the presenter. The **platform** does everything else, and nothing runs on a developer machine: from the moment the site changes, every action (watching, aborting, restarting, steering, approving) is an Apify Console click or a public URL opened in any browser. No terminal, no local script, no SSH during the demo.

**Beat 1 — the site owner ships a redesign.** The site owner flips one value (a KV record on the target site's store) and the target site changes: the price element's class is renamed and a cookie banner appears. The scraper's next scheduled run fails its own output validation because price fill rate drops to 0%. The run shows red in Console. Nobody touches anything else.

**Beat 2 — the agent already knows.** A webhook on the failed run starts the repair Actor. Within 60 seconds of the run failing, the repair run's log shows, in this order: (a) a deterministic diff bundle computed *before* any model call — which selectors from the build-time fixture are now missing, which new scripts or elements appeared, field fill rates from the failed run's dataset, and a link to a before/after screenshot pair; (b) the agent's first message, which references its own build-time decision by name (for example: "I chose `.price-tag` at build time because `.amount` was unstable; `.price-tag` is now gone and there is a new `.product-price`"). That reference must come from the stored handoff note, not from a prompt we wrote for the demo.

**Beat 3 — kill and resume.** While the agent is mid-investigation, a skeptic aborts the repair run from the Console. The presenter opens the agent's KV store in Console and shows the commit-log records, then starts the repair Actor again with the same input. The run resumes from the stored checkpoint: finished tool calls stay finished, the interrupted tool call is reported to the model as interrupted, the agent inspects state and continues. The log must make the resume visible (print the task tree with statuses on startup).

**Beat 4 — steer from the audience.** A second person opens the repair run's public link in their own browser, sees the live event stream, and types "the site also added a cookie banner, handle it". The agent acknowledges the steer in its next turn and incorporates it into the fix.

**Beat 5 — gate and promote.** The agent edits the scraper source, builds it, runs the new build as a canary against the live site, compares the canary dataset to the build-time expected sample (schema and fill rates), and then *asks* for approval to promote. It cannot promote without approval; the approval survives an abort/resume (if the run is killed after approval and before promotion, it must not ask again). A human approves from the steer page. The scraper's next run is green. The repair run ends with a report in its dataset: what changed, what was done, who approved, elapsed time, and compute units used.

If any beat cannot be made reliable, say so immediately and propose the simplest cut, rather than silently weakening it.

## Components (keep each as small as it can be)

### 1. Target site — an Apify Standby Actor serving static HTML
The site the scraper scrapes is ours, so we can break it on cue. It is a Standby Actor that serves one HTML page with ~20 products (name, price, rating). It has two hardcoded markup variants: `a` is the original; `b` renames the price class, nests the price differently, and injects a cookie banner that overlays the list. On every request it reads one record, `variant`, from its own named KV store and serves that variant. "Breaking the site" in the demo is editing that record from `a` to `b`, either by hand in the Console (whoever plays the site owner) or by a tiny scheduled Actor that flips it at a set time so the change can happen with no human in the loop. Instant, no deploy, nothing that can fail. (A real git push to a static host is more convincing to an audience but adds 30–60 s of deploy latency and a failure point; if you can make it reliable, add it as an optional second path, otherwise skip it.)

### 2. Scraper Actor — the patient
Cheerio or Playwright, your call, whichever is less work. Its source type must be Apify's **"source files"** option (the one where the code lives in the Actor itself and is editable in the Console's code editor), not a Git repository. Reason: the repair agent then rewrites the scraper's files and starts a build through `apify-client` using only `APIFY_TOKEN`, with no GitHub credentials in the run and no PR plumbing. (A Git-backed Actor with the agent pushing a commit is the more realistic story for a real product, but it needs a GitHub token in the run and a push-triggered build; not for this MVP unless explicitly asked.) The scraper writes items to the default dataset and then validates its own output: if price fill rate is under 90% it writes a short diagnosis to the run's KV store and exits with failure. The scheduled run must use a build tag (say `prod`) that only changes when the repair agent promotes.

### 3. The build session — real, not faked
Build the scraper *through* the durable harness once, so the agent's memory is real: a conversation in the harness whose tools read the target site, write the scraper source, run it, and store fixtures. At the end of the build session the agent writes a handoff note (via the harness's reset-from-handoff mechanism) that records the selector decisions and why. Fixtures stored in the agent's KV store at build time: HTML snapshot of the page, a full-page screenshot, the expected output sample (first 5 items), and invariants (per-field fill rate thresholds, item count range). If running the real build proves too slow or flaky, seed the conversation with a realistic build transcript and handoff note, but the handoff note must contain the selector decision text that Beat 2 depends on. Document which path you took.

### 4. Repair Actor — the agent
A Node/TypeScript Actor that opens a Pi Durable harness.

- **Storage: an Apify key-value store, natively. No SQLite, no local files, no uploads of database blobs.** Implement a Pi Durable storage backend on top of a named Apify KV store and make it pass the storage conformance suite that ships with the package; that suite is the acceptance test for this component. Design it as a commit log: every committed task or transcript entry is one record under a zero-padded monotonic key (`log/000000123`), written as a single PUT so a commit is either fully present or absent; a `head` record is an optimisation only, and startup must derive the true head by listing `log/` keys. Add a `snapshot/<seq>` record every N commits holding the materialised state, so startup reads the latest snapshot plus the log tail instead of replaying from zero. Keep the working set in memory during a run; the KV store is the write-ahead log, read only at startup. No in-memory buffering of commits: a commit is not done until its PUT has returned. Each commit costs one or two HTTP calls, which is nothing next to a model call. Run the conformance suite locally against Apify's local storage emulation (`apify run` / `./storage`), then once against the real platform. Side benefit worth using in the demo: the agent's memory is browsable in Console, one record per step.
- **Identity.** One named KV store per (scraper Actor id) holds the agent. Input to the repair Actor: `{ actorId, failedRunId }`. The failed run id is the submission's request/operation id, so re-triggering for the same failed run resumes or returns the existing submission instead of starting a second investigation.
- **Single owner.** On startup, if another repair run for the same store is RUNNING (check via the Apify API, by a tag in the run input), exit immediately with a log line. No leases, no locks beyond this.
- **Diff bundle first.** Before submitting anything to the model: fetch the target page now, compare against the fixture (which fixture selectors still match; new script tags, new elements with class names containing price/cookie/consent/banner; screenshot now vs then), read the failed run's dataset and compute fill rates, read the failed run's diagnosis record. Store the bundle in the KV store, print a readable summary to the log, and submit it to the conversation as an entry with a custom kind (for example `apify.incident`), not as a user message, so the transcript shows it came from the platform.
- **Tools** (declare replay safety on each; reads are safe, writes are not): read fixtures, fetch URL, read run log/dataset, read scraper source, write scraper source (via Apify API), build scraper (returns build id), run canary (runs a given build against the live site with a small input, waits, returns dataset stats), compare canary to expected sample, request promotion (gated), write report. All actuator tools must be absolute-state writes so a replay cannot double-apply.
- **Gate.** A hook on the promote tool that blocks until approved, with the approval stored in a memo so a crash after approval does not re-ask. Approval arrives through the steer UI (an "Approve" button that posts to the run) or a Slack webhook if that is quick. Also a hard budget: max tool calls and max elapsed time per repair run; on exceeding it, write the report and stop.
- **Scope.** Run the investigation as a fork of the builder's conversation (so it sees the build history without copying it); the fork gets the promote tool only through the gate. If forking turns out to be awkward, run it in the main conversation and say so.
- **Resume visibility.** On startup print the task tree with statuses before continuing. This is the Beat 3 moment.

### 5. Steer and watch UI — one HTML page served by the repair run
How people reach the agent: every Apify run has a public URL (`APIFY_CONTAINER_URL`) that forwards HTTP to a port inside the container (`APIFY_CONTAINER_PORT`). The repair Actor starts a small HTTP server on that port and serves a single page. Anyone with the link opens it in a browser; it also renders inside Console under the run's **Live view** tab, so people in the Apify org can use it from the run detail page without the raw URL.

The page: a live stream of the conversation's events (`GET /events` over SSE: send the snapshot first, then each committed batch), a text box that posts to `POST /steer` which submits the text with `whenBusy: steer`, and an Approve button that posts to `POST /approve` and resolves the promotion gate's memo. Show the current task tree and status at the top. When a client connects mid-run it gets the current state, not a blank page. No auth (the link is the key), no styling beyond readable.

The URL changes every time the run is restarted after an abort, so also build a one-file Standby Actor at a stable URL that looks up the currently running repair run through the Apify API and redirects to its container URL; that stable link is what gets shared in the demo. Print both URLs at the top of the run log on every startup.

### 6. Sensor
An Apify webhook on the scraper Actor for `ACTOR.RUN.FAILED` that calls the repair Actor with `{ actorId, failedRunId }`. Also a "Resurrect" path: running the repair Actor manually with the same input resumes it (this is what the presenter does in Beat 3).

### 7. Runbook
`DEMO.md`: the exact clicks for each beat, in order, with expected timings, the URLs to open, what to say while waiting, and a fallback for each beat if it stalls. Include a `smoke.ts` that drives Beats 1–5 unattended (flip variant, trigger run, wait for failure, wait for repair, abort it, restart it, send a steer, approve, assert the next scraper run is green). The job is done when `smoke.ts` passes three times consecutively and you have run the manual runbook once yourself.

## Order of work (land the critical path first; each stage must be demoable on its own)

1. Target site with the variant flag + scraper with self-validation that fails on variant `b`. Show a red run.
2. The Apify-KV storage backend for Pi Durable, passing the conformance suite. Then the repair Actor skeleton on it, and prove abort/resume on the real platform with a dummy multi-step task before wiring anything else. This is the riskiest piece; do not proceed until it works.
3. Build session + fixtures + handoff note. Diff bundle. Beat 2 end to end (diagnosis only, no fix).
4. Fix tools: write source, build, canary, compare.
5. Steer UI. Beat 4.
6. Gate with memo + promote. Beat 5.
7. Runbook + smoke script + three consecutive passes.

Report after each stage with what works, what you faked, and what is fragile.

## Explicitly out of scope

Locking or leases beyond the "another run is active → exit" check. Secret scoping. Generalising to arbitrary Actors. The unblocker, Chromium, anti-bot anything. Retries and backoff beyond what Pi Durable gives you. Pretty UI. Unit tests. Multi-tenant anything. Cost optimisation.

## Known risks, and what to do about them

- Pi Durable API churn: pin the version, read the README first, and prefer its examples over your memory.
- Apify abort semantics: a hard abort can kill the container between a task starting and its commit landing; that is exactly the case Pi Durable's replay rules exist for, so do not add retries or buffering around it. Expect at most the last in-flight task to be redone or reported as interrupted.
- KV consistency: a commit must be one record; never split a commit across records. Derive the head from a key listing at startup rather than trusting the `head` record. If key listing turns out to be slow for long logs, that is what the snapshot records are for.
- KV rate and size limits: check the per-record size limit and keep large tool outputs (page HTML, screenshots) in their own records referenced from the commit, not inlined.
- Model latency: use a fast model for the diff-bundle narration turn and a strong model for the fix; set generous timeouts.
- Container URL: it only exists while the run is alive; print it on every startup since it changes after resume.

## Environment you can assume

`APIFY_TOKEN` with access to one Apify account, a model provider API key in env, Node 22+, TypeScript. Put all IDs (Actor ids, store names, build tag, model names) in one `config.ts`. Everything else, ask or decide and write the decision in `DECISIONS.md`.
