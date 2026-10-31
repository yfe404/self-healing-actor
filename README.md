# Self-healing Actor demo

This demo repairs an Apify scraper after the website changes its layout. A failed scraper run starts the repair Actor, which runs the AI agent. It uses a language model and tools to inspect the page, change the scraper, and test the fix. Tools are actions supplied by code. A person approves before the fix goes live. The agent saves its work in an Apify key-value store, which holds named records, so it can recover saved work after a restart. You can watch, send a message, and approve through the agent web page that the repair run serves. [Follow the demonstration](DEMO.md).

[Watch the narrated demo video](video/self-healing-actor-demo.mp4). It is a 5 minute recording of one real pass: the failure, the repair, a stop and restart, a message from the audience, the approval, and the working scraper. [How it was recorded](DECISIONS.md#d17-the-demo-video-is-a-recording-of-a-real-pass).


## How it works

1. **Change the website.** The demo hosts its own page of 20 products. Set its `variant` record from `a` to `b` to change the layout and add a cookie banner. [Website code](actors/target-site/main.js).
2. **Run the scraper.** It checks whether enough products have prices. The changed page makes this check fail, so the run records a diagnosis and fails. [Scraper checks](actors/scraper/main.js).
3. **Start the repair automatically.** A webhook, a platform rule that reacts to an event, starts the repair Actor when the scraper fails. It passes the scraper ID and failed run ID. [Webhook setup](scripts/deploy.ts).
4. **Compare the page and recover the notes.** Plain code compares the current page with the copy saved when the agent first built the scraper. The agent receives this page comparison and its saved build notes, the notes it wrote for itself when it built the scraper. [Page comparison](repair-actor/src/diff-bundle.ts) and [repair startup](repair-actor/src/main.ts).
5. **Investigate and test.** The agent changes the scraper source, builds a packaged version of it, and runs that build against the live website. You can send a message from the agent web page while it works. If you stop the repair run, restart it with the same input to continue the same investigation. [Tools](repair-actor/src/agent-tools.ts) and [step-by-step runbook](DEMO.md).
6. **Approve the fix.** The approval check waits for someone to approve from the agent web page. The `promote` tool then moves `prod`, the label selecting the build for normal scraper runs, to the approved build. The report records the entered name and the result. [Approval and reporting](repair-actor/src/agent-tools.ts).
7. **Run the scraper again.** The next scraper run uses `prod`, and the prices return.

## Repository map

- [`.env.example`](.env.example): names the two credentials and where you obtain them.
- [`.gitignore`](.gitignore): excludes installed software, compiled output, local storage, logs, and recording work files from Git.
- [`actors/`](actors/): the website, scraper, and permanent-link server, which redirects you to the current repair run.
- [`config.ts`](config.ts): the existing account, Actor names, model choices, and demo settings.
- [`DECISIONS.md`](DECISIONS.md): numbered implementation decisions and their reasons.
- [`DEMO.md`](DEMO.md): presenter steps, expected results, explanations, and fallbacks.
- [`LICENSE`](LICENSE): the MIT licence.
- [`NOTES-research.md`](NOTES-research.md): the package interfaces and platform facts used during development.
- [`package-lock.json`](package-lock.json): the resolved versions of the root project's required software.
- [`package.json`](package.json): root commands and required software.
- [`PROGRESS.md`](PROGRESS.md): historical results, run IDs, timings, and recording attempts.
- [`README.md`](README.md): this introduction and setup guide.
- [`repair-actor/`](repair-actor/): the repair agent, its storage implementation, initial memory-creation script, and tests.
- [`scripts/`](scripts/): deployment, unattended demonstration, platform investigation, and documentation checks.
- [`video/`](video/): the existing video and the program that records it.

## Run it yourself

The live commands use the account `straightforward_understanding`, the Actor names in [`config.ts`](config.ts), and fixed store, run, and build IDs in [`scripts/smoke.ts`](scripts/smoke.ts), [`video/record.ts`](video/record.ts), and [`DEMO.md`](DEMO.md). Run them only if you may change that deployment. To rebuild the demo in another account, follow [Rebuild in another account](#rebuild-in-another-account).

### Prerequisites

- Node.js 22.19 or later and npm. The repository was built with Node 26 and npm 12. The platform build image uses npm 10, which is why the [Dockerfile](repair-actor/Dockerfile) runs `npm install` instead of `npm ci`. See [D11](DECISIONS.md#d11-the-repair-actors-source-folder-is-srckvstore).
- `APIFY_TOKEN`, a personal API token from [Apify Console](https://console.apify.com/settings/integrations). Every live command reads it from the shell.
- `OPENROUTER_API_KEY`, a key from [OpenRouter](https://openrouter.ai/settings/keys), the service the agent uses to reach language models. Only the deployment and memory-creation commands need it.
- The Apify CLI, installed with `npm install -g apify-cli` and signed in with `apify login`, to upload the repair Actor.
- To record a new video: Chromium at `/usr/bin/chromium`, `uvx` from [uv](https://docs.astral.sh/uv/) to run the speech generator `edge-tts`, and `ffmpeg` with `ffprobe`.

[`.env.example`](.env.example) lists the two credentials. Export them in your shell. The scripts do not read a `.env` file.

```sh
export APIFY_TOKEN='YOUR_APIFY_TOKEN'
export OPENROUTER_API_KEY='YOUR_OPENROUTER_API_KEY'
```

### Check the repository locally

These commands touch nothing on the platform. Together they take about two minutes on a laptop.

1. Install the three sets of dependencies:

   ```sh
   npm ci && npm ci --prefix repair-actor && npm ci --prefix video
   ```

2. Check the Markdown files for broken links and forbidden wording. The checker is [`scripts/check-docs.mjs`](scripts/check-docs.mjs).

   ```sh
   node scripts/check-docs.mjs
   ```

3. Compile the repair Actor and run its storage tests. The tests use the conformance suite that ships with Pi Durable. Setting `KV_CONFORMANCE_PLATFORM=1` adds 25 cases that create and delete real stores, so leave it unset for a local check. See [the test file](repair-actor/test/kv-storage.test.ts).

   ```sh
   cd repair-actor && npx tsc -p tsconfig.json && npx tsc -p tsconfig.scripts.json && npx vitest --run && cd ..
   ```

4. Type-check the scripts and the recorder without running them:

   ```sh
   npx tsc --noEmit --strict --module nodenext --target es2023 --moduleResolution nodenext --skipLibCheck --types node scripts/smoke.ts scripts/deploy.ts
   cd video && npx tsc --noEmit --strict --module nodenext --target es2023 --moduleResolution nodenext --skipLibCheck --types node record.ts && cd ..
   ```

### Run the demo on the existing deployment

Each pass starts real runs. Measured on this account, one repair run costs between 0.02 and 0.04 USD of Apify usage, and a scraper run or build costs under 0.001 USD. A full pass therefore costs under 0.10 USD on Apify, plus the OpenRouter model calls, which this project did not measure per pass.

1. Put the platform in its starting state: website layout `a`, the original `selectors.js`, and `prod` pointing at the original build. This takes a few seconds and keeps the agent's memory.

   ```sh
   npx tsx scripts/smoke.ts reset
   ```

2. Either follow the presenter runbook in [`DEMO.md`](DEMO.md) in the Apify Console, or run the unattended check:

   ```sh
   npx tsx scripts/smoke.ts
   ```

   The unattended check performs Steps 1 to 5, asserts each result, and resets afterwards. Four recorded passes took between 92 and 142 seconds. See [the pass log](PROGRESS.md#session-3-2026-10-3031). If an assertion fails, the script stops before its final reset. Run the reset command again.

3. To record a new video, run the recorder. It resets before and after, takes about 7 minutes, and overwrites `video/self-healing-actor-demo.mp4`.

   ```sh
   cd video && npx tsx record.ts
   ```

### Update the deployed repair Actor

After changing anything under `repair-actor/`, upload it and set its secret again. `apify push --force` replaces the Actor version, which drops the secret, so the second command restores it and rebuilds. See [D12](DECISIONS.md#d12-push-order-and-permissions). Together the two commands take three to five minutes.

```sh
cd repair-actor && apify push --force && cd ..
npx tsx scripts/deploy.ts repair-env
```

### Rebuild in another account

The repository is not an installer. To reproduce the demo elsewhere:

1. Change `user` in [`config.ts`](config.ts) to your account name.
2. Deploy the website, the scraper, the permanent link, and the webhook. This builds each Actor and creates the website's `variant` record if it is missing.

   ```sh
   npx tsx scripts/deploy.ts all
   ```

3. Upload the repair Actor and set its secret, as in [Update the deployed repair Actor](#update-the-deployed-repair-actor).
4. Create the agent's memory by letting it build the scraper once. The script is [`repair-actor/scripts/build-session.ts`](repair-actor/scripts/build-session.ts). It takes a few minutes, uses OpenRouter, and leaves a tested build tagged `prod`. The `--fresh` flag deletes an existing memory store, so use it only on a new account or when you intend to discard the saved investigations.

   ```sh
   cd repair-actor && npx tsx scripts/build-session.ts SCRAPER_ACTOR_ID https://YOUR_ACCOUNT--shd-target-site.apify.actor/ --fresh && cd ..
   ```

   `SCRAPER_ACTOR_ID` is the scraper's Actor ID printed by the deploy command. `YOUR_ACCOUNT` is your account name with underscores replaced by hyphens, as the platform prints it.
5. Replace the hardcoded IDs: `ORIGINAL_BUILD` in [`scripts/smoke.ts`](scripts/smoke.ts), the store and Actor IDs in [`video/record.ts`](video/record.ts), and the Console links in [`DEMO.md`](DEMO.md).

## What is real, what is simplified, what is fragile

### What is real

- The failed scraper starts a real repair run. The agent edits source, builds and tests the change, waits for approval, and changes the production build label. The unattended script checks this sequence. [Runbook checks](DEMO.md).
- The memory comes from a real build session. The saved notes explain why the agent chose `.price-tag` and rejected `.amount`, which appears on 7 of 20 products as an old price. [Build history](PROGRESS.md).
- Stop and restart behavior has local and platform evidence. Approval surviving an abort also has recorded run IDs. [Verification history](PROGRESS.md).
- Smoke passes 3, 4, and 5 pass consecutively on build 0.0.12. Pass 6 passes on 0.0.14, whose change is log wording. [Recorded results](PROGRESS.md).
- The video records the real website, run logs, and agent web page. It fetches logs through Apify's API, the interface that programs call to use the platform. [Recording decision](DECISIONS.md).

### What is simplified

- The website belongs to the demo and switches between two controlled layouts. In the demo, the scraper is started by hand to stand in for a scheduled run. [Runbook](DEMO.md).
- The before and after “screenshots” are SVG drawings, pictures generated from the page's code. The repair does not capture them with a browser. The recorder itself uses Chromium. [Screenshot and recording decisions](DECISIONS.md).
- The video uses generated speech from fixed text. Its title, cast, and closing cards are staged. [Recording decision](DECISIONS.md).
- The report's elapsed time spans restarts. Its compute-unit total covers only the current run, so it is not the total resource use of the investigation. [Accounting decision](DECISIONS.md).

### What is fragile

- The four recorded smoke passes ran on builds 0.0.12 and 0.0.14. Later builds changed the agent web page, the budget counter, and log wording. The video recordings exercised those later builds, but no smoke pass has been repeated on them. [Build and recording history](PROGRESS.md).
- Nobody has clicked through the complete runbook in a browser yet. Its steps have been exercised through the same API calls. You should do a dry run before presenting. [Verification limit](DECISIONS.md).
- Anyone with the agent web page link can approve and enter a name. The run's web address needs no token. The handler records the entered name without verifying the person's identity. [Approval step](DEMO.md), [URL access](DECISIONS.md), and [approval handler](repair-actor/src/steer-server.ts).
- Stopping a run can interrupt a model request instead of a tool call. The recorded three smoke passes do that. Completed calls stay complete. After restart, tools marked safe to repeat can run again. The code calls this replay safe. Other interrupted tools report interruption to the model. [Restart caveats](DEMO.md) and [replay rules](NOTES-research.md).
- A different failed run abandons unfinished investigations from earlier failures. Restart with the same failed run ID to continue the same investigation. [Stale-work decision](DECISIONS.md).
- A repair can fail its test or exhaust its budget. The runbook gives 60 tool calls and 40 minutes. If the agent gives up, its report says so and `prod` stays unchanged. [Failure fallback](DEMO.md).
- Uploading the repair Actor replaces version settings, so you must apply its secret again. Do not rename `src/kvstore/` to `src/storage/`, because the upload tool excludes folders named `storage`. [Upload caveats](DECISIONS.md).

## Glossary

The log and source keep some technical names. Use these explanations when you encounter them. [Runbook terminology](DEMO.md) and [package terminology](NOTES-research.md).

| Term | Plain meaning |
| --- | --- |
| Agent framework, Pi Durable | The package `@earendil-works/pi-durable` runs the model and tools and saves their progress. This project pins version 1.4.0. [Package choice](DECISIONS.md). |
| Agent memory store | The key-value store containing saved work, build references, and investigations. [Memory layout](PROGRESS.md). |
| Agent web page, steer page, Live view | The page served by a repair run where you watch, send messages, and approve. **Live view** is the Console tab that opens it. [Page instructions](DEMO.md). |
| Approval check, gate | Code that waits for a saved approval before the `promote` tool runs. [Approval decision](DECISIONS.md). |
| API | The interface a program calls to use platform features such as starting a run or reading storage. [Platform calls](scripts/deploy.ts). |
| Baseline | The original website layout, scraper source, and production build restored before a demonstration. [Reset](scripts/smoke.ts). |
| Build, build ID, build number | A build is packaged Actor code. Its ID identifies that build, and its build number is a version-like label such as `0.0.8`. The run API accepts a build number or tag, a label pointing to a build. [Build addressing](DECISIONS.md). |
| Build session | The initial conversation where the agent builds and tests the scraper and saves its notes. [Build script](repair-actor/scripts/build-session.ts). |
| Candidate, canary, test run | `candidate` labels a proposed build. A canary is the test run of that build against the live site. [Test tools](repair-actor/src/agent-tools.ts). |
| Cheerio | The library that reads the website's HTML, the text describing its page structure. [Scraper](actors/scraper/main.js). |
| Commit, saved step | One all-or-nothing write of agent changes to storage. It is unrelated to a Git commit of source files. [Storage decision](DECISIONS.md). |
| Compute unit | Apify's measure of the computing resources a run uses. [Report explanation](DEMO.md). |
| Conformance tests | Tests supplied by Pi Durable that check whether a storage implementation follows its rules. [Test setup](repair-actor/test/kv-storage.test.ts). |
| Container | The environment in which an Actor run executes. Its web address changes when you start a new repair run. [Restart explanation](DEMO.md). |
| Conversation, transcript, entry | The conversation is the stored record the model sees. That record is the transcript. Each message or event is an entry. [Package terminology](NOTES-research.md). |
| Dataset | Apify's collection of output rows. The scraper writes products, and the repair writes a report row. [Output examples](DEMO.md). |
| Deterministic | The same input gives the same result. The page comparison uses ordinary code before asking the model. [Comparison implementation](repair-actor/src/diff-bundle.ts). |
| Diff bundle, page comparison | The report of changes between the saved page and the current one, together with the failed run's results. [Comparison implementation](repair-actor/src/diff-bundle.ts). |
| Document | A stored record with a defined shape and version that belongs to a conversation or session. Approval and status use these records. [Record definitions](repair-actor/src/agent-tools.ts). |
| Durable | Able to recover saved progress after the process stops, using stored records. [Storage decisions](DECISIONS.md). |
| Fill rate | The share of scraped items that contain a value for a field, such as price. [Output check](actors/scraper/main.js). |
| Fixture, build reference, invariant | A fixture is a build reference such as the saved page or expected output. Invariants are the rules later output should meet, including item-count and fill-rate limits. [Reference records](repair-actor/src/fixtures.ts) and [initial rules](repair-actor/scripts/build-session.ts). |
| Fork | A new conversation sharing another conversation's history up to an entry. This lets a repair use the build conversation. [Repair startup](repair-actor/src/main.ts). |
| Handoff, saved build notes | The agent writes a note and starts a shorter conversation with that note visible. Its earlier reasoning remains stored. [Runbook explanation](DEMO.md). |
| Harness | Pi Durable's main object, which opens storage, runs the agent, and resumes work. [Interface notes](NOTES-research.md). |
| Hook | Code that runs before or after a tool. The approval check runs before `promote`. [Approval decision](DECISIONS.md). |
| Incident, diagnosis | An incident is the stored failure information given to the agent. It includes the page comparison. `DIAGNOSIS` is the scraper's stored explanation of its failure. [Incident code](repair-actor/src/diff-bundle.ts) and [scraper](actors/scraper/main.js). |
| Key-value store, KV store | Apify storage where a key names a record. This project uses it for the website setting and agent memory. [Storage uses](DEMO.md). |
| Memo | A stored result a tool or hook can read again after restart. [Package interface](NOTES-research.md). |
| Model turn, generation | A request to the language model that produces its next response or tool calls. The task list labels this `pi.generation`. [Restart explanation](DEMO.md). |
| Permanent link, stable link, redirector | The fixed address that redirects to the currently running repair Actor's web page. [Redirect server](actors/redirector/main.js). |
| Production, prod, promotion | Production is the version used for normal scraper runs. `prod` is its build label. Promotion moves that label to the approved build. [Final step](DEMO.md). |
| Replay, replay safe | Recovery reads saved changes again. An interrupted tool marked replay safe can run again. Other interrupted tools return an interruption to the model. [Recovery rules](NOTES-research.md). |
| Reset | The demo reset restores its original site, source, and build. The conversation reset keeps saved build notes visible to the model. These are separate operations. [Demo reset](scripts/smoke.ts) and [conversation interface](NOTES-research.md). |
| Selector, CSS class | A selector is a pattern used to find part of an HTML page. A CSS class is a label on a page element that a selector can match. [Scraper selectors](actors/scraper/selectors.js). |
| Sequence, seq, snapshot, head | `seq` numbers saved steps. A snapshot stores the accumulated writes every 25 steps. `head` records a snapshot's sequence number, but startup does not trust it. [Storage decisions](DECISIONS.md). |
| Smoke test, smoke pass | The unattended script that performs the demo and checks its results. A pass is one execution of that sequence. [Test script](scripts/smoke.ts). |
| Standby Actor | An Actor configured to answer web requests at a fixed URL without a manual start. Here its URL requires an Apify token. [Hosting and access](DECISIONS.md). |
| Steer | Send a message while the agent works. The message waits for the next model turn without stopping the running tool. [Message step](DEMO.md). |
| Storage backend, write-ahead log | The code that saves agent data. It writes each change to storage before applying it in working memory. [Storage design](DECISIONS.md). |
| Submission, request ID | One request into a conversation. Reusing its request ID retrieves the existing request instead of making another. [Submission rules](NOTES-research.md). |
| Tag | A label pointing to a build, such as `prod` or `candidate`. [Build labels](DECISIONS.md). |
| Task, task tree, checkpoint | A task is a model request or tool call. The task tree lists unfinished work and its state. A checkpoint records how far a task got. [Restart explanation](DEMO.md). |
| Tool, tool call | An action the agent can request from code. A tool call is one use of that action, such as `fetch_page` or `build_scraper`. [Tool definitions](repair-actor/src/agent-tools.ts). |
| Variant | The website setting selecting original layout `a` or changed layout `b`. [Website](actors/target-site/main.js). |
| Webhook | A platform rule that calls a URL when an event happens. This demo reacts to `ACTOR.RUN.FAILED`. [Setup](scripts/deploy.ts). |

[MIT licence, copyright 2026 yfe404](LICENSE).
