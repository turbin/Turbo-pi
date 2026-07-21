# Task 8: pi Session JSONL Writer — Changes and Decisions

Date: 2026-07-21
Scope: `packages/agent-server/` session recording aligned to pi-native session JSONL (P1.3).
Refs: ` design/2026-07-19-agent-server-p1-spec.md` §6, ` design/2026-07-19-agent-server-p1-plan.md` Task 8.

## Changes

- `src/session-writer.ts`: rewritten. `SessionWriter` now emits pi-native session JSONL:
  - `writeSessionHeader({id, cwd, timestamp?, parentSession?, metadata?})` — first line, `{type:"session", version:3, id, timestamp, cwd, ...}`.
  - `writeMessage(message: Message)` — `{type:"message", id, parentId, timestamp, message}` tree entry; returns the generated entry id.
  - `writeCustomEntry(customType, data?)` — `{type:"custom", id, parentId, timestamp, customType, data?}` tree entry.
  - Entry ids are `randomUUID()`; `parentId` chains to the previously written entry (pi's leaf tracking), so each file replays as one linear branch. Writing entries before the header, or a second header, throws.
- `src/proxy-handler.ts`: migrated to the new API. Per proxied request the session file now records: session header (id = `options.sessionId` or the file basename; metadata = `{model, provider}`), one `message` entry per request context message, an `experience_injection` custom entry with the retrieved experience IDs, then `response_started` / `stream_event` / `response_completed` / `error` / `aborted` custom entries for the stream lifecycle. The old `{type:"request"|"response_started"|"event"|...}` entries are gone.
- `src/offline/etl.ts`: the streamed-reply miner now also reads `{type:"custom", customType:"stream_event"}` entries (the new home of `text_delta`/`thinking_delta`), so ETL keeps mining assistant responses from new files. Legacy `request`/`event` reader branches kept (see decisions).
- `src/mock-benchmark.ts`: `readRetrievedIds` updated to the new format (message entries + `experience_injection` custom entry).
- Tests: `test/session-writer.test.ts` rewritten (8 tests against the real pi format), `test/proxy-handler.test.ts` session assertions migrated, `test/offline/etl.test.ts` gained a stream_event mining test.

## Real pi format vs the plan sketch — real format wins

The Task 8 brief sketch and spec §6 example do not match the format pi actually writes and reads
(`packages/agent/src/harness/session/jsonl-storage.ts`, `packages/agent/src/harness/types.ts`). Where they disagreed,
the real format was followed, because the acceptance criterion (P1.3) is that pi's session-manager can replay the files:

| Aspect | Brief/spec sketch | Real pi format (followed) |
|---|---|---|
| Header version | `version: 1` | `version: 3` — pi's `parseHeaderLine` rejects any other version |
| Header time field | `created_at` | `timestamp` (ISO 8601 string); `cwd` is also required |
| Entry timestamps | `timestamp: <number>` | ISO 8601 **string** — pi's `parseEntryLine` requires a string |
| Message entries | flat `{role, content}` | nested `{type:"message", ..., message: <AgentMessage>}` |
| Custom entries | `{type:"custom", name, data}` | `{type:"custom", customType, data?}` |
| Entry ids | sequential `msg-N` | unique non-empty strings (pi uses uuidv7 tails; `randomUUID()` satisfies the reader) |

What the sketch got right and was kept: a `session` header line, `id`/`parentId` tree structure, and custom entries
for metadata that must not enter model context.

## Decisions

1. **Header is mandatory and singular.** pi's reader rejects files without a valid version-3 header, so `writeSessionHeader` must be called first and exactly once; violations throw. Reason: fail fast instead of silently writing files pi cannot open.
2. **Request context messages become `message` tree entries; proxy metadata becomes `custom` entries.** The conversation is pi-native replayable content; retrieval IDs and stream lifecycle have no pi-native equivalent, so they use pi's `custom` extension mechanism with `customType` discriminators (`experience_injection` per spec §6, plus `response_started`/`stream_event`/`response_completed`/`error`/`aborted`). Reason: matches how pi itself separates context from metadata (`custom` entries are omitted from model context by default).
3. **The gateway reply is recorded as `stream_event` custom entries, not a reconstructed assistant `message` entry.** The `done` event carries only reason+usage, and the brief lists gateway responses under proxy metadata. Reason: parity with prior recording behavior at minimal complexity; ETL was extended to mine these entries so no training signal is lost. Reconstructing a full assistant message entry is a possible follow-up.
4. **Entry ids use `randomUUID()`, not pi's uuidv7-tail scheme.** pi's reader only requires unique non-empty strings, and agent-server deliberately depends only on pi-ai (see toolcall-validator.ts comment). Reason: no new dependency for a cosmetic id format.
5. **Session id = `options.sessionId` ?? file basename.** `ProxyStreamOptions.sessionId` already existed; honoring it lets callers correlate server-side sessions, with a unique fallback. Reason: uses an existing, previously unused field.
6. **Legacy P0 reader branches in `pipeline.ts`/`etl.ts` were kept, not removed.** They are read-side tolerance with existing test coverage (Task 6/7), cost nothing, and old `var/sessions` files may still exist on disk. Removal can happen once old files are gone. Reason: the task forbids breaking the offline pipeline; writer-side old format is fully gone.
7. **`Model<any>` in proxy-handler and `any` in test helpers were left as-is** (pre-existing patterns in this package).

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run` in `packages/agent-server` (arm64 Node v24.15.0, matching the better-sqlite3 native binding): 14 files, 101 tests passed.
- `npm run check` from repo root: clean (biome, pinned deps, ts imports, shrinkwrap, tsgo, browser smoke).
- Not done: live replay of a written file through pi's `JsonlSessionStorage` (would require a pi-agent-core dependency or a manual check); format conformance is asserted structurally in tests against pi's parser rules instead.

## Fix (2026-07-21, review follow-up): assistant reply recorded as pi-native `message` entry

Driver: Task 8 review finding (important) — on pi-side replay (`packages/agent/src/harness/session/session.ts`
`buildSessionContext`) the conversation ended at the last user message; the assistant turn lived only in
`stream_event` custom entries, which are omitted from model context by default. Replayed/forked sessions
silently lost the model's reply. Spec §6's example shows an assistant `message` entry.

Changes:

- `src/session-writer.ts`: new exported `buildAssistantMessage(events, model)` reconstructs a pi-native
  `AssistantMessage` from the accumulated `/api/stream` events — text/thinking/toolCall parts reassembled per
  `contentIndex` in first-seen order, `usage`/`stopReason` from the terminal `done` event, numeric ms
  `timestamp` (matching the pi-ai message shape). Returns null without a `done` event.
- `src/proxy-handler.ts`: the `onEvent` recorder keeps writing every `stream_event` custom and, on `done`,
  additionally writes the reconstructed reply via `writer.writeMessage` (chained `parentId` to the last
  written entry; `response_completed` then chains to the assistant message, so it becomes part of the
  replayed branch). On stream error/abort nothing changes: customs only, no assistant message.
- `src/offline/etl.ts`: dedup — stream parts whose reassembled text is already contained in an assistant
  `message` entry's text are skipped, so the reply is mined exactly once; `stream_event` mining remains for
  sessions lacking the message entry (error/aborted streams, pre-fix files). Thinking deltas never match
  (message text extraction excludes thinking parts) and are still mined from the stream.
- `src/offline/pipeline.ts`: unchanged — `collectTrajectories` never read `stream_event` customs, so the new
  message entry flows in without double counting (regression test added).

Decisions:

1. **Reconstruct on `done`, not at tee close.** The `done` event is the only point carrying final
   `usage`/`stopReason` and guaranteeing a successfully finished stream; the tee close only signals byte
   stream end. Reason: correct metadata and a precise success criterion.
2. **Error/abort keeps customs-only recording.** A partial reply is not a valid assistant turn for replay
   (pi would send it back to the model as if complete); the raw `stream_event` customs still preserve it for
   ETL. Reason: replay correctness beats completeness for failed turns.
3. **ETL dedup by containment against assistant message texts, not by entry position.** Order-independent
   and tolerant of multi-part content (the message entry joins all text parts, so per-contentIndex stream
   parts match by substring). Reason: simple, no new file-format markers.
4. **Thinking parts included in the reconstructed message.** pi-ai `AssistantMessage.content` supports
   `ThinkingContent`, and replay benefits from the full turn. Reason: spec §6 alignment at zero extra cost.
