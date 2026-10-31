# Walkthrough: what happens, step by step

This page explains what you see when the scraper breaks and repairs itself, and why. It assumes you know what an Apify Actor is and roughly what an AI agent is. Every other term is explained the first time it appears. [Words used in this document](#words-used-in-this-document) collects them at the end.

The [README](README.md) explains how to install and run the project. The [video](video/self-healing-actor-demo.mp4) shows one complete pass in five minutes. [DECISIONS.md](DECISIONS.md) explains why things are built the way they are.

You can follow along in the Apify Console with your own deployment, or run `npx tsx scripts/smoke.ts`, which performs every step below through the API and checks each result. The Console links on this page point at the deployment described in [config.ts](config.ts). Replace the IDs with yours after [rebuilding in another account](README.md#rebuild-in-another-account).

## The pieces

Four Actors and two key-value stores. A key-value store is Apify storage that holds named records.

- **Target site.** The website the scraper reads. It is a Standby Actor: an Actor that stays running as a web server at a fixed URL. It serves a page of 20 products. A record called `variant` in its state store switches the page between layout `a`, the original, and layout `b`, the new one. [Code](actors/target-site/main.js).
- **Scraper.** An ordinary Actor that reads the target site with Cheerio, a library that reads HTML, the text describing a page's structure. Its runs use the build tagged `prod`. A build is one packaged version of an Actor's code. A tag is a label that points at one build. The scraper checks its own output before it finishes. [Code](actors/scraper/main.js) and [selectors](actors/scraper/selectors.js).
- **Repair Actor.** The Actor that runs the AI agent. A failed scraper run starts it. The agent works out what changed, fixes the scraper, tests the fix, and waits for a person to approve it. [Code](repair-actor/src/).
- **Permanent link.** A small Standby Actor at a fixed URL. It redirects you to the agent web page of whichever repair run is live. [Code](actors/redirector/main.js).
- **Agent web page.** A page that each repair run serves while it runs. On it you can watch the agent, send it a message, and approve its fix. [Code](repair-actor/src/steer-server.ts).
- **Agent memory store.** The key-value store that holds the agent's memory. The agent saves its work in small steps. Each saved step is one record. [Storage code](repair-actor/src/kvstore/apify-kv-storage.ts).

Nothing runs on your machine during a pass. Every action is a click in the Apify Console or a URL opened in a browser. The only terminal command is the reset.

## Starting state

Run `npx tsx scripts/smoke.ts reset` from the repository root. It needs `APIFY_TOKEN`. It does three things:

- It switches the target site to layout `a`.
- It restores the scraper's original `selectors.js`, the file that tells the scraper where each field is on the page.
- It points the `prod` tag back at the original build.

The reset does not erase the agent's memory. If a repair has already finished, the next incident still starts from its latest notes even though the demo restores the original scraper.

Useful Console pages:

- [Scraper runs](https://console.apify.com/actors/ctzTh4lGVmdeKVFDl/runs)
- [Repair Actor runs](https://console.apify.com/actors/8vQ9TLkdIQfFwnBSg/runs)
- [Target site state store](https://console.apify.com/storage/key-value-stores/UUu085OFUnrJrgFwS), which holds one record, `variant`
- [Agent memory store](https://console.apify.com/storage/key-value-stores/iHR5PW7OXNXvrEBiC), which holds the agent's saved steps
- The permanent link: `https://straightforward-under--shd-repair-link.apify.actor/?token=<APIFY_TOKEN>`. Replace `<APIFY_TOKEN>` with your Apify API token. It redirects to whichever repair run is live. If no run is live, it shows a page that refreshes itself.

To see the starting point, open the scraper Actor, click **Start**, and keep build `prod`. The run finishes green in about 30 seconds with 20 items, each with a price.

## Step 1: the website changes

1. Open the target site state store, click the record `variant`, change `"a"` to `"b"`, and save.
2. Open the scraper Actor, click **Start**, and keep build `prod`. In production, a schedule would start this run.

Within about 40 seconds the run turns red. Its log says `Output validation failed: price fill rate 0% is below 90%`. The fill rate is the share of scraped items that have a value for a field. The run's key-value store has a `DIAGNOSIS` record that says why the run failed.

The site renamed the price element and added a cookie banner. The scraper checks its own output, so a price column that is 0% filled becomes a failed run instead of a dataset full of empty prices. Nobody touched the scraper.

If the run is green, the `variant` record did not save. Reload the store page and check that it says `b`.

## Step 2: the failed run starts the repair Actor, and the agent reads its latest notes

1. Open the repair Actor runs list. A new run appears within about 10 seconds of the failure. A webhook started it. A webhook is a platform rule that reacts to an event. This one reacts to `ACTOR.RUN.FAILED` on the scraper and starts the repair Actor with the input `{ actorId, failedRunId }`. [Webhook setup](scripts/deploy.ts).
2. Open the run's **Log** tab. From top to bottom:
   - Two URLs. The first is the agent web page of this run. The second is the permanent link.
   - `memory recovered: snapshot=…, log records replayed=…, head seq=…`. The agent's memory came back from the key-value store. No database is involved. Step 3 explains the three numbers.
   - `=== DIFF BUNDLE (deterministic, computed before any model call) ===`. This block is the page comparison. Plain code compares the page now with the copy the agent saved when it built the scraper. "Deterministic" means the same inputs give the same result. It runs before the agent asks the language model anything. It lists:
     - which selectors from build time still match. A selector is the pattern the scraper uses to find a field on the page. `.price-tag` had 20 matches then and 0 now, so it is marked `MISSING`.
     - the new script `/consent.js`
     - the new CSS classes, labels on page elements, with the suspicious ones named
     - the failed run's fill rates
     - links to a before picture and an after picture. Each is an SVG drawing made from the page's code, without a browser. [D8](DECISIONS.md#d8-screenshots-are-drawn-without-chromium) explains why.
   - `forked the latest finished repair conversation #… at entry #… into conversation #…; the agent sees its own handoff note first (source incident …)`. A conversation is the stored transcript; an entry is one message or event. To fork it means to start a new conversation sharing its history up to that entry. The handoff is the note the agent left for itself after that repair. If no repair has finished, the log instead says `forked the build conversation …` and uses the original build note.
   - `incident submitted (request id = failed run id …)`. The incident is the stored failure information made from the page comparison. Submitting it hands it to the agent as a submission, one request into its conversation. The request id is the failed run id, so sending the same incident twice returns the same submission.
3. Open the run's **Live view** tab, or the permanent link. You see three things in order:
   1. `LATEST SAVED NOTES`, with the source entry and conversation IDs. Repair notes begin with `REPAIR HANDOFF` and `Source incident: <failed run ID>`.
   2. The red incident entry, which comes from the platform.
   3. The agent's first message. On the first repair it recalls that `.price-tag` was chosen and `.amount` rejected because it appeared on only 7 of 20 products as an old price. On later repairs it names the source incident and quotes the latest note's `Price decision:` and `Rejected price alternative:` lines, including their reasons.

Each finished repair writes new notes with current selectors, evidence, rejected alternatives, build IDs, incident changes, and unresolved work. Startup checks that the report succeeded and its handoff was committed before choosing it as the next fork point. A finished investigation that gave up still contributes knowledge without claiming its attempted fix is live. Restarting the same failed run ID reuses its existing conversation; a different failed run abandons unfinished investigations and starts from the latest completed handoff. The original build note is only the fallback. The page comparison always uses the unchanged original build references, so its selectors can differ from the latest notes. [Chain decision](DECISIONS.md#d18-each-repair-starts-from-the-latest-finished-repairs-notes).

Three things matter here:

- The page comparison uses plain code and makes no model request.
- The agent's first paragraph quotes its latest notes. For the original build note, the incident does not supply `.amount`. For a repair note, the incident does not supply the prior failed run ID or its saved quotation lines. The smoke check verifies these distinctions.
- The incident enters the transcript as a platform entry, separate from user messages. The stored transcript records who said what, even when older entries are no longer in active model input.

If no repair run appears after 60 seconds, start one by hand. Open the repair Actor, click **Start**, and use the input `{ "actorId": "ctzTh4lGVmdeKVFDl", "failedRunId": "<FAILED_RUN_ID>" }`, with the id of the red run. The outcome is the same.

## Step 3: stop the repair run, start it again, and it picks up where it left off

1. Wait until the Live view shows the agent in the middle of its investigation, for example while a tool call is running. A tool call is one action the agent takes through one of its tools, such as `build_scraper`, which builds the fixed scraper, or `run_canary`, which starts a test run of it. Open the repair run and click **Abort**.
2. Open the agent memory store. It holds:
   - `log-000000nnn`: one record per saved step, where `nnn` is the step number. The code calls a saved step a commit.
   - `snapshot-000000nnn`: every 25 saved steps, one combined record of all writes so far. It reduces the number of records startup reads.
   - `head`: the saved-step number at the latest snapshot. The [storage code](repair-actor/src/kvstore/apify-kv-storage.ts) updates it with each snapshot and does not trust it at startup.
   - the `fixture-*` records from the build. These fixtures are unchanged original references, including the page, selectors, expected sample, and validation rules. Repair tools cannot replace them.
   - `incident-<FAILED_RUN_ID>`, the incident written a minute ago.
   - `repair-conversation-<FAILED_RUN_ID>`, which maps the incident to its repair conversation and records its parent and fork entry.
   - `latest-handoff`, once a qualifying repair has finished. This cached record contains the validated conversation, handoff entry, report entry, source failed run ID, and note. Startup reconstructs it from stored history if publication was interrupted; the cache alone never decides the fork.

   Open the newest `log-` record. It is one saved step in JSON, a text format for named values.
3. To restart, open the repair Actor, click **Start**, and use the same input as the aborted run. **Run again** on the aborted run does the same thing.
4. Open the new run's log:
   - `memory recovered`, with the number of log records replayed since the last snapshot.
   - `=== task tree at startup (before resume) ===`. The task tree lists the agent's unfinished work. Each task is one unit of work, either a model request (`pi.generation`) or a tool call (`pi.tool`), with its state and phase.
   - If a tool was running when the container died, the tree shows `pi.generation #n [waiting, phase tools]` and under it `pi.tool <name> #m [ready, phase execute] <- was running when the previous run died …`. The container is the machine the run executes on.
   - If the model was in the middle of a request, the tree shows `pi.generation #n [ready, phase request]` instead. The agent drops the half-written answer and asks the model again.
   - `resuming investigation in conversation #…`. The agent continues from there.

   Finished tool calls are not repeated. In the recorded passes the abort landed during a model request each time. Step 5 shows the case where a tool is interrupted.

A durable agent saves every step, so it survives a crash. The agent is its log of saved steps. The process that runs it can be replaced, and the container is disposable. The agent web page has a new URL because this is a new container. That is why the permanent link exists. Reload it.

If the abort landed between tool calls, the tree says `(no live tasks: nothing was interrupted)` and the agent continues with the next step. That is also a resume. To see the interrupted case, abort again while a `build_scraper` call is visible in the log and restart again.

## Step 4: send the agent a message while it works

1. Open the permanent link. It redirects to the new run. You see the active saved entries, then live events. Older history hidden by a handoff or summary remains stored.
2. Type `the site also added a cookie banner, handle it` and click **Send**. The page says `delivered; the agent sees it at its next turn`.
3. The agent's next message acknowledges the banner, and the final report mentions it.

The page sends the message in a mode the agent framework calls "when busy: steer". The framework is the code that manages the model, tools, and saved work. In this mode the message does not interrupt the running tool call. It waits in the conversation, and the model sees it at its next turn, like a message to a colleague. The message is itself a saved step, so it survives another abort.

The agent may already have handled the banner and say so. That still shows the acknowledgement.

## Step 5: the agent fixes and tests the code, a person approves, and the fix goes live

1. In the log or on the agent web page, the agent calls these tools in order:
   1. `write_scraper_file` writes the fix. The price selector `.price-tag` becomes `.value`.
   2. `build_scraper` builds the fixed scraper in about 40 seconds and tags the build `candidate`.
   3. `run_canary` starts the test run. It runs the candidate build against the live site.
   4. `compare_canary` checks the test run and reports `PASS`: same fields, fill rates above the build-time thresholds, and an item count in range.
   5. `set_status` proposes the build id.

   Then the log says `gate: WAITING FOR APPROVAL to promote build …`. The log calls the approval check the gate. To promote a build means to point the `prod` tag at it, which puts it live.
2. The header of the agent web page shows "proposes build …". Click **Approve** and type a name. The log says `gate: approved by <name>` and then `PROMOTED: prod -> build …`.
3. The run finishes. Its **Dataset** tab holds a report row with what changed, what was done, who approved and when, the elapsed seconds, compute units, and fresh handoff notes. Compute units are how Apify measures the resources a run used. After the framework saves the handoff, the log says `latest handoff: conversation #…, entry #…, source incident …`. This is the completion the next new incident can inherit.
4. Open the scraper Actor, click **Start**, and keep build `prod`. The run is green, with 20 items and prices filled.

The agent cannot promote without the approval record. The approval check is a hook in front of the `promote` tool. A hook is code that runs before or after a tool. The approval is saved in the agent's memory. So if the run is killed after approval and before promotion, the restart promotes without asking again.

To see that: approve, abort within the next second, and restart. The task tree shows `pi.tool promote … [ready, phase execute]`. Two lines later the log shows `PROMOTED: prod -> build …, approved by <name>`, with no new `gate: WAITING` line. This was verified: run `s7dA8qc1DrL1oPdga` was aborted 3 seconds after approval, and run `CXlkeXT9eUWIJ9GX8` promoted at startup.

If `compare_canary` fails, the agent tries again. Its budget is 60 tool calls and 40 minutes. Tool calls from previous repairs do not consume this repair's allowance. If it gives up before promotion, the report says so, `prod` stays untouched, and a completed handoff retains what it tried and what remains unresolved.

## Afterwards

To put the site, the scraper source, and the `prod` tag back, run `npx tsx scripts/smoke.ts reset`.

The agent memory store keeps incidents and conversations. Each new failed run ID gets its own fork from the latest completed repair, even after the demo reset. No history is deleted automatically, so stored bytes and recovery memory grow over time.

## Long investigations and old decisions

Context is the input sent to the language model. Compaction summarizes older context while leaving its original entries stored. The repair process targets compaction at 120,000 tokens, small units of model input or output, and starts it in the background near 87,232. It keeps about 20,000 recent tokens unchanged. The summary instructions request exact selector decisions, rejected alternatives and reasons, build IDs, and human messages. Summaries can still lose details; copied notes have a size cap, and failed summaries are declined, so the target is not an unconditional ceiling. Summarization spend is included in `pi.usage`, the token and cost totals printed at shutdown. [Policy and limitations](DECISIONS.md#d19-the-model-sees-bounded-context-while-original-entries-stay-stored).

When notes do not explain a selector, the agent is instructed to call `recall_history` before guessing. Searching for words such as `amount rejected` ranks saved assistant text, tool calls and their arguments, handoff notes, and summaries across the current fork chain. It returns entry IDs and short excerpts; fetching an ID retrieves the complete eligible text, in explicit parts if it is long. This makes no model call. It does not search sibling investigations, raw tool results, or individual human messages, though those records remain stored. [Recall implementation](repair-actor/src/history.ts).

## The unattended check

`npx tsx scripts/smoke.ts` runs Steps 1 to 5 through the Apify API and asserts each one. It checks the red run, webhook, original-reference comparison, latest notes and first response, abort, exact conversation reuse on restart, accepted human message, approval, promotion, report, fresh handoff publication, and green scraper run. Four older recorded passes took between 92 and 142 seconds; they do not verify the chain. Two passes in a row on build 0.0.22 took 127 and 105 seconds and verified it; the run IDs are in the [README](README.md#what-is-real-what-is-simplified-what-is-fragile). [Script](scripts/smoke.ts).

**To verify the chain yourself**, after deploying a change and restoring its secret as described in the [README](README.md#update-the-deployed-repair-actor), run these commands one after the other from the repository root:

```sh
npx tsx scripts/smoke.ts
npx tsx scripts/smoke.ts
```

Each pass resets the website and scraper but keeps agent memory. Save the first pass's `latest handoff` conversation ID, entry ID, and source incident. In the second pass, the `forked the latest finished repair conversation` line must name those same values as its parent. The new repair has a different conversation ID. During its run, open the printed agent web page and check `LATEST SAVED NOTES`, then the red incident, then a first response naming the previous incident and quoting its price decision and rejection reason. The script asserts the exact note and both quotation lines, as well as unchanged mapping and exact conversation reuse after restart. Both passes must end with `PASS`.

## Words used in this document

- **Agent framework.** Pi Durable, the npm package the repair Actor is built on. It runs the model and the tools and saves every step to storage.
- **Agent memory store.** The key-value store that holds the agent's saved steps and build references.
- **Agent web page.** The page a repair run serves while it runs. You can watch, send a message, and approve there. The code and the log call it the steer page.
- **Approval check.** The rule that blocks the `promote` tool until a person approves. The log calls it the gate. It is a hook on `promote`.
- **Commit, or saved step.** One all-or-nothing write of entries, tasks, and documents to storage. Here each commit is one key-value record.
- **Compaction, context, token.** Context is input sent to the model; a token is a small unit of input or output. Compaction summarizes older context without deleting its stored entries.
- **Conversation.** The stored transcript. The model sees its active part, which can omit entries hidden by a handoff or compaction.
- **Document.** A typed, versioned record that belongs to one conversation. Typed means it has a fixed shape. Versioned means each change makes a new version. The approval and the status line are documents.
- **Fork.** A new conversation that shares another conversation's history up to one entry. A repair inherits the latest completed repair's handoff, or the original build handoff if none exists.
- **Handoff note, or latest saved notes.** At the end of a build or repair the agent writes a note, and its active context starts again with that note visible. The framework calls this a reset. Earlier entries stay stored.
- **Hook.** Code that runs at a framework event, such as before a tool or compaction. The approval check is a hook on `promote`.
- **Page comparison.** The report that plain code prints before the model is asked anything. The log calls it the diff bundle.
- **Permanent link.** A fixed URL that redirects to the agent web page of the live repair run.
- **Recall.** Search saved decisions and notes across the current fork chain through `recall_history`, or retrieve one matching entry by ID.
- **Replay.** After a crash, the framework looks at the task tree. A tool marked replay safe runs again. Any other tool that was running is reported to the model as interrupted.
- **Submission.** One request into a conversation. Here it is the incident, keyed by the failed run id, so sending it twice returns the same submission.
- **Task.** One unit of work, such as a model generation or a tool call. Each task has a saved state and a checkpoint phase, which says how far it got.
- **Test run.** A run of the candidate build against the live site, made before anyone approves. The tools call it a canary.
