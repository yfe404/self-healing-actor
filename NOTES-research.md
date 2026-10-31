# Research notes

The builder agent, the AI coding agent that built this repository, wrote these notes on 2026-10-30, before it wrote any code. They record the facts the code is written against. Read them if you want to change the code. The final decisions are in [DECISIONS.md](DECISIONS.md).

## Terms used in these notes

- **Pi Durable.** The npm package `@earendil-works/pi-durable`, the agent framework the repair Actor is built on. It runs the language model and the tools and saves every step to storage, so work survives a crash.
- **Harness.** Pi Durable's main object. It opens the storage, runs the agent, and resumes unfinished work after a restart.
- **Storage backend.** The code that saves Pi Durable's data somewhere. This project writes one that saves to an Apify key-value store, which is Apify storage that holds named records.
- **Commit and seq.** A commit is one all-or-nothing write to storage, here called a saved step. Each commit gets a sequence number, `seq`, that grows by one each time.
- **Conversation and entry.** A conversation is the transcript the model sees. Each message or event in it is an entry.
- **Task.** One unit of work, such as a model request or a tool call.
- **Submission.** One request into a conversation, such as the incident or a message from a person.
- **Document.** A typed, versioned record that belongs to a conversation or a session. Typed means it has a fixed shape. Versioned means each change makes a new version.
- **Hook.** Code that runs before or after a tool.
- **Memo.** A stored result that a tool or hook can read again after a restart.
- **Replay safe.** After a crash, a tool marked replay safe runs again. Any other tool that was running is reported to the model as interrupted.
- **Conformance suite.** Tests that ship with Pi Durable and check that a storage backend behaves correctly.
- **Standby Actor.** An Actor that stays running as a web server at a fixed URL.

## Pinned versions

The code depends on these exact versions, installed in `repair-actor/`:

- `@earendil-works/pi-durable@1.4.0`, the agent framework
- `pi-ai@1.4.0`, the library that connects to model providers
- `chord@1.4.0`, the library behind the context object that every call takes and behind the task graph
- `apify-client@2.25.0`, Apify's JavaScript API client

During the build, the builder agent kept two reference copies on its own machine. They are not part of this repository:

- `/tmp/pi-durable-probe/package`: the npm 1.4.0 package, compiled code and README.
- `/tmp/pi-repo/packages/durable`: the git HEAD, which is newer than 1.4.0. Its `Storage.commit` signature differs, so do not copy from it without checking.

## Pi Durable 1.4.0 storage interface

This is the interface a storage backend must implement, from `dist/types.d.ts` in the package:

```ts
interface Storage {
  commit(writes: readonly StorageWrite[], context): Promise<Seq>;   // ONE batch -> seq
  mintId<I>(): Promise<I>;                                           // > every id stored, across reopen
  conversation(id, ctx); scanConversations(query, limit, cursor, ctx);
  entry(id, ctx); entry(conversationId, id, ctx); findLatestHeadMarker(conversationId, atOrBefore, ctx);
  scanEntries(query, limit, cursor, ctx); task(id, ctx); scanTasks(...); submission(id, ctx); scanSubmissions(...);
  submissionByRequest(conversationId, requestId, ctx); findDocument(address, at, ctx); document(id, at, ctx);
  scanDocuments(...); close(ctx);
}
StorageWrite = {type:"conversation",value} | {type:"entry",value} | {type:"task",value} | {type:"submission",value}
  | {type:"document.create",record,content:{kind:"base",...}} | {type:"document.copy",record,source}
  | {type:"document.change",id,content} | {type:"document.retire",id}
```

`MemoryStorage` is the in-memory storage exported from the package root. It has a public `prepareCommit` method:

```ts
prepareCommit(writes, seq?) : { seq, writes /*detached, frozen, document.copy resolved*/, apply(): Seq }
```

Detached means copied out of the working memory, so later changes do not affect the copy.

The package also ships a JSONL backend, which keeps its log in a file of JSON lines. It uses `MemoryStorage` as its working set plus an append-only log. It works like this:

- To commit, it calls `prepared = memory.prepareCommit(writes)`, writes the log, then calls `prepared.apply()`.
- To recover, it runs `memory.prepareCommit(writes, marker.seq).apply()` for each stored commit.

The key-value backend in this project copies that pattern exactly. It stores one key-value record per commit, holding `{seq, writes}`. These are the prepared, detached writes, in which every `document.copy` is already resolved into a `document.create`.

### Conformance suite

Import it with `import { registerStorageConformance } from "@earendil-works/pi-durable/testing"` and register it like this:

```ts
registerStorageConformance({ describe, expect, it }, "name", async (use) => { const s = await open(); try { await use(s) } finally { await s.close(ctx) } })
```

Each `use` must get a fresh, empty storage.

## Harness API in version 1.4.0

### Opening and inspecting

- `Harness.open(storage, { models, registry, settings?, env?, onReport?, conversationCreated? }, ctx)` opens the harness.
- `harness.root(ctx, { agent? })` returns the root conversation.
- `harness.conversation(id, ctx)` returns one conversation.
- `harness.inspect(ctx)` returns `{ scheduling, tasks: TaskInspection[], submissions }`. Each `TaskInspection` has a record and a `state.kind` of `running`, `ready`, `waiting`, `sleeping`, `completing`, or `blocked`.
- `harness.resume()` resumes unfinished work.
- `harness.taskGraph(ctx)` returns the Chord state. Its `.value.tasks` is a map of nodes `{id, kind, state, owner, conversationId}`.
- Other methods: `harness.usage(ctx)`, `harness.waitForIdle(ctx)`, `harness.close(ctx)`, `harness.submission(id, ctx)`.

### Conversations

A conversation has these methods: `submit(draft, ctx)`, `reset(handoff, ctx)`, `fork(entryId, { ownership:{kind:"ownerless"} , agent? }, ctx)`, `entries(query, limit, cursor, ctx)`, `commit(tx => ..., ctx)`, `configure(change, ctx)`, `abort(ctx)`, `waitForIdle(ctx)`, and `context(ctx)`, which returns `{ head, entries, messages }`.

- `reset` starts the conversation again with only a handoff note visible. The handoff note is a note the agent writes to itself.
- `fork` starts a new conversation that shares the history of this one up to one entry.

### Submissions

A `SubmissionDraft` takes one of two shapes:

- `{ requestId?, type:"input", content, whenBusy?: "steer"|"followUp"|"reject", entry?: { kind, data } }`. The custom `kind` is shown in the transcript, and the model sees `content` as a user message. The kind must not start with `pi.`.
- `{ type:"write", entry: EntryDraft }`.

`whenBusy` says what happens when the agent is busy. With `"steer"`, the message waits and the model sees it at its next turn.

`submission.wait(ctx)` returns the settled result, `{ status:"done"|"unanswered", ... }`.

### Tools

Define a tool with this shape:

```ts
defineTool({ name, description, parameters: Type.Object(...), replay?: "safe"|"unsafe", execute(args, api, ctx) => { output?: [{type:"text",text}], details?, isError?, control?: {terminate, handoff} } })
```

Inside `execute`, the `api` object offers:

- `api.memo(name, ctx)` and `api.memo(name, candidate, ctx)`, the durable memo
- `api.commit`, `api.details`, `api.output`, `api.snapshot`

### Extensions and hooks

An extension bundles tools, prompt sections, and hooks:

```ts
defineExtension({ name, tools, sections:[section(key, render, {tag})], hooks:[hook(ToolTask, { beforeTool(call, api, ctx) => ({block?} | undefined), afterTool })] })
```

Install it with `createRegistry().install(ext)`. `HookApi` also has `memo(name, ctx)` and `memo(name, candidate, ctx)`.

### Events for the agent web page

`watchEvents(harness, conversationId, ctx)` returns `{ snapshot, start(async (events, ctx) => ...), stop() }`. The `snapshot` is a `SnapshotEvent{entries, run, generation, tools, inbox, agent, usage}`.

The event types are:

- `run_start`, `run_end`, `turn_start`, `turn_end`
- `message_start`, `message_update{changes: text_delta...}`, `message_end{entry}`
- `tool_execution_start{args,toolName,toolCallId}`, `tool_execution_update{output}`, `tool_execution_end{entry}`
- `entry_appended{entry}`, `inbox_update`, `submission`, `usage_changed`, `task_failed`

### Documents

Define a document type with:

```ts
defineDoc<T>({ kind, version:1, scope:"conversation"|"session", history:"latest", fork:"initial"|"current", initial, checkpointWhen })
```

Inside a commit, `tx.doc(token, conversationId)` returns a draft to change. Read the current value with `harness.snapshot(token, conversationId, ctx)`.

### Models

```ts
import { createModels } from "@earendil-works/pi-ai/models"; import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"; models.setProvider(openrouterProvider())
```

The provider reads `OPENROUTER_API_KEY`. OpenRouter is a service that gives access to many language models through one API key. A model reference looks like `{ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" }`.

The catalog, which uses the `anthropic-messages` API, has `anthropic/claude-haiku-4.5`, `claude-haiku-5.5`, `claude-sonnet-4.5`, `claude-opus-4.5` and the models after it up to `claude-opus-5.5`, and `claude-fable-5.1`. The original brief asks for a fast model for narration and a strong model for the fix.

### Replay and settings

- Replay rule: after a crash, `replay:"safe"` tools run again. Other tools get an `interrupted` error result, which goes to the model.
- Settings: `settings: { restartLimit, afterFailedRun: "continue", toolExecution: "sequential", stream: { timeoutMs } }`.

## Apify facts

### Key-value stores

- Keys may use the characters `a-zA-Z0-9!-_.'()`, up to 256 characters.
- Storage is S3 with strong read-after-write consistency. A read right after a write sees the write.
- Each store allows 200 requests per second for get, put, and list.
- `apify-client` calls:
  - `client.keyValueStore(id).listKeys({ prefix, exclusiveStartKey, limit })` returns `{ items:[{key,size}], isTruncated, nextExclusiveStartKey }`.
  - `getRecord(key)` returns `{ key, value, contentType } | undefined`.
  - `setRecord({ key, value, contentType })` writes a record.
  - `client.keyValueStores().getOrCreate(name)` returns `{ id }`.

### Standby Actors

- To enable Standby, set `usesStandbyMode: true` in `actor.json` or `actorStandby` in an Actor update.
- The server listens on `ACTOR_WEB_SERVER_PORT`.
- The platform's readiness probe sends the header `x-apify-container-server-readiness-probe`.
- `APIFY_META_ORIGIN === "STANDBY"` in a Standby run.
- The Standby URL is `https://<USER>--<ACTOR>.apify.actor` or `https://<ACTOR_ID>.apify.actor`. Replace `<USER>` with the username, `<ACTOR>` with the Actor name, and `<ACTOR_ID>` with the Actor id.
- A Standby URL requires an Apify token, sent as `Authorization: Bearer` or `?token=`. The platform strips it. So the scraper and the repair Actor fetch the target site with the token, and people open it with `?token=`.

### Container web server

- A run can serve a web page by listening on `ACTOR_WEB_SERVER_PORT`, which is 4321.
- The public URL is in `ACTOR_WEB_SERVER_URL` and ends in `*.runs.apify.net`. It needs no token.
- The run object also has it as `containerUrl`. The Console shows it as **Live view**.

### Webhooks

A webhook is a platform rule that calls a URL when an event happens. Create one like this:

```ts
client.webhooks().create({ eventTypes:["ACTOR.RUN.FAILED"], condition:{ actorId }, requestUrl: "https://api.apify.com/v2/acts/<repairActorId>/runs", payloadTemplate: '{"actorId": {{eventData.actorId}}, "failedRunId": {{eventData.actorRunId}}}' })
```

The platform adds the token automatically for `api.apify.com` URLs. A webhook may fire more than once, so the code removes duplicates by request id.

### Actor source files, builds, and runs

- Set source files: `client.actor(id).version("0.0").update({ versionNumber:"0.0", sourceType:"SOURCE_FILES", sourceFiles:[{ name, format:"TEXT", content }], buildTag:"latest", envVars? })`.
- Build: `client.actor(id).build("0.0", { tag, waitForFinish })` returns a build `{ id, status, buildNumber }`.
- Point a tag at an existing build: `client.actor(id).update({ taggedBuilds: { prod: { buildId, buildNumber } } })`. The client type allows it. Verify on the platform that it works.
- Start a run: `client.actor(id).start(input, { build:"prod", waitForFinish })`.
- Read a run: `client.run(id).get()`, `.abort()`, `.log().get()`, `.dataset().listItems()`, `.keyValueStore().getRecord(key)`.

### Schedules

```ts
client.schedules().create({ name, cronExpression:"*/2 * * * *", isEnabled, actions:[{ type:"RUN_ACTOR", actorId, runInput:{ body: JSON, contentType:"application/json" }, runOptions:{ build:"prod" } }] })
```

### Account and environment

- Account: user `straightforward_understanding`, id `lBvV6oI0Bs6uXp1Wb`.
- Environment variables `APIFY_TOKEN` and `OPENROUTER_API_KEY` were set on the builder's machine.
- Node 26 runs locally. The Actors use `apify/actor-node:22` images.

## Early architecture decisions

These were written before [DECISIONS.md](DECISIONS.md) existed. That file holds the full list.

- Repository layout:
  - `repair-actor/` is TypeScript, pushed with `apify push`.
  - `actors/target-site`, `actors/scraper`, and `actors/redirector` are single-file JavaScript Actors, deployed as `SOURCE_FILES` through `scripts/deploy.ts`. The scraper later got a second file, `selectors.js`.
  - `config.ts` at the root holds the IDs.
  - `scripts/` run locally with `tsx`.
- Screenshots: no Chromium, because the original brief puts it out of scope. A "screenshot" is a deterministic SVG drawing of the parsed page, before and after, stored in the key-value store as `image/svg+xml`. Deterministic means it comes out the same every time. This is recorded as a simplification.
- Approval: the `promote` tool is `replay:"safe"`. A `beforeTool` hook checks a `demo.approval` document on the conversation, which `POST /approve` sets. The hook waits, checking the document every 2 seconds, until someone approves. The memo survives an abort and a restart, so the agent does not ask again.
