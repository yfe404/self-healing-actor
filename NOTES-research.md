# Research notes (written by the builder agent, 2026-10-30, before coding)

These are the facts the code is written against. Pinned versions: `@earendil-works/pi-durable@1.4.0`, `pi-ai@1.4.0`, `chord@1.4.0`, `apify-client@2.25.0`. Installed in `repair-actor/`. Reference copies: `/tmp/pi-durable-probe/package` (npm 1.4.0 dist + README), `/tmp/pi-repo/packages/durable` (git HEAD, NEWER than 1.4.0: its Storage.commit signature differs, do not copy from it blindly).

## Pi Durable 1.4.0 Storage interface (dist/types.d.ts)

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

`MemoryStorage` (package root export) has public `prepareCommit(writes, seq?) : { seq, writes /*detached, frozen, document.copy resolved*/, apply(): Seq }`. The shipped JSONL backend = MemoryStorage as working set + append log; its commit does `prepared = memory.prepareCommit(writes); write log; prepared.apply()`. Its recovery replays `memory.prepareCommit(writes, marker.seq).apply()` per stored commit. KV backend copies that pattern exactly: one KV record per commit holding `{seq, writes}` (the prepared/detached writes, which already have document.copy resolved into document.create).

Conformance suite: `import { registerStorageConformance } from "@earendil-works/pi-durable/testing"`; `registerStorageConformance({ describe, expect, it }, "name", async (use) => { const s = await open(); try { await use(s) } finally { await s.close(ctx) } })`. Each `use` must get a FRESH EMPTY storage.

## Harness API (1.4.0)

- `Harness.open(storage, { models, registry, settings?, env?, onReport?, conversationCreated? }, ctx)`.
- `harness.root(ctx, { agent? })`, `harness.conversation(id, ctx)`, `harness.inspect(ctx)` -> `{ scheduling, tasks: TaskInspection[] (record + state.kind running|ready|waiting|sleeping|completing|blocked), submissions }`, `harness.resume()`, `harness.taskGraph(ctx)` (Chord state, `.value.tasks` map of nodes `{id, kind, state, owner, conversationId}`), `harness.usage(ctx)`, `harness.waitForIdle(ctx)`, `harness.close(ctx)`, `harness.submission(id, ctx)`.
- Conversation: `submit(draft, ctx)`, `reset(handoff, ctx)`, `fork(entryId, { ownership:{kind:"ownerless"} , agent? }, ctx)`, `entries(query, limit, cursor, ctx)`, `commit(tx => ..., ctx)`, `configure(change, ctx)`, `abort(ctx)`, `waitForIdle(ctx)`, `context(ctx)` -> `{ head, entries, messages }`.
- SubmissionDraft: `{ requestId?, type:"input", content, whenBusy?: "steer"|"followUp"|"reject", entry?: { kind, data } }` (custom kind shown in transcript, model sees `content` as user msg; kind must not start with `pi.`) or `{ type:"write", entry: EntryDraft }`.
- `submission.wait(ctx)` -> settled `{ status:"done"|"unanswered", ... }`.
- Tools: `defineTool({ name, description, parameters: Type.Object(...), replay?: "safe"|"unsafe", execute(args, api, ctx) => { output?: [{type:"text",text}], details?, isError?, control?: {terminate, handoff} } })`. `api.memo(name, ctx)` / `api.memo(name, candidate, ctx)` (durable memo), `api.commit`, `api.details`, `api.output`, `api.snapshot`.
- Extensions: `defineExtension({ name, tools, sections:[section(key, render, {tag})], hooks:[hook(ToolTask, { beforeTool(call, api, ctx) => ({block?} | undefined), afterTool })] })`, `createRegistry().install(ext)`. `HookApi` has `memo(name, ctx)` and `memo(name, candidate, ctx)` too.
- Events for UI: `watchEvents(harness, conversationId, ctx)` -> `{ snapshot: SnapshotEvent{entries, run, generation, tools, inbox, agent, usage}, start(async (events, ctx) => ...), stop() }`. Event types: run_start/run_end/turn_start/turn_end/message_start/message_update{changes: text_delta...}/message_end{entry}/tool_execution_start{args,toolName,toolCallId}/tool_execution_update{output}/tool_execution_end{entry}/entry_appended{entry}/inbox_update/submission/usage_changed/task_failed.
- Docs: `defineDoc<T>({ kind, version:1, scope:"conversation"|"session", history:"latest", fork:"initial"|"current", initial, checkpointWhen })`; `tx.doc(token, conversationId)` returns a Draft to mutate; `harness.snapshot(token, conversationId, ctx)`.
- Models: `import { createModels } from "@earendil-works/pi-ai/models"; import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"; models.setProvider(openrouterProvider())` reads `OPENROUTER_API_KEY`. Model ref `{ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" }`. Catalog (anthropic-messages api) has: anthropic/claude-haiku-4.5, claude-haiku-5.5, claude-sonnet-4.5, claude-opus-4.5 ... claude-opus-5.5, claude-fable-5.1. Prompt: fast model for narration, strong for fix.
- Replay rule: after a crash, `replay:"safe"` tools rerun; others get an `interrupted` error result to the model.
- Settings: `settings: { restartLimit, afterFailedRun: "continue", toolExecution: "sequential", stream: { timeoutMs } }`.

## Apify facts

- KV store: keys `a-zA-Z0-9!-_.'()`, max 256 chars; S3 strong read-after-write; 200 req/s per store for get/put/list. `apify-client`: `client.keyValueStore(id).listKeys({ prefix, exclusiveStartKey, limit })` -> `{ items:[{key,size}], isTruncated, nextExclusiveStartKey }`; `getRecord(key)` -> `{ key, value, contentType } | undefined`; `setRecord({ key, value, contentType })`; `client.keyValueStores().getOrCreate(name)` -> `{ id }`.
- Standby Actor: `usesStandbyMode: true` in actor.json or `actorStandby` in actor update; server listens on `ACTOR_WEB_SERVER_PORT`; readiness probe header `x-apify-container-server-readiness-probe`; `APIFY_META_ORIGIN === "STANDBY"`. Standby URL `https://<user>--<actor>.apify.actor` and `https://<actorId>.apify.actor`. REQUIRES an Apify token: `Authorization: Bearer` or `?token=`; the platform strips it. So the target site is fetched with the token by scraper and repair actor; humans open it with `?token=`.
- Container web server: listen on `ACTOR_WEB_SERVER_PORT` (4321); public URL in `ACTOR_WEB_SERVER_URL` (`*.runs.apify.net`), no auth; also `containerUrl` on the run object; Console shows it as "Live view".
- Webhooks: `client.webhooks().create({ eventTypes:["ACTOR.RUN.FAILED"], condition:{ actorId }, requestUrl: "https://api.apify.com/v2/acts/<repairActorId>/runs", payloadTemplate: '{"actorId": {{eventData.actorId}}, "failedRunId": {{eventData.actorRunId}}}' })`. Token auto-added for api.apify.com URLs. May fire more than once -> requestId dedupe.
- Actor source files: `client.actor(id).version("0.0").update({ versionNumber:"0.0", sourceType:"SOURCE_FILES", sourceFiles:[{ name, format:"TEXT", content }], buildTag:"latest", envVars? })`; build: `client.actor(id).build("0.0", { tag, waitForFinish })` -> Build `{ id, status, buildNumber }`; retag existing build: `client.actor(id).update({ taggedBuilds: { prod: { buildId, buildNumber } } })` (client type allows it; verify on platform). Start run: `client.actor(id).start(input, { build:"prod", waitForFinish })`, `client.run(id).get()`, `.abort()`, `.log().get()`, `.dataset().listItems()`, `.keyValueStore().getRecord(key)`.
- Schedules: `client.schedules().create({ name, cronExpression:"*/2 * * * *", isEnabled, actions:[{ type:"RUN_ACTOR", actorId, runInput:{ body: JSON, contentType:"application/json" }, runOptions:{ build:"prod" } }] })`.
- Account: user `straightforward_understanding`, id `lBvV6oI0Bs6uXp1Wb`. Env: `APIFY_TOKEN`, `OPENROUTER_API_KEY` set locally. Node 26 locally; Actors use `apify/actor-node:22` images.

## Architecture decisions (see DECISIONS.md once written)

- Repo: `repair-actor/` (TypeScript, pushed with `apify push`); `actors/target-site`, `actors/scraper`, `actors/redirector` are single-file JS Actors deployed as SOURCE_FILES via `scripts/deploy.ts`; `config.ts` at root holds IDs; `scripts/` run locally with `tsx`.
- Screenshots: no Chromium (out of scope). "Screenshot" = deterministic SVG render of the parsed page (before/after), stored in KV as image/svg+xml. Documented as a cut.
- Approval: promote tool is `replay:"safe"`; a `beforeTool` hook checks a `demo.approval` doc on the conversation (set by POST /approve) and waits (polls the doc every 2 s) until approved; memo survives abort/resume so no re-ask.
