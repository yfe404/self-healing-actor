# Decisions

- D1 **Pi Durable pinned to 1.4.0** (npm). The git HEAD of `packages/durable` has a different `Storage.commit` signature (multi-batch); the code targets the published 1.4.0 interface (single batch returning a seq).
- D2 **KV keys use `log-000000123` and `snapshot-000000100`, not `log/...`.** The platform allows `/` in keys, but the record API routes treat it as a path separator (setRecord returned "no API endpoint at this URL"). Zero-padding and listing by prefix work the same.
- D3 **Snapshot record = the folded commit list up to that seq**, `{ seq, commits }`. `MemoryStorage` has no state export, so "materialised state" is the list of detached writes that rebuilds it; startup reads one snapshot record plus the log tail instead of N records. Snapshot every 25 commits; `head` is written with each snapshot and never trusted at startup.
- D4 **Storage is MemoryStorage + write-ahead log**, the same shape as the package's JSONL backend: `prepareCommit` validates and detaches, one PUT stores `{ seq, writes }`, then `apply()`. A failed PUT poisons the storage; the Session fails and the next run reopens from the log.
- D5 **Actors addressed by `user/name`** (`config.ts`), never by raw IDs, so a redeploy changes nothing. The webhook payload still carries real IDs, which is what the repair Actor receives.
- D6 **Three small Actors deployed as SOURCE_FILES through the API** (`scripts/deploy.ts`), including the scraper, which the agent later rewrites through the same API. The repair Actor is pushed with `apify push`.
- D7 **Standby URLs need an Apify token.** The scraper and the repair Actor send `Authorization: Bearer $APIFY_TOKEN`. Humans open the site and the stable redirect link with `?token=...` (the platform strips it). Container URLs (`*.runs.apify.net`) need no token.
- D8 **Screenshots without Chromium** (out of scope by the prompt): "screenshot" means a deterministic SVG render of the parsed page, stored in the agent's store as `image/svg+xml`, before and after. It shows the missing price and the cookie banner overlay. Stated in DEMO.md.
- D9 **Models via OpenRouter** (`OPENROUTER_API_KEY` as a secret Actor env var): haiku-4.5 for the first interpretation turn, sonnet-4.5 for the fix.
- D10 **Approval gate = `beforeTool` hook on `promote` + replay-safe tool + memo**: the hook waits (polling a conversation document every 2 s) until `/approve` was posted, the approval is a committed document, so a run killed after approval does not ask again.
- D11 **Repair Actor source dir is `src/kvstore/`, not `src/storage/`**: `apify push` silently drops any directory named `storage` (its local-storage exclusion), even under `src/`, and the platform build then fails with missing modules. The Dockerfile uses `npm install` because the image's npm 10 rejects the lockfile written by npm 12 as out of sync.
- D12 **Push order**: `apify push --force` rewrites the version, so `scripts/deploy.ts repair-env` re-applies the `OPENROUTER_API_KEY` secret after every push. `actorPermissionLevel` must be `FULL_PERMISSIONS` on every Actor (set by deploy.ts and once by hand for the repair Actor); the default LIMITED level cannot open named stores.

## D13: stale investigations are abandoned at startup
A repair run that was aborted and never restarted leaves its submission placed and its tasks live. The next
repair run for a different failed run id would resume them (the harness resumes everything). `main.ts` now
aborts every submission whose request id is not this run's failed run id, before touching the new incident.
Only the current incident is resumed; the Beat 3 resurrect path (same failed run id) is unaffected.

## D14: run API wants a build tag or number
`POST /acts/:id/runs?build=` accepts a tag (`prod`, `candidate`) or a build number (`0.0.8`), not a build id.
`runScraper` resolves a 17-character id to its number through `GET /actor-builds/:id` first.

## D15: elapsed time spans restarts
The report's `elapsedSeconds` counts from the incident record's `computedAt` (written once per failed run),
so it covers the aborted run and the restarted one. Compute units are per run (`computeUnitsThisRun`), read
from the run object; summing across restarts was not worth the extra API calls.

## D16: no manual Console click-through by the agent
The runbook's Console steps were exercised through the same API endpoints the Console buttons call (start,
abort, start again with the same input, the run's container URL for steer and approve). Nobody has clicked
through DEMO.md in a browser yet; the presenter should do one dry run.

## D17: the demo video is a recording of a real pass
`video/record.ts` records a live Beats 1-5 pass with a headless Chromium: real site, real logs from the API,
the real steer page (typed into and clicked). Narration is synthesized (edge-tts) from fixed text, placed at
the recorded scene start times. Nothing is staged except the title, cast, and closing cards.
