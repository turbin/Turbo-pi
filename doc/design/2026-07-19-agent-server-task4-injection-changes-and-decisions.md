# Agent Server Task 4: Injection Payload Assembly — Changes and Decisions

Date: 2026-07-19
Scope: `packages/agent-server/` only
Brief: `.superpowers/sdd/task-4-brief.md`

## Changes

- Created `packages/agent-server/src/injection.ts`
  - `buildInjection(context, retrieved)`: filters out `status === "removed"` experiences, groups the rest into evidence (`EVIDENCE` → `payload.text`), Method (`ABILITY` + `role === "Method"` → `payload.procedure`), and Guard (`ABILITY` + `role === "Guard"` → `payload.boundary`, prefixed `注意：`) blocks, splices them as one synthetic user message before the last real user message, and returns `{ messages, systemPrompt, tools }` with systemPrompt/tools passed through.
- Created `packages/agent-server/test/injection.test.ts` — 7 tests (evidence insertion position, Method/Guard blocks, removed filtering, malformed/irrelevant payloads ignored, empty retrieval, no-user-message edge, input array not mutated).

## Decisions

1. **Filter `status === "removed"` inside `buildInjection`.**
   Reason: per the Task 3 review note carried into the brief, `ExperienceStore.search` does not filter by status, so removed experiences can reach injection. Dropping them at assembly time is the last choke point before the prompt and keeps retrieval unchanged.

2. **Typed payload guards instead of the brief's `(payload as any)` casts.**
   Reason: repo AGENTS.md forbids `any` unless absolutely necessary; `payload` is `Record<string, unknown>`, so `typeof x === "string"` narrowing is sufficient and also skips malformed entries (e.g. a Method without `procedure`) instead of injecting `undefined` into the prompt.

3. **Test uses fully-typed pi-ai messages (with `timestamp`).**
   Reason: the brief's sketch used bare `{ role, content }` literals, but pi-ai `UserMessage` requires `timestamp`; the adapted test type-checks under `tsgo --noEmit` while keeping the brief's original assertions (injected message is second-to-last, contains the evidence text, last message untouched).

4. **Injected message is a new array slot; input context is not mutated.**
   Reason: `messages` is copied (`[...context.messages]`) before `splice`; callers may reuse the request context (e.g. for session writing), so mutation would be a side effect leak.

5. **No injection when there is no user message or no usable blocks.**
   Reason: per spec §5.1 the block is inserted before the last user message; with no anchor there is no defined position, and appending a bare evidence message would produce an invalid conversation tail.

6. **Skill catalog and SOP schema injection deferred to P1.**
   Reason: brief and spec §5.1 mark `<available_skills>` systemPrompt append and SOP tool flattening as later work; `buildInjection` passes `systemPrompt`/`tools` through unchanged so P1 can extend it in place.

## Verification

All commands run from `packages/agent-server/` with Node 24 arm64 (`~/.nvm/versions/node/v24.15.0/bin/node`; the default PATH node is x64 v20 under Rosetta and cannot load the installed arm64-only rolldown native binding):

- `node ../../node_modules/vitest/dist/cli.js --run test/injection.test.ts` — 7 passed, 0 failed (re-run after biome formatting, still 7/7).
- Full package suite (`vitest run`): 3 files, 17 tests, all passed.
- `tsgo --noEmit` — exit 0.
- `biome check --write src/injection.ts test/injection.test.ts` — fixed formatting in one file, then clean.

## Refer Spec

- `doc/design/2026-07-18-agent-server-experience-replay-spec.md` §5.1
- `doc/design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 4
- `.superpowers/sdd/task-4-brief.md`
