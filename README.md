# Self-healing Actor demo

This demo repairs an Apify scraper after the website changes its layout. A failed scraper run starts the repair Actor, which runs the AI agent. It uses a language model and tools to inspect the page, change the scraper, and test the fix. Tools are actions supplied by code. A person approves before the fix goes live. The agent saves its work in an Apify key-value store, which holds named records, so it can recover saved work after a restart. You can watch, send a message, and approve through the agent web page that the repair run serves. [Follow the demonstration](DEMO.md).

[Watch the narrated demo video](video/self-healing-actor-demo.mp4): a real 5.5 minute pass shows the failure, repair, stop and restart, audience message, approval, and working scraper. [Recording history](PROGRESS.md).

The video keeps its recorded narration. The [recorder source](video/record.ts) now uses revised wording, as noted in the [publication update](PROGRESS.md#publication-update).

## How it works

1. **Change the website.** The demo hosts its own page of 20 products. Set its `variant` record from `a` to `b` to change the layout and add a cookie banner. [Website code](actors/target-site/main.js).
2. **Run the scraper.** It checks whether enough products have prices. The changed page makes this check fail, so the run records a diagnosis and fails. [Scraper checks](actors/scraper/main.js).
3. **Start the repair automatically.** A webhook, a platform rule that reacts to an event, starts the repair Actor when the scraper fails. It passes the scraper ID and failed run ID. [Webhook setup](scripts/deploy.ts).
4. **Compare the page and recover the notes.** Plain code compares the current page with the copy saved when the agent first built the scraper. The agent receives this page comparison and its saved build notes, the notes it wrote for itself when it built the scraper. [Page comparison](repair-actor/src/diff-bundle.ts) and [repair startup](repair-actor/src/main.ts).
5. **Investigate and test.** The agent changes the scraper source, builds a packaged version of it, and runs that build against the live website. You can send a message from the agent web page while it works. If you stop the repair run, restart it with the same input to continue the same investigation. [Tools](repair-actor/src/agent-tools.ts) and [presenter steps](DEMO.md).
6. **Approve the fix.** The approval check waits for someone to approve from the agent web page. The `promote` tool then moves `prod`, the label selecting the build for normal scraper runs, to the approved build. The report records the entered name and the result. [Approval and reporting](repair-actor/src/agent-tools.ts).
7. **Run the scraper again.** The presenter starts a run using `prod` and checks that the prices return. [Final presenter step](DEMO.md).

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
- [`self-healing-actor-demo-prompt.md`](self-healing-actor-demo-prompt.md): the original project brief, preserved unchanged.
- [`video/`](video/): the existing video and the program that records it.

The working directory also has local-only entries outside the published project map. The [ignore rules](.gitignore) exclude evidence and installed software, and the [work log](PROGRESS.md) identifies local evidence paths.

- `.evidence/`: local evidence and publication-task files, excluded from publication.
- `.git/`: local Git repository data, outside the published project files.
- `node_modules/`: locally installed software, excluded from publication.

## Run it yourself

### Choose the existing deployment or local checks

**The live commands target the existing demo account.** They use `straightforward_understanding`, its Actor names, and its original scraper build. Only run them if you are authorized to change that deployment. [Account settings](config.ts) and [reset implementation](scripts/smoke.ts).

**An unchanged checkout is not a fresh-account installer.** Account references also appear in the [repair Actor's platform code](repair-actor/src/platform.ts) and [recorder](video/record.ts). The unattended script resets to build `x1nrd0s8qY8NVe6aK`. Recreating the demo in another account requires adapting those references and creating the agent's saved memory. The commands below do not perform that adaptation. [Reset build](scripts/smoke.ts) and [memory creation](repair-actor/scripts/build-session.ts).

### Prerequisites

- Use Node.js, the program that runs the JavaScript tools, and npm, its package installer. The repair package requires Node `>=22.19.0`. The recorded local environment uses Node 26, and npm 12 writes its lockfile, the file listing resolved package versions. The documented npm 10 rejection concerns the platform build image. Local installation with older npm versions is not verified here. [Environment notes](NOTES-research.md), [version requirement](repair-actor/package.json), and [lockfile caveat](DECISIONS.md).
- For live steps, obtain an `APIFY_TOKEN` authorized for the configured Actors and stores. Obtain an `OPENROUTER_API_KEY` if you configure the repair Actor or recreate its saved memory. OpenRouter is the service through which the agent accesses language models. [Credential locations](.env.example), [deployment requirements](scripts/deploy.ts), and [model decision](DECISIONS.md).
- For a live presentation, use a browser signed in to the Apify Console and follow the [presenter's preparation](DEMO.md).
- For uploading the repair Actor, install and authenticate the Apify command-line tool so you can run `apify push`. This is separate from running the existing deployment. [Upload decision](DECISIONS.md).
- For recording a new video, also provide the Chromium browser at `/usr/bin/chromium`, the Python tool runner `uvx` to run the speech generator `edge-tts`, and the media tools `ffmpeg` and `ffprobe`. These are not needed for the local checks or the browser presentation. [Recorder requirements](video/record.ts).

### Install and check locally

Start in the repository root. The package files define separate installations for the [root tools](package.json), [repair Actor](repair-actor/package.json), and [recorder](video/package.json). The commands use npm's `npx` launcher to run installed tools. `tsx` runs TypeScript source files, and `tsc` checks and compiles them. [Tool dependencies](package.json).

Each installation and check below has an unrecorded duration. These steps do not start Actors or make model requests. They leave platform state unchanged. Package installation downloads software, and compilation writes local output. [Package commands](repair-actor/package.json), [compiler settings](repair-actor/tsconfig.json), and [local tests](repair-actor/test/kv-storage.test.ts).

1. Install the root tools:

   ```sh
   npm ci
   ```

2. Install the repair Actor's tools:

   ```sh
   npm ci --prefix repair-actor
   ```

3. Install the recorder's tools:

   ```sh
   npm ci --prefix video
   ```

4. Disable optional platform tests before running the local tests. `KV_CONFORMANCE_PLATFORM=1` enables tests that create and delete real stores. [Platform-test switch](repair-actor/test/kv-storage.test.ts).

   ```sh
   unset KV_CONFORMANCE_PLATFORM
   ```

5. Check the documentation. `--all` also includes new Markdown files that Git does not yet track. [Checker implementation](scripts/check-docs.mjs).

   ```sh
   node scripts/check-docs.mjs
   node scripts/check-docs.mjs --all
   ```

6. Compile the repair code and its scripts, then run the local tests. TypeScript compilation checks the source types, and Vitest runs the tests. [Repair commands](repair-actor/package.json) and [script compiler settings](repair-actor/tsconfig.scripts.json).

   ```sh
   cd repair-actor && npx tsc -p tsconfig.json && npx tsc -p tsconfig.scripts.json && npx vitest --run
   ```

7. Check the [recorder's](video/record.ts) types without running it:

   ```sh
   cd ../video && npx tsc --noEmit --strict --module nodenext --target es2023 --moduleResolution nodenext --skipLibCheck --types node record.ts
   ```

8. Return to the root and check the [deployment](scripts/deploy.ts) and [unattended-demo](scripts/smoke.ts) scripts without running them:

   ```sh
   cd .. && npx tsc --noEmit --strict --module nodenext --target es2023 --moduleResolution nodenext --skipLibCheck --types node scripts/smoke.ts scripts/deploy.ts
   ```

### Set credentials for live commands

The scripts read environment variables from the shell. Copying `.env.example` to `.env` does not load them. Use the exports below instead. Replace `YOUR_APIFY_TOKEN` and `YOUR_OPENROUTER_API_KEY` with your credentials from the locations in [`.env.example`](.env.example). [Environment reads](scripts/deploy.ts).

1. Export your Apify token:

   ```sh
   export APIFY_TOKEN='YOUR_APIFY_TOKEN'
   ```

2. If you will configure the repair Actor or create memory, export your OpenRouter key:

   ```sh
   export OPENROUTER_API_KEY='YOUR_OPENROUTER_API_KEY'
   ```

These exports only set local shell values. They have no platform or model cost and leave platform state unchanged. Their duration is unrecorded. They do not configure the deployed Actor. The `repair-env` command below sets its model key as a secret. [Secret configuration](scripts/deploy.ts).

### Run the existing demo

**These commands change live state and use platform resources.** A full pass also makes model requests. Dollar costs are not recorded in the published runbook or work log. Treat each cost as unknown. The report records Apify compute units, its resource-usage measure, for the current repair run only. [Runbook](DEMO.md), [work log](PROGRESS.md), and [report accounting](DECISIONS.md).

1. To prepare a browser presentation, reset the existing deployment:

   ```sh
   npx tsx scripts/smoke.ts reset
   ```

   The runbook allocates 5 minutes for preparation including this reset. It does not record the reset command's duration separately. The command restores layout `a`, the original `selectors.js`, and the original `prod` build. It keeps the agent memory. Platform cost is unrecorded. [Preparation and cleanup](DEMO.md) and [reset code](scripts/smoke.ts).

2. Follow the numbered steps in [the presenter runbook](DEMO.md). Its five steps allocate 1, 1, 2, 1, and 3 minutes. A successful presentation ends with the repaired build live and the changed website still on layout `b`. It also leaves the report and investigation in storage. Platform and model costs are unrecorded. [Presenter sequence](DEMO.md).

3. After the presentation, restore the starting state:

   ```sh
   npx tsx scripts/smoke.ts reset
   ```

   Duration and platform cost are unrecorded. The command restores the site, source, and `prod` label. It keeps the saved investigation. [Cleanup](DEMO.md).

For an unattended check instead of a presentation, run the smoke test, the script that performs the whole demonstration and checks its results:

```sh
npx tsx scripts/smoke.ts
```

The runbook estimates 5 to 8 minutes. Historical passes report 92 to 142 seconds measured by the script. Neither observation guarantees the next pass's duration. The script resets before the pass and after success. It retains memory, reports, and run history. If a check fails, it can exit before the final reset. Platform and model costs are unrecorded. [Timing records](PROGRESS.md), [runbook estimate](DEMO.md), and [script sequence](scripts/smoke.ts).

### Update the existing deployment when needed

Skip this section if you only want to use the deployed demo. The upload commands replace platform source or settings. They are maintenance steps for the configured account. [Deployment implementation](scripts/deploy.ts).

1. From the root, upload and build the repair Actor:

   ```sh
   cd repair-actor && apify push --force
   ```

   Duration and platform cost are unrecorded. This replaces the Actor version. You must configure its secret again afterwards. [Push-order decision](DECISIONS.md).

2. Return to the root and configure its model key:

   ```sh
   cd .. && npx tsx scripts/deploy.ts repair-env
   ```

   Duration and platform cost are unrecorded. This stores `OPENROUTER_API_KEY` as a secret, grants `FULL_PERMISSIONS`, and rebuilds the Actor. That permission level allows access to named stores and other Actors. The command waits up to 600 seconds for the build. This limit does not predict its duration. [Secret and permission setup](scripts/deploy.ts).

3. If you also need to upload the other Actors and configure the failed-run notification, run:

   ```sh
   npx tsx scripts/deploy.ts all
   ```

   Duration and platform cost are unrecorded. This creates or updates the website, scraper, and permanent-link Actor, builds them, and configures the webhook. It creates layout `a` only if the `variant` record is absent. It builds a new scraper version labelled `prod`. It does not recreate the agent's memory or run `repair-env`. The script waits up to 300 seconds for each build. [Deployment sequence](scripts/deploy.ts).

4. To restore the recorded demo's starting state after maintenance, run:

   ```sh
   npx tsx scripts/smoke.ts reset
   ```

   Duration and platform cost are unrecorded. This points `prod` back to the recorded original build. The new scraper build stays available under its own ID. [Reset implementation](scripts/smoke.ts).

### Recreate saved build notes only when necessary

The build session is the initial conversation in which the agent builds the scraper, tests it, and saves its reasons and build references. Build references are copies of the page, chosen page markers, expected output, and output-checking rules. The existing demo already has this memory. The repair Actor needs it before it can investigate a failure. [Recorded build session](PROGRESS.md) and [startup requirement](repair-actor/src/main.ts).

**The `--fresh` flag deletes the existing agent memory store.** Do not use it as routine preparation. It removes the saved investigations as well as the build notes. [Deletion code](repair-actor/scripts/build-session.ts).

If you intend to replace that memory, first restore layout `a` with the reset command above. Then, from the root, run the recorded initialization command:

```sh
cd repair-actor && npx tsx scripts/build-session.ts ctzTh4lGVmdeKVFDl https://straightforward-under--shd-target-site.apify.actor/ --fresh
```

The script describes the duration as a few minutes. It supplies values of 40 tool calls and 30 minutes, but the build session does not enforce those limits. Its tool-call counter returns zero, and its tool setup omits the budget check used during repair. Do not treat these values as a spending cap. [Build-session settings](repair-actor/scripts/build-session.ts) and [tool setup](repair-actor/src/agent-tools.ts).

The script runs locally while using platform storage, builds, scraper runs, and OpenRouter. Dollar cost is unrecorded in the published work log. On success it leaves new memory, build references, build notes, and a tested build labelled `prod`. [Build-session implementation](repair-actor/scripts/build-session.ts).

The reset and recorder still refer to the old original build. Recreating memory does not update those constants. It also creates a new store ID. The agent-memory Console link in the runbook and `MEMORY_STORE` in the recorder still use the deleted store's ID. Review these references before reusing the runbook or recorder. [Store replacement](repair-actor/scripts/build-session.ts), [runbook link](DEMO.md), [smoke reset](scripts/smoke.ts), and [recorder references](video/record.ts).

### Record another video only when needed

From the repository root, run the recorder only if you intend to perform another live pass and replace the video:

```sh
cd video && npx tsx record.ts
```

The runbook estimates about 7 minutes. The recorder makes platform and model requests, generates speech, and writes video work files. Dollar cost is unrecorded. On success it overwrites the video and resets the website, scraper source, and `prod` label. An error can stop it before that reset. [Recording command](DEMO.md) and [recorder sequence](video/record.ts).

## What is real, what is simplified, what is fragile

### What is real

- The failed scraper starts a real repair run. The agent edits source, builds and tests the change, waits for approval, and changes the production build label. The unattended script checks this sequence. [Runbook checks](DEMO.md).
- The memory comes from a real build session. The saved notes explain why the agent chose `.price-tag` and rejected `.amount`, which appears on 7 of 20 products as an old price. [Build history](PROGRESS.md).
- Stop and restart behavior has local and platform evidence. Approval surviving an abort also has recorded run IDs. [Verification history](PROGRESS.md).
- Smoke passes 3, 4, and 5 pass consecutively on build 0.0.12. Pass 6 passes on 0.0.14, whose change is log wording. [Recorded results](PROGRESS.md).
- The video records the real website, run logs, and agent web page. It fetches logs through Apify's API, the interface that programs call to use the platform. [Recording decision](DECISIONS.md).

### What is simplified

- The website belongs to the demo and switches between two controlled layouts. The presenter starts the scraper manually to represent a scheduled run. [Presenter sequence](DEMO.md).
- The before and after “screenshots” are SVG drawings, pictures generated from the page's code. The repair does not capture them with a browser. The recorder itself uses Chromium. [Screenshot and recording decisions](DECISIONS.md).
- The video uses generated speech from fixed text. Its title, cast, and closing cards are staged. [Recording decision](DECISIONS.md).
- The report's elapsed time spans restarts. Its compute-unit total covers only the current run, so it is not the total resource use of the investigation. [Accounting decision](DECISIONS.md).

### What is fragile

- The recorded smoke passes precede the later budget-counter and agent-web-page fixes. The successful video attempt exercises later code, but it does not replace the smoke assertions. These publication edits have local checks only. [Build and recording history](PROGRESS.md).
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
| Beat | An older name for a numbered demonstration step. [Writing history](PROGRESS.md). |
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
