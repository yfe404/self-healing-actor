# Build progress

This is the work log of the builder agent, the AI coding agent that built this repository. The builder agent kept it current during the build. It read this file first after a context reset, which is when its working memory was cleared.

Read it as history. Each entry describes the state when it was written, and later entries supersede earlier ones. For example, stage 7 below says "NOT STARTED", and Session 3 records that work as done.

Related files:

- research facts: [NOTES-research.md](NOTES-research.md)
- decisions: [DECISIONS.md](DECISIONS.md)

Paths under `.evidence/` and `video/work/` name local log files on the builder's machine. Git ignores both folders, so they are not published with the repository.

## Terms used in this log

- **Pi Durable.** The agent framework the repair Actor is built on. It runs the language model and the tools and saves every step, so work survives a crash. Its main object is the harness.
- **Agent memory store.** The Apify key-value store that holds the agent's saved steps. A key-value store is Apify storage that holds named records. Each saved step, which the code calls a commit, is one record.
- **Standby Actor.** An Actor that stays running as a web server at a fixed URL.
- **`FULL_PERMISSIONS`.** The Actor permission level that lets a run open named stores and other Actors.
- **Variant.** The record that switches the target site between layout `a`, the original, and layout `b`, the redesign.
- **Redirector.** The Standby Actor behind the permanent link, a fixed URL that redirects to the agent web page of the live repair run.
- **Conformance tests.** Tests that ship with Pi Durable and check that a storage backend behaves correctly.
- **Task tree.** The list of the agent's unfinished work that a run prints at startup. `pi.generation` is a model request. `pi.tool` is a tool call.
- **Build session.** The session in which the agent first built the scraper. The agent's memory and its saved copies of the page come from it.
- **Build references.** The copies the agent saves at build time: the page HTML, a screenshot, an expected output sample, rules the output must meet, and the selectors. The code calls these fixtures. HTML is the text describing a page. Selectors are patterns that find its fields. The screenshot is a drawing made from that text.
- **Handoff note.** The agent's saved build notes, a note it wrote to itself at the end of the build session.
- **Page comparison.** The report plain code prints before the model is asked anything. The code calls it the diff bundle.
- **Fork.** A new conversation that shares the history of another one up to one entry.
- **Submission.** One request into a conversation, such as the incident. The incident is the stored failure information built from the page comparison.
- **Agent web page.** The page each repair run serves, where people watch, send a message, and approve. The code calls it the steer page or steer UI. To steer means to send the agent a message while it works.
- **Approval check.** The rule that blocks the `promote` tool until a person approves. The code calls it the gate. It is a hook, code that runs before a tool.
- **Test run.** A run of the candidate build against the live site. The code calls it a canary. A build is packaged Actor code, and `candidate` labels a proposed build.
- **Replay safe.** A tool marked safe to repeat can run again after a crash. Other interrupted tools report interruption to the model.
- **Document.** A stored record with a defined shape and version. `ApprovalDoc` holds an approval for one conversation.
- **Snapshot and seq.** A snapshot combines saved writes into one record. `seq` numbers the saved steps. The event stream also calls its initial view of the conversation a snapshot.
- **Smoke pass.** One unattended run of the whole demo by `scripts/smoke.ts`, which checks each step.

## Stage status

1. **Target site, scraper, and red run: DONE.**
   - The site Actor is `yjHmW6kVbl3bK7U68`, served at the [target site Standby URL](https://straightforward-under--shd-target-site.apify.actor). It is a Standby Actor with `FULL_PERMISSIONS`. Opening it needs an Apify token.
   - The scraper is `ctzTh4lGVmdeKVFDl`, build `prod`.
   - Green run `fm9aZ2XhO3fZxkXnF` used variant a. Red run `BAZ42MOrzxqjECP8V` used variant b. Its `DIAGNOSIS` said: 0 items, `li.product` no longer matches.
   - Redirector and webhook: to do after the repair Actor exists.
2. **Key-value storage backend and conformance tests: DONE.**
   - 76 of 76 tests pass, including 25 cases on the real platform. Local evidence: `.evidence/conformance-platform.log`.
   - Keys are `log-NNNNNNNNN` and `snapshot-NNNNNNNNN`, as decision D2 explains.
   - Repair Actor skeleton: DONE. Files: `repair-actor/src/{main,platform,task-tree,models}.ts`, `.actor/`, and the `Dockerfile`. In `mode: probe`, the Actor runs the dummy tools `quick_step`, `slow_steps`, then `quick_step`.
   - Abort and resume: PROVEN LOCALLY. The builder ended the process with `kill -9`, which stops it at once, at 45 seconds, in the middle of `slow_steps`. The rerun replayed 22 records. The task tree showed `pi.tool` ready and `pi.generation` waiting. The model got an `interrupted` result and finished.
   - Platform proof: DONE. Run `0bdXcWi7nj4TGolMe` was aborted at 75 seconds in the middle of `slow_steps`. Its store was `Nh1aaZkm26yBjlM4c`, with a snapshot at seq 25. Run `MRO1LSBjAlHRQicho` resumed it. Its task tree showed `pi.generation #14 waiting > pi.tool slow_steps #16 ready`. The model was told the tool was interrupted, and the run SUCCEEDED.
   - The repair Actor id is `8vQ9TLkdIQfFwnBSg`.
   - The redirector `xS7h2Ij1fM8nKFJno` is live.
   - Webhook `OfpNoTGVYCIc2TG3M` starts the repair Actor when the scraper fails.
3. **Build session: DONE on the platform.**
   - The agent memory store `shd-agent-memory-ctzTh4lGVmdeKVFDl` is `iHR5PW7OXNXvrEBiC`, with 200 commits.
   - Build references: `fixture-html`, `fixture-screenshot.svg`, `fixture-expected-sample`, `fixture-invariants`, `fixture-selectors`.
   - The handoff note names `.price-tag` as chosen and `.amount` as rejected, because `.amount` appears on only 7 of 20 items, as a strikethrough "was" price.
   - `prod` points at build `x1nrd0s8qY8NVe6aK`, version 0.0.7.
   - Local evidence: `.evidence/build-session-2.log`.
   - To rerun, use the command below. The `--fresh` flag deletes the store.

     ```
     cd repair-actor && npx tsx scripts/build-session.ts ctzTh4lGVmdeKVFDl https://straightforward-under--shd-target-site.apify.actor/ --fresh
     ```

   - The page comparison in `src/diff-bundle.ts` and repair mode in `src/main.ts` were WRITTEN and compile, but were NOT YET RUN. Repair mode forks the build conversation at its last entry. It keeps a mapping record, `repair-conversation-<RUN_ID>`, where `<RUN_ID>` is the failed run id. It submits the incident with `requestId` set to the failed run id and kind `apify.incident`.
4. **Fix tools: WRITTEN in `src/agent-tools.ts`, NOT YET RUN in repair mode.** The tools:
   - `read_scraper_source`
   - `write_scraper_file`
   - `build_scraper`, which tags the build `candidate`
   - `run_canary`
   - `read_run`
   - `compare_canary`
   - `set_status`
   - `promote`, replay safe and behind the approval check
   - `write_report`, which ends the investigation
   - `finish_build` and `tag_prod`, for the build session only
5. **Agent web page: WRITTEN in `src/steer-server.ts`, NOT YET TESTED.** Its routes:
   - `GET /` serves the page.
   - `GET /events` is a server-sent event stream, a connection that stays open while the server pushes updates. It sends a snapshot, then batches of events, and every 2 seconds a header with the task tree, the status, and the approval.
   - `POST /steer` submits a message with `whenBusy` set to `steer` and kind `apify.steer`.
   - `POST /approve` commits an `ApprovalDoc`.
6. **Approval check: WRITTEN, NOT YET TESTED.**
   - A `beforeTool` hook on `promote` checks the `ApprovalDoc` every 2 seconds, for up to 30 minutes. `ApprovalDoc` is a document type defined with `defineDoc` as `demo.approval`, scoped to the conversation.
   - A budget hook counts `pi.tool_result` entries.
   - `tagBuild` uses `actor.update({taggedBuilds})`. Still to verify that the platform accepts this.
7. **DEMO.md, smoke.ts, and 3 passes: NOT STARTED.**

## Layout at the time of stages 1 to 6

- `repair-actor/` is a TypeScript Actor with Pi Durable 1.4.0 pinned. `src/storage/{kv-client,apify-kv-storage}.ts` is done, with `test/kv-storage.test.ts`. That folder was later renamed `src/kvstore/`, as decision D11 explains.
- Planned files: `config.ts` at the root, `actors/target-site/main.js`, `actors/scraper/main.js`, `actors/redirector/main.js`, `scripts/deploy.ts`, `scripts/build-session.ts`, `scripts/smoke.ts`, `DEMO.md`, `DECISIONS.md`. The build session script ended up at `repair-actor/scripts/build-session.ts`.

## Next step at that time: local end-to-end test of repair mode

1. Make sure `APIFY_LOCAL_STORAGE_DIR` is unset:

   ```
   cd repair-actor && export APIFY_LOCAL_STORAGE_DIR= ; unset APIFY_LOCAL_STORAGE_DIR
   ```

   With it unset, `main.ts` uses the platform store, because `openAgentStorage` checks `self.onPlatform || !APIFY_LOCAL_STORAGE_DIR`.
2. Write `storage/key_value_stores/default/INPUT.json` with `{actorId: ctzTh4lGVmdeKVFDl, failedRunId: <FRESH_RED_RUN_ID>, mode: repair}`. Replace `<FRESH_RED_RUN_ID>` with the id of a new red run.
3. To get that red run, switch the site to variant b and run the scraper on `prod`.
4. Run `node dist/main.js`.
5. Open `http://localhost:4321` in a browser.
6. Send a message and approve with `curl`, a command-line HTTP tool.
7. Expect a promotion and a report.
8. Then run `apify push --force` and `deploy.ts repair-env` to rebuild, and test on the platform through the webhook.
9. Then write DEMO.md and smoke.ts.

## Session 3 (2026-10-30/31)

- The local end-to-end test of repair mode PASSED in about 100 seconds. Local evidence: `.evidence/repair-local-1.log`. It showed the page comparison, the fork, the acknowledged message, the approval check, the promotion, the report, and a green scraper run, `Usc808h4OD78czg1J` on 0.0.8.
- Bug fixed: the run API takes a build tag or number and rejects a build id. `runScraper` now resolves ids, as decision D14 explains.
- Bug fixed: the first message did not quote the handoff note. The role section of the prompt and the incident text now demand it. The smoke test checks that `.amount` is mentioned, since `.amount` is not in the page comparison.
- Bug fixed: later runs resumed stale submissions left by an aborted run of ANOTHER incident. `main.ts` now abandons submissions whose `requestId` is not the failed run id, using `Conversation.abort` with a 20 second cap. Decision D13 explains this.
- The report now has `elapsedSeconds`, counted from the incident's `computedAt` so it spans restarts, and `computeUnitsThisRun`, read from the run API.
- `scripts/smoke.ts` was written. It resets, runs Steps 1 to 5, and resets again. DEMO.md was written.
- Smoke results:
  - Pass 1 FAILED on the first message check, before the fix.
  - Pass 2 PASSED in 142 seconds. Red run `lkTy5hcWj8lwwA7TF`, repair runs `ck4LdlkKY1Me2OPWX` then `HNVNoy62AEVTgG835`, green run `FYZkZay9elyrhAGca`.
  - Still needed at that point: 3 consecutive passes on the FINAL build, push-8. Local evidence: `.evidence/smoke-3.log` to `.evidence/smoke-5.log`.
- FINAL: build 0.0.14, `aItcn2NfGmT98boSa`, deployed.
  - Smoke passes 3, 4, and 5 PASSED in a row on 0.0.12, in 98, 125, and 92 seconds.
  - Pass 6 PASSED on 0.0.14, which differs from 0.0.12 only in log wording.
  - Approval surviving an abort was verified: run `s7dA8qc1DrL1oPdga`, then run `CXlkeXT9eUWIJ9GX8`.
  - State afterwards: site variant a, `prod` pointing at `x1nrd0s8qY8NVe6aK`, original `selectors.js`. DONE.

## Session 3b: demo video

- `video/record.ts` runs a LIVE pass and records it. It uses:
  - `playwright-core`, a browser automation library, with the browser at `/usr/bin/chromium` and `recordVideo` at 1280x720
  - narration from `uvx edge-tts` with the voice `en-US-AndrewNeural`, where edge-tts is a text-to-speech tool
  - `ffmpeg`, a video tool, to combine picture and sound, with an `adelay` filter that places each scene's narration at its start time
- On screen: title and cast cards, the real target site opened with `?token=`, real run logs drawn as a terminal from the API, the SVG screenshots, and the real agent web page. The recorder types a message into the page and clicks **Approve**, with a handler that answers the name prompt. It also shows the memory store as a table, the report, the green run, and a closing card.
- Output: `video/self-healing-actor-demo.mp4`. Local evidence: `.evidence/video-N.log`. Scene start times: `video/work/marks.json`, also local.
- The video frames revealed four bugs, all fixed:
  1. The page crashed while drawing entries without `data`, at `JSON.stringify(undefined).slice`. So the handoff note, the incident, and the first message never appeared. The drawing code was rewritten to accept any entry shape, with a `try`/`catch` per entry.
  2. The entry kind is `pi.tool-result`, with a hyphen. The budget counter in `main.ts` was fixed too.
  3. A `'\n'` inside the server's template literal broke the page script. It is now `'\\n'`.
  4. The recorder's caption overlay blocked the **Send** button. It now has `pointer-events: none` and sits above the form.
- Video attempts:
  - Attempt 1 failed because the caption blocked a click.
  - Attempt 2 rendered 282 seconds, but the page was broken.
  - Attempt 3 failed on a syntax error in the page script.
  - Attempt 4 ran after push-11, build 0.0.17. Local evidence: `.evidence/video-4.log`.
  - Attempt 7 SUCCEEDED, with a plain-English script written after user feedback: "no Beat N, no jargon, explain terms". Local evidence: `.evidence/video-7.log`. It is 332 seconds and 13.1 MB. Its frames were checked: cards, log, restart, agent web page with notes, incident, and first reply, typed message, named approval, and closing card. The platform was reset to its starting state afterwards. Scene start times are in `video/work/marks.json`, local.
- DEMO.md headings were renamed to Step 1 to 5, and a pointer to the video was added.

## Session 4 (2026-10-31): publication

- A three-model review run (GPT-6 Astra as architect, GPT-6.1 Sol and Claude Opus 5.5 as builders, driven by the fusion-harness extension for pi) rewrote every document, source comment, log message, and the recorder narration in plain English, added `README.md`, `LICENSE`, `.env.example`, and the `--all` flag of `scripts/check-docs.mjs`. Its brief and summary are in `.evidence/`, which is not tracked. It changed no behaviour and made no platform calls. I verified that every log line the smoke script and the recorder wait for still exists in the source.
- Hand edits after the review: the README setup section now states measured costs and timings, and sentences that referred to an "earlier runbook" or to a video with older narration are gone.
- Unexplained platform activity: between 11:39 and 11:44 UTC a complete pass ran on the platform without the smoke script or the recorder. It built scraper 0.0.24, failed run `EndDXkiKocgeZK1sC`, and the webhook started repair run `DCpCoqaVwAXLmdBZY`, which promoted build 0.0.25. Nothing aborted it and nothing reset the platform afterwards, so the website stayed on layout `b` and `prod` pointed at 0.0.25. The recorder's reset repaired this. The review run reported no platform calls, so a Console run-through is the likely cause.
- Push 12 uploaded the revised repair Actor source: build 0.0.20, `0GnGkdjAuof3KiOMp`, SUCCEEDED with the secret set. The deployed log wording now matches the repository.
- Video attempt 8 SUCCEEDED on build 0.0.20 with the revised narration and captions. Local evidence: `.evidence/video-8.log`. The file is 349 seconds and 13.1 MB. The run it recorded was aborted at `Sh1C8bMc3ERBBOUHm` and resumed as `PwMgQ1uCA4ZFkrA8k`. Seven frames were checked: cards, the memory store listing, the restart screen with "some work was cut off by the previous run; resuming it now", and the agent web page proposing build 0.0.26 for approval.
- Video attempt 9 SUCCEEDED and replaced attempt 8. The narration and cards no longer describe the recording or a presentation; they only tell what happens: the owner changes the page, the scheduled run fails, someone aborts the repair run, a colleague sends a message, Dana approves. Local evidence: `.evidence/video-9.log`. The file is 300 seconds and 12.0 MB. Four frames were checked.
- The original project brief is no longer tracked. It stays on disk and is ignored by Git.
- After the recorder's final reset: website layout `a`, `prod` at build `x1nrd0s8qY8NVe6aK` (0.0.7). No smoke pass has run on build 0.0.20; the video pass is the only live evidence for it.
