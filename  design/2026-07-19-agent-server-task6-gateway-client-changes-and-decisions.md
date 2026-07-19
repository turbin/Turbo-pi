# Task 6: Gateway Client — Changes and Decisions

Date: 2026-07-19
Scope: `packages/agent-server/` only
Refs: ` design/2026-07-18-agent-server-experience-replay-spec.md` §4.2, ` design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 6

## Changes

- Created `packages/agent-server/src/gateway-client.ts`: `GatewayClient` posts to the
  Python agent-gateway's `/v1/chat/completions` (SPEC §4.2). `chat(body)` returns the
  parsed JSON completion; `stream(body)` forces `stream: true` and returns the raw SSE
  `ReadableStream<Uint8Array>`.
- Created `packages/agent-server/test/gateway-client.test.ts`: 8 tests covering the plan's
  Step 1 scenario plus URL construction, auth key resolution, error paths, and streaming.

## Decisions

1. **Typed body (`GatewayChatRequest extends OpenAIChatRequest`) instead of
   `Record<string, unknown>`.**
   The plan's sample code takes `Record<string, unknown>`, but Task 5 already exports a
   typed `OpenAIChatRequest`. `GatewayChatRequest` extends it with the optional
   `stream`/`temperature`/`max_tokens` fields the `/api/stream` options (SPEC §4.1) map
   to, so the Task 8 proxy handler gets type-checked pass-through of sampling options.

2. **No parameter properties; explicit fields with constructor assignment.**
   The plan's sample uses `constructor(private baseUrl: string)`, which is not erasable
   TypeScript and is rejected by `erasableSyntaxOnly` in `tsconfig.base.json`. Fields are
   declared explicitly and assigned in the constructor.

3. **API key resolution: explicit arg > `AGENT_GATEWAY_KEY` env > `lobster-local-key`.**
   Keeps the plan's default local-channel key while letting tests and deployments override
   it without touching process env. The key is captured at construction time, so tests can
   mutate `process.env` freely after building the client.

4. **Trailing slashes stripped from `baseUrl`.**
   Prevents `//v1/chat/completions` when the configured gateway URL ends with `/`; keeps
   the URL joining in one place (the constructor).

5. **Shared `post()` helper for both call shapes; errors include status and statusText.**
   `chat` and `stream` differ only in the `stream` flag and the return value, so the
   fetch + non-ok check lives in one private method. Non-ok responses throw
   `gateway error: <status> <statusText>`; `stream` additionally throws when the response
   has no body (a 2xx without a body would otherwise fail later, harder to diagnose).

6. **Minimal response typing (`OpenAIChatCompletion`) instead of `any`.**
   The non-stream response is typed as `{ id: string; choices: unknown[] }` with an index
   signature — enough for the P0 proxy to forward/log without inventing a full OpenAI
   response schema that the gateway does not guarantee.

7. **Tests stub `fetch` via `vi.stubGlobal`, restored in `afterEach`.**
   Matches vitest idioms and avoids leaking the stub (and `AGENT_GATEWAY_KEY`) across
   tests in the same worker.

## Open questions / notes

- The default key `lobster-local-key` must match a channel key in the Python
  agent-gateway config (see `packages/agent-gateway/config.example.toml`); the gateway
  returns 401 `invalid_api_key` otherwise.
- SSE parsing/validation of the stream is deliberately out of scope here; the Task 8
  proxy handler consumes the raw stream and maps events back to the client protocol.
- `chat()` sends the body as given; only `stream()` forces `stream: true`. If a caller
  passes `stream: true` to `chat()`, `resp.json()` will fail on the SSE payload — callers
  are expected to pick the method that matches their intent.
