# Build progress (kept current by the builder agent; read this first after a context reset)

Prompt: `self-healing-actor-demo-prompt.md`. Research facts: `NOTES-research.md`. Decisions: `DECISIONS.md`.

## Stage status

1. Target site + scraper + red run: DONE. Site actor yjHmW6kVbl3bK7U68 at https://straightforward-under--shd-target-site.apify.actor (Standby, FULL_PERMISSIONS), scraper ctzTh4lGVmdeKVFDl (build prod). Green run fm9aZ2XhO3fZxkXnF (variant a), red run BAZ42MOrzxqjECP8V (variant b, DIAGNOSIS: 0 items, li.product no longer matches). Redirector + webhook: after repair actor exists.
2. KV storage backend + conformance: DONE. 76/76 incl. 25 cases on the real platform (.evidence/conformance-platform.log). Keys are `log-NNNNNNNNN` / `snapshot-NNNNNNNNN` (D2). Repair Actor skeleton DONE (repair-actor/src/{main,platform,task-tree,models}.ts, .actor/, Dockerfile; `mode: probe` runs quick_step/slow_steps/quick_step). Abort/resume PROVEN LOCALLY (kill -9 at 45s mid slow_steps; rerun replayed 22 records, tree showed pi.tool ready + pi.generation waiting, model got `interrupted` result, finished). PLATFORM PROOF DONE: run 0bdXcWi7nj4TGolMe aborted at 75s mid slow_steps (store Nh1aaZkm26yBjlM4c, snapshot at seq 25), run MRO1LSBjAlHRQicho resumed: tree showed `pi.generation #14 waiting > pi.tool slow_steps #16 ready`, model told interrupted, SUCCEEDED. Repair actor id 8vQ9TLkdIQfFwnBSg. Redirector xS7h2Ij1fM8nKFJno live. Webhook OfpNoTGVYCIc2TG3M (scraper FAILED -> repair).
3. Build session DONE on platform: store shd-agent-memory-ctzTh4lGVmdeKVFDl = iHR5PW7OXNXvrEBiC (200 commits, fixtures fixture-html/-screenshot.svg/-expected-sample/-invariants/-selectors, handoff note names `.price-tag` chosen and `.amount` rejected: only on 7/20 items as strikethrough 'was' price; prod -> build x1nrd0s8qY8NVe6aK 0.0.7). Evidence .evidence/build-session-2.log. Rerun: `cd repair-actor && npx tsx scripts/build-session.ts ctzTh4lGVmdeKVFDl https://straightforward-under--shd-target-site.apify.actor/ --fresh` (deletes store!). Diff bundle (src/diff-bundle.ts) + repair mode (src/main.ts: fork root at last entry, mapping record repair-conversation-<runId>, incident submit requestId=failedRunId kind apify.incident) WRITTEN, compiles, NOT YET RUN.
4. Fix tools WRITTEN in src/agent-tools.ts (read_scraper_source, write_scraper_file, build_scraper [tag candidate], run_canary, read_run, compare_canary, set_status, promote [replay safe, gated], write_report [terminates], finish_build/tag_prod for build only). NOT YET RUN in repair mode.
5. Steer UI WRITTEN (src/steer-server.ts: GET / page, GET /events SSE snapshot+batches+header every 2s with task tree/status/approval, POST /steer whenBusy steer kind apify.steer, POST /approve commits ApprovalDoc). NOT YET TESTED.
6. Gate WRITTEN: beforeTool hook on `promote` polls ApprovalDoc (defineDoc demo.approval, conversation scope) every 2s up to 30 min; budget hook counts pi.tool_result entries. NOT YET TESTED. tagBuild uses actor.update({taggedBuilds}) — verify platform accepts.
7. DEMO.md + smoke.ts + 3 passes: NOT STARTED

## Layout

- `repair-actor/` TypeScript Actor (pi-durable 1.4.0 pinned). `src/storage/{kv-client,apify-kv-storage}.ts` done + `test/kv-storage.test.ts`.
- Planned: `config.ts` (root), `actors/target-site/main.js`, `actors/scraper/main.js`, `actors/redirector/main.js`, `scripts/deploy.ts`, `scripts/build-session.ts`, `scripts/smoke.ts`, `DEMO.md`, `DECISIONS.md`.

## Next: local end-to-end of repair mode
`cd repair-actor && export APIFY_LOCAL_STORAGE_DIR= ; unset APIFY_LOCAL_STORAGE_DIR` -> with APIFY_LOCAL_STORAGE_DIR unset, main.ts uses the PLATFORM store (openAgentStorage checks self.onPlatform || !APIFY_LOCAL_STORAGE_DIR). Write storage/key_value_stores/default/INPUT.json {actorId: ctzTh4lGVmdeKVFDl, failedRunId: <fresh red run>, mode: repair}; flip site to b, run scraper prod -> red run id; run `node dist/main.js`; open http://localhost:4321; steer + approve via curl; expect promote + report. Then `apify push --force` + `deploy.ts repair-env` (rebuild) and test on platform via webhook. Then DEMO.md + smoke.ts.

## Session 3 (2026-10-30/31)
- Local repair mode end-to-end PASSED (.evidence/repair-local-1.log, ~100 s): diff bundle, fork, steer acknowledged, gate, promote, report, scraper green (run Usc808h4OD78czg1J on 0.0.8).
- Bug fixed: run API takes build tag/number, not build id -> runScraper resolves ids.
- Bug fixed: first message did not quote the handoff note -> role section + incident text demand it; smoke asserts `.amount` (not in the bundle) is mentioned.
- Bug fixed: stale submissions from an aborted run of ANOTHER incident were resumed by later runs -> main.ts abandons submissions whose requestId != failedRunId (Conversation.abort, 20 s cap).
- Report now: elapsedSeconds from incident computedAt (spans restarts), computeUnitsThisRun from the run API.
- scripts/smoke.ts written (reset + beats 1-5 + reset). DEMO.md written.
- Smoke results: pass 1 FAILED (first message assertion, pre-fix); pass 2 PASS 142 s (red lkTy5hcWj8lwwA7TF, repair ck4LdlkKY1Me2OPWX -> HNVNoy62AEVTgG835, green FYZkZay9elyrhAGca). Need 3 consecutive passes on the FINAL build (push-8): see .evidence/smoke-3..5.log.
- FINAL: build 0.0.14 (aItcn2NfGmT98boSa) deployed. Smoke passes 3, 4, 5 consecutive PASS on 0.0.12 (98 s, 125 s, 92 s); pass 6 PASS on 0.0.14 (only a log-wording change). Approval-survives-abort verified (s7dA8qc1DrL1oPdga -> CXlkeXT9eUWIJ9GX8). State after: site variant a, prod -> x1nrd0s8qY8NVe6aK, selectors.js original. DONE.

## Session 3b: demo video
- `video/record.ts` (playwright-core + /usr/bin/chromium, recordVideo 1280x720; narration via `uvx edge-tts` en-US-AndrewNeural; ffmpeg mux with adelay per scene mark) runs a LIVE pass and records: title/cast cards, real target site (?token=), real run logs rendered as a terminal (from the API), SVG screenshots, the real steer page (typed steer, clicked Approve with a dialog handler), memory store table, report, green run, close card. Output `video/self-healing-actor-demo.mp4`. Evidence `.evidence/video-N.log`, scene marks `video/work/marks.json`.
- Bugs found BY THE VIDEO FRAMES and fixed in the steer page: (1) snapshot rendering crashed on entries without `data` (`JSON.stringify(undefined).slice`), so the handoff note / incident / first message were never shown; renderer rewritten to be shape-tolerant, per-entry try/catch; (2) entry kind is `pi.tool-result` (hyphen) -> budget counter in main.ts fixed too; (3) a `'\n'` inside the server template literal broke the page script (now `'\\n'`); (4) the recorder's caption overlay blocked the Send button (pointer-events none, lifted above the form).
- Video attempts: 1 failed (caption blocked click), 2 rendered 282 s but page broken, 3 failed (page script syntax error), 4 = after push-11 (build 0.0.17), see .evidence/video-4.log.
- Video attempt 7 (plain-English script, after user feedback "no Beat N, no jargon, explain terms"): SUCCESS, .evidence/video-7.log, 332 s, 13.1 MB, frames verified (cards, log, restart, agent page with notes/case file/first reply, typed message, named approval, close card). Platform reset to baseline afterwards. Scene marks in video/work/marks.json. DEMO.md headings renamed to Step 1-5 and a video pointer added.
