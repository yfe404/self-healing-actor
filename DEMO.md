# Self-healing Actor demo: runbook

Audience: people who know what an Apify Actor is and roughly what an AI agent is. Terms are explained the first time they appear; see the glossary at the end.

A narrated 5.5 minute video of the whole thing, recorded from a real run, is at `video/self-healing-actor-demo.mp4`. Re-record it with `cd video && npx tsx record.ts` (needs APIFY_TOKEN, about 7 minutes, resets the platform state afterwards).

One presenter, one audience member who plays the site owner, one skeptic, one steerer. Nothing runs on a
developer machine during the demo. Every action is an Apify Console click or a URL opened in a browser.
Account: `straightforward_understanding`. All IDs live in `config.ts`.

## Before you start (5 minutes, once)

1. Run `npx tsx scripts/smoke.ts reset` from this directory (needs `APIFY_TOKEN`). It puts the target site on
   variant `a`, restores the scraper's original `selectors.js`, and points the `prod` tag back at the original
   build. This is the only terminal command, and it runs before the audience arrives.
2. Open these tabs and log in to Console:
   - Scraper Actor runs: https://console.apify.com/actors/ctzTh4lGVmdeKVFDl/runs
   - Repair Actor runs: https://console.apify.com/actors/8vQ9TLkdIQfFwnBSg/runs
   - Target site state store (one record, `variant`): https://console.apify.com/storage/key-value-stores/UUu085OFUnrJrgFwS
   - Agent memory store (the commit log): https://console.apify.com/storage/key-value-stores/iHR5PW7OXNXvrEBiC
   - Stable steer link (give this to the steerer): `https://straightforward-under--shd-repair-link.apify.actor/?token=<APIFY_TOKEN>`
     It redirects to whichever repair run is live right now. If no run is live it shows a page that refreshes itself.
3. Say what people are looking at. The target site is our own Standby Actor serving 20 products. The scraper
   is an ordinary Cheerio Actor whose scheduled runs use the build tagged `prod`. The repair Actor is an agent
   whose memory lives in the KV store you opened, one record per committed step.

Optional opener: run the scraper once (Console: scraper Actor, Start, keep build `prod`). It finishes green in
about 30 seconds with 20 items. Show the dataset. Say: "this is the baseline".

## Step 1: the website owner changes the page layout (1 minute)

Site owner, not the presenter:
1. Open the target site state store, click record `variant`, change `"a"` to `"b"`, save.
2. Presenter: open the scraper Actor, click Start, keep build `prod`. (In production this is the schedule.)

Expected within 40 seconds: the run turns red. Open it: the log says `Output validation failed: price fill rate
0% is below 90%`. The key-value store tab has a `DIAGNOSIS` record.

What to say: the site renamed the price element and added a cookie banner. The scraper validates its own
output, so a silent 0% price column becomes a loud failed run. Nobody touched the scraper.

Fallback: if the run is green, the variant record did not save. Reload the store page and check it says `b`.

## Step 2: the failed run starts the repair agent, which remembers how it built the scraper (1 minute)

1. Open the repair Actor runs list. A new run appeared within about 10 seconds of the failure: the webhook on
   `ACTOR.RUN.FAILED` started it with `{ actorId, failedRunId }`.
2. Open the run's Log tab. Read it top to bottom with the audience:
   - the two URLs at the top (this run's own steer page, and the stable link),
   - `memory recovered: snapshot=…, log records replayed=…, head seq=…`: the agent's memory came back
     from the KV store, not from a database,
   - `=== DIFF BUNDLE (deterministic, computed before any model call) ===`: which build-time selectors still
     match (`.price-tag` 20 matches then, 0 now: MISSING), the new script `/consent.js`, the new classes
     with the suspicious ones named, the failed run's fill rates, and before/after screenshot links,
   - `forked the build conversation … the agent sees its own handoff note first`,
   - `incident submitted (request id = failed run id …)`.
3. Open the Live view tab of the run (or the stable link). The first thing on the page is the agent's handoff
   note from the build session, written months ago in demo time. Then the red incident entry, from the
   platform. Then the agent's first message, which says something like: "At build time I chose `.price-tag`
   and rejected `.amount` because it only appears on 7 of 20 items as a strikethrough price. `.price-tag` is
   gone and a new `product-price` class appeared."

What to say: the bundle is plain code, so it is the same every time, and it costs nothing. The agent's first
sentence comes from its own stored note, not from a prompt we wrote. The incident is a platform entry in the
transcript, not a user message, so the audit trail shows who said what.

Fallback: if the repair run has not appeared after 60 seconds, start it by hand: repair Actor, Start, input
`{ "actorId": "ctzTh4lGVmdeKVFDl", "failedRunId": "<id of the red run>" }`. Same outcome.

## Step 3: stop the repair run, start it again, it picks up where it left off (2 minutes)

1. Skeptic: while the Live view shows the agent mid-investigation (a tool call in flight is best, for example
   `build_scraper` or `run_canary`), open the repair run and click Abort.
2. Presenter: open the agent memory store. Point at the records: `log-000000nnn` (one per committed step),
   `snapshot-000000nnn` (the folded state every 25 commits), `head`, the `fixture-*` records from the build
   session, and `incident-<runId>` written a minute ago. Open the newest `log-` record: it is a readable JSON
   commit.
3. Presenter: repair Actor, Start, with the same input as the aborted run (Console offers "Run again" on the
   aborted run; that is the same thing).
4. Open the new run's log. Read: `memory recovered` with the log records replayed since the last snapshot,
   then `=== task tree at startup (before resume) ===`. If a tool was running when the container died, the
   tree shows `pi.generation #n [waiting, phase tools]` and under it `pi.tool <name> #m [ready, phase execute]
   <- was running when the previous run died …`. If the model was mid-request, it shows `pi.generation #n
   [ready, phase request]` instead: the half-written answer is dropped and the model is asked again. Then
   `resuming investigation in conversation #…` and the agent continues from there. Finished tool calls are
   not repeated. In the three recorded smoke passes the abort landed during a model request each time; the
   abort-after-approval test below shows the interrupted-tool case.

What to say: a durable agent is a transaction log, not a process. The container is disposable. The steer
page URL changed because it is a new container, which is why the stable link exists; ask the steerer to
reload it.

Fallback: if the abort landed between tool calls, the tree says `(no live tasks: nothing was interrupted)` and
the agent simply continues with the next step. That is also a resume; say so. If you want the interrupted
case specifically, abort again while a `build_scraper` call is visible in the log, and restart again.

## Step 4: someone in the audience sends the agent a message (1 minute)

1. Steerer: open the stable link in their own browser (it redirects to the new run). They see everything
   committed so far, then live events.
2. Type `the site also added a cookie banner, handle it` and press Send. The page says "delivered; the agent
   sees it at its next turn".
3. Watch the stream: the agent's next message acknowledges the banner and the final report mentions it.

What to say: the steer is submitted with "when busy: steer", so it does not interrupt the running tool call;
it is queued into the conversation and the model sees it at its next turn, like a message to a colleague.
The steer is itself a committed record, so it survives another abort.

Fallback: the agent may already have handled the banner and says so. That still shows the acknowledgement.

## Step 5: the agent fixes and tests the code, a person approves, the fix goes live (3 minutes)

1. Watch the log or the stream: `write_scraper_file` (the fix: price selector `.price-tag` becomes `.value`),
   `build_scraper` (about 40 seconds, tagged `candidate`), `run_canary` (runs the candidate build against
   the live site), `compare_canary` (`PASS`: same fields, fill rates above the build-time thresholds, item
   count in range), `set_status` (proposes the build id), then
   `gate: WAITING FOR APPROVAL to promote build …`.
2. The header of the steer page shows "proposes build …". Anyone with the link clicks Approve, types a name.
   The log says `gate: approved by <name>` and `PROMOTED: prod -> build …`.
3. The run finishes. Open its Dataset tab: one report row with what changed, what was done, who approved and
   when, elapsed seconds, compute units.
4. Presenter: scraper Actor, Start, build `prod`. Green, 20 items, prices filled.

What to say: the agent cannot promote without the approval record. The gate is a hook in front of the
`promote` tool; the approval is committed to the agent's memory, so if the run were killed after approval
and before promotion, the restart would promote without asking again. Try it if there is time: approve,
abort within the next second, restart; the task tree shows `pi.tool promote … [ready, phase execute]` and
two lines later `PROMOTED: prod -> build …, approved by <name>` with no new `gate: WAITING` line. (Verified:
runs s7dA8qc1DrL1oPdga aborted 3 seconds after approval, CXlkeXT9eUWIJ9GX8 promoted at startup.)

Fallback: if `compare_canary` fails, the agent iterates (it has a budget of 60 tool calls and 40 minutes). If
it gives up, the report says so and prod is untouched; that is the correct behaviour, say so.

## After the demo

`npx tsx scripts/smoke.ts reset` puts the site, the scraper source and the `prod` tag back. The agent's memory
store keeps the incident and the repaired conversation; each new failed run id gets its own fork, so there
is nothing to clean.

## Unattended check

`npx tsx scripts/smoke.ts` drives Steps 1 to 5 by API and asserts each one (red run, webhook, diff bundle,
first message quotes the handoff note, abort, restart recovers memory and reuses the conversation, steer
accepted, gate waits, approval, promotion, report, green run). One pass takes 5 to 8 minutes.

## Words used in this document, explained

Conversation: the transcript the model sees, stored as entries. Submission: one request into a conversation
(here the incident, keyed by the failed run id, so sending it twice returns the same submission). Task: one
unit of work (a model generation, a tool call), each with a committed state and checkpoint phase. Commit: an
atomic write of entries, tasks and documents to storage; here one KV record per commit. Replay: after a crash
the harness looks at the task tree; a tool marked replay safe is run again, any other tool in flight is
reported to the model as interrupted. Fork: a new conversation that shares the history of another up to one
entry, so the repair sees the build session without copying it. Handoff (reset): the agent writes a note and
the conversation starts again with only that note visible, which is how a long build session becomes a short
memory. Hook: code that runs before or after a tool; the approval gate is a hook on `promote`. Document: a
typed, versioned record scoped to a conversation; the approval and the status line are documents.

## What the value-add is, in the presenter's words

Without this, a broken scraper is a red run and a ticket. With it, the platform computes the diff for free,
the agent that built the scraper is woken up with its own notes, people can watch, interrupt, kill, restart
and steer it from a browser, and nothing reaches production without a named approval. The agent's memory is
a key-value store you can open in Console, so every claim it makes can be checked against a record.
