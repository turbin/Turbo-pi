# Task 2: SOP Schema Assembly — Changes and Decisions

Date: 2026-07-20
Scope: `packages/agent-server/`
Refs: ` design/2026-07-19-agent-server-p1-spec.md` §3.1/§4.1, ` design/2026-07-19-agent-server-p1-plan.md` Task 2,
` design/2026-07-20-agent-server-task1-skill-catalog-changes-and-decisions.md`

## Changes

- Added `packages/agent-server/src/sop-schema.ts`: `buildSopSchemas(store, limit)` returns `OpenAITool[]`
  (from `openai-compat.ts`) — one `type: "function"` tool per active SOP experience, with
  `function.name`/`description`/`parameters` taken from `payload.schema`.
- Added `packages/agent-server/test/sop-schema.test.ts` with 5 tests (schema mapping, type/status filtering,
  limit ordering, missing-field defaults, empty store).

## Decisions

1. **Fetch SOPs via `ExperienceStore.listActive("SOP", limit)` instead of the plan's `store.search("", limit * 3)`.**
   Reason: same deviation Task 1 made and verified — an empty FTS5 `MATCH` query throws
   `fts5: syntax error near ""` in better-sqlite3, and a tool list must cover all active SOPs, not an
   FTS-ranked subset. `listActive` also enforces the spec's "硬上限 ≤15，按成功率降序" directly via
   `ORDER BY quality DESC, created_at DESC LIMIT ?`, so the `limit * 3` over-fetch plus in-memory
   filter/slice from the plan snippet becomes unnecessary.
2. **`function.name` falls back to the experience `title` when `payload.schema.name` is absent.**
   Reason: SOP titles are the tool identifier in the seed data (see the plan test, where title equals
   schema name); a missing schema name should still produce a usable tool rather than the string
   `"undefined"`. `description` defaults to `""` and `parameters` to `{}` per the plan's reference shape.
3. **SOP schemas are returned as a flat `OpenAITool[]`, not merged with the request's own tools.**
   Reason: spec §4.1 says "SOP schema → tools 数组平铺"; merging/dedup against request tools belongs to
   the injection/proxy integration step (next task), keeping this module a pure assembly function
   symmetric to `buildSkillCatalog`.

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run` in `packages/agent-server` (Node v24.15.0):
  11 files, 63 tests, all pass (5 new).
- `npx biome check` on the two new files: clean.
- `tsgo --noEmit` in `packages/agent-server`: clean (exit 0; the pre-existing errors noted in Task 1
  were fixed by commit 9c793e3c).
