# Decisions

This file records why the project is built the way it is. Each decision has a number, D1 to D20, that other documents refer to.

A few terms appear throughout:

- **Pi Durable** is the npm package `@earendil-works/pi-durable`, the agent framework the repair Actor is built on. It runs the language model and the tools, and it saves every step to storage so that work survives a crash.
- **Saved step.** Pi Durable saves its work in small all-or-nothing writes. The code calls each one a commit. Each commit gets a sequence number, `seq`, that grows by one each time.
- **Agent memory store** is the Apify key-value store that holds the agent's saved steps. A key-value store is Apify storage that holds named records.
- **Repair Actor** is the Actor that runs the AI agent. **Scraper** is the Actor it repairs. **Target site** is the website the scraper reads.

## D1: Pi Durable is pinned to version 1.4.0

The code uses the published npm version 1.4.0. The newest source in the Pi Durable git repository, under `packages/durable`, has a different `Storage.commit` signature. `Storage.commit` is the function that saves one step. In the git version it takes several batches of writes. The code here targets the published 1.4.0 interface, where it takes a single batch and returns a `seq`.

## D2: memory record keys are `log-000000123` and `snapshot-000000100`, without a slash

The platform allows `/` in key-value store keys. The record API routes treat it as a path separator, though, so `setRecord` returned "no API endpoint at this URL" for a key such as `log/...`. Keys with a hyphen avoid this. Zero-padding and listing by prefix work the same way.

## D3: a snapshot record holds every saved step up to its `seq`

A snapshot record has the shape `{ seq, commits }`. `MemoryStorage` is the in-memory storage that ships with Pi Durable, and it has no way to export its state. So here the "materialised state" is the list of detached writes that rebuilds it. Detached means copied out of the working memory, so later changes do not affect it.

At startup the repair Actor reads one snapshot record plus the log records after it, instead of N records. A snapshot is written every 25 saved steps. The `head` record is written with each snapshot, and startup never trusts it.

## D4: storage is `MemoryStorage` plus a write-ahead log

A write-ahead log means each step is written to the key-value store before it counts as done. This is the same shape as the package's own JSONL backend, which keeps its log in a file of JSON lines. Each save runs in three stages:

1. `prepareCommit` checks the writes and detaches them.
2. One PUT request stores `{ seq, writes }` as one record.
3. `apply()` applies the writes in memory.

A failed PUT poisons the storage, which means it refuses all further writes. The Session, Pi Durable's running instance, then fails. The next run reopens from the log.

## D5: Actors are addressed by `user/name`

[config.ts](config.ts) names each Actor as `user/name` and never by raw ID, so a redeploy changes nothing. The webhook payload still carries real IDs, and those are what the repair Actor receives. A webhook is a platform rule that calls a URL when an event happens.

## D6: three small Actors are deployed as source files through the API

[scripts/deploy.ts](scripts/deploy.ts) deploys the target site, the scraper, and the permanent link Actor with the source type `SOURCE_FILES`. With this type, the platform stores the Actor's code as files that the API can edit. The agent later rewrites the scraper through the same API.

The repair Actor is pushed with `apify push`, the Apify command-line tool that uploads a local folder and builds it.

## D7: Standby URLs need an Apify token

A Standby Actor stays running as a web server at a fixed URL, its Standby URL. The target site and the permanent link are Standby Actors.

- The scraper and the repair Actor send `Authorization: Bearer $APIFY_TOKEN`.
- People open the target site and the permanent link with `?token=...` added to the URL. The platform strips the token before the request reaches the Actor.
- Container URLs, the ones ending in `*.runs.apify.net`, need no token. Each run serves its agent web page at its container URL.

## D8: screenshots are drawn without Chromium

Chromium, a headless browser, was out of scope. So "screenshot" here means a deterministic SVG drawing of the parsed page. Deterministic means it comes out the same every time. The drawings are stored in the agent memory store as `image/svg+xml`, one before and one after. They show the missing price and the cookie banner on top of the list. [DEMO.md](WALKTHROUGH.md) states this.

## D9: models are reached through OpenRouter

OpenRouter is a service that gives access to many language models through one API key. The key is `OPENROUTER_API_KEY`, stored as a secret environment variable on the repair Actor.

- `haiku-4.5` handles the first turn, in which the agent interprets the page comparison.
- `sonnet-4.5` handles the fix.

## D10: the approval check is a hook, a replay-safe tool, and a memo

The approval check has three parts:

- A `beforeTool` hook on the `promote` tool. A hook is code that runs before or after a tool.
- `promote` is replay safe. After a crash, Pi Durable runs a replay-safe tool again instead of reporting it as interrupted.
- A memo, a stored result that survives a restart.

The hook waits until someone has posted to `/approve`. It checks a conversation document every 2 seconds. A conversation document is a record that belongs to one conversation. The approval is a saved document, so a run killed after approval does not ask again.

## D11: the repair Actor's source folder is `src/kvstore/`

The folder was first called `src/storage/`. `apify push` drops any folder named `storage` without a warning, even under `src/`, because it treats that name as local storage to exclude. The platform build then fails with missing modules.

The Dockerfile uses `npm install` because the npm 10 in the base image rejects the lockfile written by npm 12 as out of sync.

## D12: push order and permissions

`apify push --force` rewrites the Actor version. So `scripts/deploy.ts repair-env` applies the `OPENROUTER_API_KEY` secret again after every push.

Every Actor needs `actorPermissionLevel` set to `FULL_PERMISSIONS`. The default `LIMITED` level cannot open named stores. `deploy.ts` sets it, and it was set once by hand for the repair Actor.

## D13: stale investigations are abandoned at startup

A repair run that was aborted and never restarted leaves work behind. Its submission stays placed and its tasks stay live. A submission is one request into a conversation, here the incident. A task is one unit of work, such as a model request or a tool call. Pi Durable resumes all live work, so the next repair run for a different failed run id would resume that old work.

To prevent this, [main.ts](repair-actor/src/main.ts) uses the failed run's saved mapping to identify its conversation. Before opening the Harness, it marks other conversations' unfinished tasks for abortion in one saved step. It then withdraws their queued inputs and drains their aborted work before submitting the current incident. This order matters because even an abort or submission can start scheduling. Human messages belonging to the current investigation are preserved. [Implementation](repair-actor/src/repair-chain.ts).

Restarting a run with the same input, as in Step 3 of the walkthrough, still works. That path uses the same failed run id, so this change does not affect it.

## D14: the run API wants a build tag or a build number

`POST /acts/:id/runs?build=` accepts a tag, such as `prod` or `candidate`, or a build number, such as `0.0.8`. It does not accept a build id. So `runScraper` first looks up a 17-character build id through `GET /actor-builds/:id` and uses its number.

## D15: elapsed time spans restarts

The report's `elapsedSeconds` counts from `computedAt` in the incident record. That field is written once per failed run, so the count covers both the aborted run and the restarted one.

Compute units are per run, reported as `computeUnitsThisRun` and read from the run object. Compute units are how Apify measures the resources a run used. Summing them across restarts was not worth the extra API calls.

## D16: the Console steps were tested through the API

The steps in [WALKTHROUGH.md](WALKTHROUGH.md) were exercised through the same API endpoints the Console buttons call: start, abort, start again with the same input, and the run's container URL to send a message and to approve. Nobody has clicked through them in a browser yet.

## D17: the demo video is a recording of a real pass

[video/record.ts](video/record.ts) records a live pass of Steps 1 to 5 with a headless Chromium. What you see is real: the real site, real logs from the API, and the real agent web page, typed into and clicked.

The narration is synthesized speech, made from fixed text with edge-tts, a text-to-speech tool. It is placed at the recorded start time of each scene. Nothing is staged except the title, overview, and closing cards.

The recorder also draws local views of the layout change, page pictures, memory store, and report. Those views use live platform data. They do not show the Console interface itself. See the [recorder's scene code](video/record.ts).

## D18: each repair starts from the latest finished repair's notes

D18 to D20 were agreed before implementation. Chaining, compaction, and recall are implemented and covered by offline tests. Two consecutive repairs on the platform verified the chain on build 0.0.22; the run IDs are in the [README](README.md#what-is-fragile).

A handoff is a note the agent leaves for its next investigation. A fork is a new conversation that shares another conversation's stored history up to one entry. The `write_report` tool requires fresh handoff notes and returns `control: { terminate: true, handoff }`, as `finish_build` already does. The framework then saves a `pi.reset` entry, which starts a shorter model context without deleting the older entries. See [the tools](repair-actor/src/agent-tools.ts).

The note must describe the current selectors and their evidence, rejected alternatives and their reasons, what the page looked like, what changed in this incident, the build IDs, the outcome, and unresolved work. Code adds the header `REPAIR HANDOFF` followed by `Source incident: <failed run ID>`. Notes are limited to 16,000 characters and must include separate `Price decision:` and `Rejected price alternative:` lines, each with its selector and reason. The next repair is instructed to quote both lines verbatim in its first message, with the source incident. This makes the [smoke check](scripts/smoke.ts) distinguish latest knowledge from a repetition of the original build note. A repair that reports that it gave up still leaves useful knowledge; its note must distinguish attempted changes from the build actually put live.

[Repair startup](repair-actor/src/main.ts) uses the [chain helper](repair-actor/src/repair-chain.ts) to select the newest completed repair handoff from stored history. A qualifying repair has its own successful report, a settled incident submission, and its own committed reset carrying the note. A report written before its reset is saved is not enough. An inherited reset from the build is not a repair completion. The reset need not be the last entry, because a queued human message can follow it. If no repair qualifies, startup uses the original build notes.

The existing mapping for the same failed run ID takes precedence, so a restart continues its conversation rather than creating another fork. A different failed run still abandons unfinished investigations under D13, before their tools can execute. The tool budget counts only entries written by this repair, not calls inherited from the build and earlier repairs.

The `latest-handoff` record caches the validated selection for the smoke check, but stored history remains the authority. It contains the conversation ID, reset entry ID, report entry ID, source failed run ID, and note. Startup and completion rescan stored history before publishing it, recovering missed publication and preventing an older incident's restart from replacing a newer completion. `repair-conversation-<failed run ID>` records the selected parent and fork entry alongside the repair conversation. A crash after saving that mapping but before submitting the incident recovers the actual saved incident, not a placeholder. See the [chain tests](repair-actor/test/repair-chain.test.ts) and [tool lifecycle tests](repair-actor/test/repair-integration.test.ts).

The `fixture-*` records remain immutable original build references. Neither `promote` nor `write_report` refreshes them from a canary, the test run of a proposed build. This preserves an independent expected sample and validation thresholds instead of accepting candidate output as its own expected result. Only the build session may write fixtures. The [page comparison](repair-actor/src/diff-bundle.ts) explicitly compares against the original accepted layout, not the latest production layout. Canary sample-value differences are reported for inspection; schema, fill-rate, item-count, and run-status checks decide PASS or FAIL. Latest notes and source inspection describe the current scraper. Keeping the original references also makes the [demo reset](scripts/smoke.ts), which restores the original scraper without clearing memory, consistent across repeated passes.

## D19: the model sees bounded context while original entries stay stored

Context is the text and other input sent to the model. A token is a small unit of that input or output; the model's context window limits how many it can process together. Compaction replaces older active entries with a summary while retaining their originals in storage. The handoff bounds what a new repair starts with; compaction limits growth within an investigation.

[Repair startup](repair-actor/src/main.ts) sets `settings.compaction` explicitly using the installed catalog for the [configured models](repair-actor/src/models.ts). That catalog gives `openrouter/anthropic/claude-sonnet-4.5`, the fix model, a 1,000,000-token window and `openrouter/anthropic/claude-haiku-4.5` a 200,000-token window. Exact `provider/modelId` entries in `modelOverrides` reserve 880,000 and 80,000 tokens respectively. Both target blocking compaction at 120,000 tokens, keep about 20,000 recent tokens verbatim, and start background compaction near 87,232. These reserves intentionally trigger compaction well before the large model's capacity is exhausted. The [policy helper](repair-actor/src/compaction.ts) also reduces thresholds for smaller windows; [tests](repair-actor/test/compaction.test.ts) check the actual catalog and the arithmetic. These settings apply to the repair process, not the separate initial build-session script.

In pinned version 1.4.0, the `beforeCompact` hook on `CompactionTask` can decline or return a completed summary. It cannot return additional instructions to the built-in summarizer. The [custom-summary hook](repair-actor/src/compaction.ts) therefore supplies preservation instructions to its own summarization request and returns the supported `{ summary }` result. Its instructions demand verbatim retention of every selector decision, every rejected alternative with its reason, all build IDs involved, and every human message. Summary output is capped at 8,192 tokens, independently of the large reserve. Code also carries forward a block of handoff notes and human messages, capped at 30,000 characters including earlier copied notes. When that block cannot fit, it explicitly marks omissions rather than growing without limit. The summarizer sees at most 2,000 characters per tool-result body, and no thinking blocks or system prompts.

Summarization spend belongs in `pi.usage`, the framework's token and cost totals. The built-in summarizer records its own spend, but a model call made by this hook needs explicit accounting. The hook saves a successful result in a memo, then records usage and a saved marker in one commit, so replaying the accounting step cannot charge the same result twice. Answered failed attempts also count. This does not promise to recover an external provider charge when a process dies before saving the response.

Compaction is approximate and can omit evidence, rephrase reasons, or lose nuance. Explicit instructions and recent text retained verbatim reduce that risk, but do not guarantee a lossless summary. They cannot keep an unlimited number of decisions in a finite context. Original entries remain stored; D20 retrieves the eligible decisions, notes, and summaries. Raw human messages and tool results remain in storage but are not individually returned by that tool. A failed or incomplete custom summary is logged and declined rather than replaced by an uninstructed default summary. Pi Durable can then proceed without shrinking that context and try again later. The thresholds are targets, not a hard ceiling in the presence of failures or unusually large entries. A provider request may still exceed its window and fail. Offline tests verify mechanics and instructions with fake models, not the quality of a real model's summaries.

## D20: recall searches the saved fork history without another model call

The [recall_history tool](repair-actor/src/history.ts) searches all pages of `Conversation.entries()`, the framework's fork-aware history interface. It includes ancestral entries hidden by resets and compaction, not just the current model context. The tool needs an injected full Conversation handle: the tool execution API's restricted conversation handle does not expose `entries()`. [The repair extension](repair-actor/src/agent-tools.ts) registers it and tells the agent to search before guessing when its latest notes do not explain a selector.

Search keeps assistant text, tool-call names and arguments, handoff notes from `pi.reset`, and summaries from `pi.compaction`. It excludes thinking blocks, ordinary tool-result bodies, system prompts, and unrelated records. BM25 is a word-matching ranking method that weighs how distinctive query terms are across documents. The package's existing `rankDocuments` function ranks eligible entries. Search returns five matches by default, at most ten, with entry IDs, source conversation IDs, and excerpts of about 300 characters. A second mode fetches one eligible entry in full. Long entries arrive in parts of at most 48 KiB, meaning 49,152 bytes; a returned continuation offset tells the caller where to continue without silently truncating the text. Both modes restrict results to the current fork chain, so an ID from a sibling investigation or a later parent entry cannot expose that history. Abandoned sibling investigations remain stored but are not part of the new chain. Recall makes no model call.

Version 1.4.0 ships `dist/search.js` without exporting it as a package subpath. A [small typed adapter](repair-actor/src/durable-internals.ts) resolves the installed package location and loads that shipped file directly. It does not import from the temporary probe directory, change the pinned package, or substitute a copied ranker. [MemoryStorage tests](repair-actor/test/history.test.ts) exercise the shipped ranker, filtering, pagination, hidden history, complete retrieval, and branch restrictions.

History is persisted in Apify key-value storage, but [this backend](repair-actor/src/kvstore/apify-kv-storage.ts) restores it into `MemoryStorage` at startup and serves entry reads from memory. A recall search therefore does not normally issue a new platform request per entry. Recovery reads the snapshot and later log records from KV. Stored bytes, recovery memory, and search work grow as investigations accumulate; paging controls each read, not the total retained history. Bounded model context does not mean bounded storage or constant search cost.
