# Task 5: OpenAI Compatibility Mapping — Changes and Decisions

Date: 2026-07-19
Scope: `packages/agent-server/` only
Refs: `doc/design/2026-07-18-agent-server-experience-replay-spec.md` §4.2/§5.3, `doc/design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 5

## Changes

- Created `packages/agent-server/src/openai-compat.ts`: `toOpenAIRequest(payload, model)` maps an `InjectionPayload` (Task 4) to an OpenAI-compatible chat completion request body for the Python gateway's `/v1/chat/completions`.
- Created `packages/agent-server/test/openai-compat.test.ts`: 5 tests covering the plan's Step 1 scenario plus real pi-ai message shapes.

## Decisions

1. **Handle real pi-ai `Message` shapes, not the plan's naive sample code.**
   The plan's sample implementation reads `msg.content` directly and switches on roles
   `user`/`assistant`/`tool`. Real pi-ai messages differ: user content can be
   `string | (TextContent | ImageContent)[]`, assistant content is a parts array
   (text/thinking/toolCall), and tool results use role `toolResult` (not `tool`).
   Since `buildInjection` passes the original `Context.messages` through, the mapper
   must convert these shapes or it would emit invalid request bodies. The plan's Step 1
   test still passes unchanged.

2. **Self-contained mapper instead of reusing `packages/ai` provider internals.**
   The spec table says "复用 packages/ai", but pi-ai's `convertMessages` (in
   `api/openai-completions.ts`) requires a `Model<"openai-completions">` plus an internal
   `ResolvedOpenAICompletionsCompat` flag set and returns `openai`-package types, none of
   which the agent-server depends on. A small local mapper keeps the package dependency
   surface unchanged; the mapping logic mirrors the provider's essentials.

3. **Typed return value (`OpenAIChatRequest`) instead of `Record<string, unknown>`.**
   Exported interfaces (`OpenAIChatRequest`, `OpenAIRequestMessage`, `OpenAITool`,
   `OpenAIToolCall`, `OpenAIContentPart`) give the gateway client (Task 6) a concrete
   type to consume without adding a dependency on the `openai` npm package.

4. **Assistant mapping: join text parts, drop thinking, emit `tool_calls`.**
   Text parts are concatenated into `content` (`null` when empty and tool calls are
   present, `""` when both are empty); `ToolCall` parts become OpenAI `tool_calls` with
   `arguments` JSON-stringified. Thinking blocks are dropped — the local model server has
   no use for prior thinking context in this P0 scope.

5. **toolResult → `role: "tool"` with `tool_call_id`; images dropped.**
   OpenAI tool messages carry text only, so image parts in tool results are dropped and
   text parts are joined. This is called out in the module docstring.

6. **Omit `tools` key when absent or empty.**
   Sends a cleaner body to the gateway; some local servers reject an empty `tools` array
   differently than a missing key.

## Open questions / notes

- `dormant` experiences are still injected by Task 4 (known open question, unchanged here).
- The session writer (Task 8) still needs the `retrieved` list alongside the payload; this
  task does not change `InjectionPayload`.
- No `temperature`/`max_tokens`/stream options are mapped yet; the plan defers options
  handling to the proxy/gateway-client tasks.
