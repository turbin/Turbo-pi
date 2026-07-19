# Task 9: ToolCall Outbound Validation and SSE Event Transformation — Changes and Decisions

Date: 2026-07-19
Spec: ` design/2026-07-18-agent-server-experience-replay-spec.md` §4.1/§5.1; ` design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 9

## Changes

- `packages/agent-server/src/toolcall-validator.ts` (new): `validateToolCall()` (schema-based argument validation) and `validateToolCallStream()` (raw OpenAI SSE → pi-ai-style `/api/stream` event transformation with outbound toolCall validation).
- `packages/agent-server/src/proxy-handler.ts` (modified): the gateway SSE stream now passes through `validateToolCallStream` before `teeWithSessionClose`; every emitted event is recorded to the session JSONL via the `onEvent` hook (`{type:"event"}` entries). Task 8 TODO hook point removed.
- `packages/agent-server/test/toolcall-validator.test.ts` (new): 13 tests covering `validateToolCall` and `validateToolCallStream`.
- `packages/agent-server/test/proxy-handler.test.ts` (modified): updated for the transformed wire format and per-event session entries; added an end-to-end rejection test (truncated toolCall → `error` event over HTTP).

## Decisions

1. **SSE transformation done in this task, not deferred.** The Task 8 review note flagged that raw OpenAI chunks were passed verbatim while SPEC §4.1 requires pi-ai-style events. `validateToolCallStream` now owns both transformation and validation in one pass, since validation must inspect the fully-assembled toolCalls anyway.
2. **Wire format is `ProxyAssistantMessageEvent` (partial stripped), not full `AssistantMessageEvent`.** SPEC §4.1 says `/api/stream` aligns with `packages/agent/src/proxy.ts`; its `done` carries only `reason + usage` and `error` carries `reason + errorMessage + usage`, matching the spec text exactly. The event type is duplicated locally as `StreamEvent` instead of imported, because agent-server only depends on `@earendil-works/pi-ai` and adding a pi-agent-core dependency for one type was not justified.
3. **Rejected toolCalls terminate the stream with an `error` event.** The plan interface says "rejected toolCalls replaced with error toolResult", but the §4.1 protocol has no toolResult event; the only error channel is the terminal `error` event (`reason:"error"`, `errorMessage` describing the rejection). The client therefore never receives a `done` it would act on with an invalid toolCall.
4. **toolCall deltas are buffered, text/thinking stream live.** Validation needs the complete arguments JSON, and `finish_reason=length` (整批拒绝) is only known at the end, so `toolcall_start/delta/end` are emitted at end-of-stream after validation passes (one `toolcall_delta` carrying the full arguments string). Text and thinking deltas (`reasoning_content`/`reasoning`/`reasoning_text`, same fields as pi-ai) pass through live.
5. **`finish_reason=length` with any toolCall present rejects the whole batch** (SPEC §5.1 step 7 "length 整批拒绝"). `length` with no toolCalls stays a normal `done(reason:"length")` (truncated text is still usable).
6. **Validation scope: minimal, per the plan sketch.** Arguments must parse to a plain object; `required` properties must be present; present properties must match their declared top-level JSON type (`string`/`number`/`integer`/`boolean`/`array`/`object`). Unknown tool names (no schema in `context.tools`) are rejected — the tool list is the outbound contract. Guard hooks from SPEC §5.1 step 7 remain a follow-up (the Guard lives in the injection layer, Task 4, and is not yet wired to the outbound path).
7. **Finish-reason mapping mirrors pi-ai** (`stop`→stop, `length`→length, `tool_calls`/`function_call`→toolUse, anything else → `error` event with `Provider finish_reason: <reason>`), as does the hard error "Stream ended without finish_reason". Malformed `data:` JSON also terminates with an `error` event rather than breaking the HTTP stream.
8. **`data: [DONE]` is consumed, never forwarded.** The proxy client (`streamProxy`) JSON-parses every `data:` line and would throw on `[DONE]`.
9. **Per-event session recording via `onEvent` callback.** proxy-handler passes `writer.write({type:"event", data: event})`, giving the JSONL the full "request + event stream + injection record" (SPEC §5.1 step 8) without re-parsing the transformed bytes. Session entry sequence: `request` → `response_started` → `event`* → `response_completed`|`error`|`aborted`.
10. **`validateToolCallStream` is synchronous** (returns `ReadableStream` directly, deviating from the plan's `async` sketch); no async work happens at construction, and `await` on the result still works. Transformation runs in the stream's `start()` with `cancel()` cancelling the upstream reader.
11. **`InstanceType<typeof TextDecoder>`** used for the decoder parameter type: the package tsconfig has `lib: ["ES2022"]` without DOM, and @types/node exposes global `TextDecoder` as a value only.

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run` (packages/agent-server, Node v24.15.0): 8 files, 48 tests, all pass (13 new validator tests, 4 proxy-handler tests including the new rejection test).
- `npx tsgo --noEmit` (packages/agent-server, Node v24.15.0): clean.
- `npx biome check` on the four touched files: clean after one auto-format pass.

## TODO

- Task 10: mock benchmark runner.
- Wire Guard hooks into the outbound validation path (SPEC §5.1 step 7, third clause).
- E2E verification against the live Python gateway (transformation currently tested against mocked OpenAI SSE only).
