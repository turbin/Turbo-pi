# Task 10: Mock Benchmark Runner — Changes and Decisions

Date: 2026-07-19. Scope: `packages/agent-server/` only. Implements `design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 10, per `design/2026-07-18-agent-server-experience-replay-spec.md` §7 (mock benchmark 验证).

## What changed

- `packages/agent-server/src/mock-benchmark.ts` (new) — `runMockBenchmark()` and `renderReport()`; direct execution (`tsx src/mock-benchmark.ts`) regenerates `benchmark/results/report.md`.
- `packages/agent-server/test/mock-benchmark.test.ts` (new) — 4 tests, sharing one benchmark run via `beforeAll`.
- `packages/agent-server/benchmark/results/report.md` (new, generated artifact).

## Decisions

1. **End-to-end through the real pipeline, not a stub.** The plan sketch returned hardcoded metrics; instead the benchmark seeds an in-memory `ExperienceStore` (12 EVIDENCE + 3 noise entries), spins up a real `node:http` mock gateway on an ephemeral port, and drives `POST /api/stream` via fastify `inject`. Reason: Task 10 exists to verify the P0 pipeline (streamFn proxy, evidence replay, session JSONL, toolCall validation) end-to-end — hardcoded numbers would verify nothing.

2. **Metrics are computed from recorded artifacts.** `evidence_recall_at_12` and `pool_size` come from the session JSONL `retrieved` ID lists (verifying session recording at the same time); `replay_token_overhead` comes from the `done` event usage of a seeded run minus a baseline run (empty store). Reason: metrics should fail if any pipeline stage breaks, not just measure retrieval in isolation.

3. **Metric definitions** (documented in code and the report):
   - `evidence_recall_at_12`: fraction of the 12 seeded EVIDENCE entries whose ID appears in the injection pool for their target query. The "@12" is the seeded pool size.
   - `replay_token_overhead`: mean extra prompt tokens per query (seeded − baseline), using the mock gateway's deterministic chars/4 estimate.
   - `pool_size`: mean retrieved experiences per evidence query.
   - `toolcall_pass_rate` (added beyond the plan's three keys): fraction of the two toolCall scenarios (valid → `done(toolUse)`, truncated `finish_reason=length` → terminal `error`, per Task 9's 整批拒绝) with the expected terminal event. Reason: toolCall outbound validation is part of P0 and the benchmark brief says the runner verifies the whole P0 pipeline.

4. **Deterministic mock gateway.** Prompt tokens = ceil(total message chars / 4) + 4 per message; every stream emits a `finish_reason` (Task 9 review note: missing finish_reason ends in an `error` event). Scenario selection by marker prefix in the last user message: `[toolcall]` → valid `read` toolCall with `finish_reason=tool_calls`; `[truncated]` → partial arguments with `finish_reason=length`; otherwise short text reply with `stop`. Reason: reproducible metrics in CI with no model dependency.

5. **Retrieval-targeting strategy.** Each seeded entry carries one unique keyword; English queries include the keyword, CJK queries are prefixes of the entry's leading CJK run (unicode61 stores a CJK run as one FTS token, so only prefix queries match — see `retrieval.ts`). Reason: guarantees recall = 1 deterministically while still exercising FTS bm25 + cosine re-rank + injection, including the CJK path.

6. **Import specifiers kept as `.js`** to match every other file in the package. `scripts/check-ts-relative-imports.mjs` flags the entire `agent-server` package (pre-existing since Task 1, including committed files); fixing only the new files would split the package's convention. Logged as a pre-existing concern in the task report, not fixed here (out of scope).

7. **Cancel-path unhandled rejection (Task 9 known issue) not touched.** fastify `inject` fully consumes the response body, so the benchmark never hits the cancel path. No fix needed for the benchmark; the issue remains open.

8. **Report artifact committed.** The plan references `benchmark/results/report.md` as the metrics format; since it did not exist, `renderReport()` defines it (markdown table) and the generated file is committed as the reference artifact.
