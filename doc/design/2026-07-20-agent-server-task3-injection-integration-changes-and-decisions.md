# Agent Server Task 3 (P1): Skill/SOP Integration into buildInjection — Changes and Decisions

Date: 2026-07-20
Branch: `feature/agent-gateway-design`
Scope: `packages/agent-server/`

## Changes

- `src/injection.ts` — `buildInjection` is now async with an optional `opts: { store?: ExperienceStore }` third parameter. When a store is provided it injects the SKILL catalog (`<available_skills>`) into `systemPrompt` and merges SOP tool schemas into `tools` (SPEC §4.1). Limits are named constants: `SKILL_CATALOG_LIMIT = 10`, `SOP_SCHEMA_LIMIT = 15`.
- `src/proxy-handler.ts`, `src/server.ts` — call sites updated to `await buildInjection(...)`. No store is passed yet; wiring is the TODO for the next task.
- `test/injection.test.ts` — existing 8 tests converted to async; 4 new tests for skill/SOP injection.

## Decisions

1. **Made `buildInjection` async instead of pre-fetching in callers.**
   Reason: `buildSkillCatalog`/`buildSopSchemas` are async and the brief explicitly recommends making `buildInjection` async as the cleaner approach. The signature change is internal to the package; both call sites (`proxy-handler.ts`, `server.ts`) were updated to `await`.

2. **SOP schemas are converted from `OpenAITool` shape to pi-ai `Tool` shape at merge time.**
   Reason: `InjectionPayload.tools` is `Context["tools"]` (pi-ai `Tool[]` with `{name, description, parameters}`), and `toOpenAIRequest` already maps that shape to the OpenAI wire format. Keeping a single internal tool representation avoids a union type leaking into `openai-compat.ts`.

3. **Dedup by tool name; the client-declared request tool wins on collision.**
   Reason: SOP tools are standalone additions; if a name collides with a tool the caller actually declared, the caller's definition is the one it has handlers for. Per Task 2 review note, dedup happens here at the merge point.

4. **Empty skill catalog is not injected.**
   Reason: `buildSkillCatalog` returns `<available_skills>\n\n</available_skills>` even with zero skills; injecting an empty block adds prompt noise. Injection is skipped when `skills.length === 0`. SOP merge is likewise skipped when no schemas exist, preserving `tools: undefined` pass-through.

5. **The ≤15 SOP cap (and ≤10 skill cap) lives at the injection call site as named constants.**
   Reason: per Task 2 review note, the cap belongs at the call site, not inside `buildSopSchemas`.

## Out of scope (TODO)

- Passing `{ store }` at the call sites (`proxy-handler.ts`, `/v1/chat/completions` in `server.ts`) so injection actually activates — next task.
- `validateToolCallStream` in `proxy-handler.ts` still validates against `body.context.tools` only; once the store is wired it should see the merged tool list.

## Refer Spec

- `doc/design/2026-07-19-agent-server-p1-spec.md` §4.1
- `doc/design/2026-07-19-agent-server-p1-plan.md` Task 3
- `.superpowers/sdd/task-3-brief.md`
