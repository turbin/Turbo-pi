# Task 8: Proxy Handler and /api/stream Endpoint — Changes and Decisions

Date: 2026-07-19
Spec: ` design/2026-07-18-agent-server-experience-replay-spec.md` §4.1/§5.1; ` design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 8

## Changes

- `packages/agent-server/src/proxy-handler.ts` (new): `handleStream(body, opts)` implementing the online replay pipeline (SPEC §5.1 steps 2–6, 8): last user message → query, `retrieve` top-8, `buildInjection`, `toOpenAIRequest`, `GatewayClient.stream`, session JSONL recording.
- `packages/agent-server/src/server.ts` (replaced placeholder): `createServer(opts?)` returning a Fastify instance with `POST /api/stream`, plus `startServer(port)`.
- `packages/agent-server/test/proxy-handler.test.ts` (new): 3 tests via `server.inject` with a stubbed global `fetch`.

## Decisions

1. **Writer lifecycle via stream wrap (`teeWithSessionClose`)**. The plan sketch only closed the `SessionWriter` on the pre-stream error path, which would lose tail entries on success. The handler wraps the gateway SSE stream in a pull-based `ReadableStream` that closes the writer exactly once with a terminal entry (`response_completed` / `error` / `aborted`) on completion, mid-stream error, or client cancel. Reason: integration note "session writer must be closed with `await writer.close()` to avoid losing tail entries".
2. **`mkdirSync(dirname(sessionPath), { recursive: true })` inside `handleStream`** before constructing the writer. Reason: integration note; keeps the guarantee next to the writer construction instead of relying on callers.
3. **Retrieved experience IDs recorded in the `request` entry** (`data.retrieved: string[]`). Reason: integration note "session writer should record which experiences were injected"; SPEC §5.1 step 8 （注入记录）.
4. **`createServer` accepts optional dependency overrides** (`store`, `gatewayUrl`, `sessionDir`) instead of the plan's zero-arg signature, defaulting to env vars (`EXPERIENCE_STORE_PATH`, `GATEWAY_URL`, `AGENT_SERVER_SESSION_DIR`). Reason: `server.inject` tests need a temp-dir store and session dir; env-only config would write `./var/*` into the repo during tests.
5. **Default store gets `void store.initSchema()`** in `createServer`. better-sqlite3 is synchronous internally, so the schema exists before any request is served despite the async signature. Reason: without it, a fresh default DB would throw on the first FTS query.
6. **Gateway errors map to HTTP 502** with a JSON `{ error: { message } }` body. Reason: the failure is upstream; the plan did not specify a status.
7. **`options.temperature` / `options.maxTokens` are forwarded** to the gateway request as `temperature` / `max_tokens` (SPEC §4.1 `options`). Other options (sessionId, authToken) are session/auth concerns, not gateway request fields.
8. **Web `ReadableStream` is converted with `Readable.fromWeb`** before `reply.send`. Reason: Fastify sends Node streams; the gateway client returns a web stream.
9. **Session file naming `${Date.now()}-${randomUUID()}.jsonl`** instead of the sketch's bare `Date.now()`. Reason: avoids collisions between concurrent requests in the same millisecond.
10. **Test fixture CJK text must contain the query contiguously** ("用户说你好时…"). unicode61 stores a CJK run as one FTS token, so retrieval only matches via prefix query (documented in `retrieval.ts`). The first fixture ("用户偏好简洁的中文回复") contained no "你好" run and correctly retrieved nothing.

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run` (packages/agent-server, Node v24.15.0): 7 files, 34 tests, all pass.
- `npx tsgo --noEmit` (packages/agent-server): clean.
- `npx biome check --write` on the three touched files: formatted, no remaining issues.

## TODO

- Task 9: toolCall outbound validation on the SSE stream (hook point marked in `proxy-handler.ts`).
