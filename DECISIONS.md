# Decisions

This file records why the project is built the way it is. Each decision has a number, D1 to D17, that other documents refer to.

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

The original brief puts Chromium, a headless browser, out of scope. So "screenshot" here means a deterministic SVG drawing of the parsed page. Deterministic means it comes out the same every time. The drawings are stored in the agent memory store as `image/svg+xml`, one before and one after. They show the missing price and the cookie banner on top of the list. [DEMO.md](DEMO.md) states this.

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

To prevent this, `main.ts` now aborts every submission whose request id is not the failed run id of this run. It does this before it touches the new incident. Only the current incident is resumed.

Restarting a run with the same input, as in Step 3 of the runbook, still works. That path uses the same failed run id, so this change does not affect it.

## D14: the run API wants a build tag or a build number

`POST /acts/:id/runs?build=` accepts a tag, such as `prod` or `candidate`, or a build number, such as `0.0.8`. It does not accept a build id. So `runScraper` first looks up a 17-character build id through `GET /actor-builds/:id` and uses its number.

## D15: elapsed time spans restarts

The report's `elapsedSeconds` counts from `computedAt` in the incident record. That field is written once per failed run, so the count covers both the aborted run and the restarted one.

Compute units are per run, reported as `computeUnitsThisRun` and read from the run object. Compute units are how Apify measures the resources a run used. Summing them across restarts was not worth the extra API calls.

## D16: nobody has clicked through the runbook in a browser

The builder agent is the AI coding agent that built this repository. It tested the Console steps of [DEMO.md](DEMO.md) through the same API endpoints the Console buttons call:

- start
- abort
- start again with the same input
- the run's container URL, to send a message and to approve

Nobody has clicked through DEMO.md in a browser yet. The presenter should do one dry run.

## D17: the demo video is a recording of a real pass

[video/record.ts](video/record.ts) records a live pass of Steps 1 to 5 with a headless Chromium. What you see is real: the real site, real logs from the API, and the real agent web page, typed into and clicked.

The narration is synthesized speech, made from fixed text with edge-tts, a text-to-speech tool. It is placed at the recorded start time of each scene. Nothing is staged except the title, cast, and closing cards.

The recorder also draws local views of the layout change, page pictures, memory store, and report. Those views use live platform data. They do not show the Console interface itself. See the [recorder's scene code](video/record.ts).
