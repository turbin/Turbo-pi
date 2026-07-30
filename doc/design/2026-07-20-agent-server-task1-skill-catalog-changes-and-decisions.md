# Task 1: Skill Catalog Assembly — Changes and Decisions

Date: 2026-07-20
Scope: `packages/agent-server/`
Refs: `doc/design/2026-07-19-agent-server-p1-spec.md` §3.1/§4.1, `doc/design/2026-07-19-agent-server-p1-plan.md` Task 1

## Changes

- Added `packages/agent-server/src/skill-catalog.ts`: `buildSkillCatalog(store, limit)` returns
  `{ catalog, skills }` where `catalog` is an `<available_skills>` XML block of `<skill name="...">description</skill>`
  entries for active SKILL experiences.
- Added `ExperienceStore.listActive(type, limit)` in `packages/agent-server/src/experience-store.ts`:
  direct SQL query filtered by `type` and `status = 'active'`, ordered by `quality DESC, created_at DESC`.
- Added `packages/agent-server/test/skill-catalog.test.ts` with 5 tests (basic catalog, filtering, limit,
  XML escaping, empty catalog).

## Decisions

1. **Fetch skills via new `ExperienceStore.listActive()` instead of `store.search("", limit * 3)`.**
   Reason: the plan's reference implementation passes an empty query to FTS5 `MATCH`, which throws
   `fts5: syntax error near ""` in better-sqlite3 (verified experimentally). Also, a catalog must list
   *all* active skills for progressive disclosure, not an FTS-ranked subset — semantic search is the
   wrong primitive here. A dedicated SQL query is simpler and correct.
2. **Order by `quality DESC, created_at DESC` before applying `limit`.**
   Reason: when the store holds more skills than the catalog limit, the highest-quality skills should
   win the slots; `created_at` tiebreak keeps ordering deterministic.
3. **XML-escape both `name` attribute and description text.**
   Reason: titles/descriptions come from LLM-generated payloads; unescaped `<`, `&`, quotes would
   produce malformed XML in the injected system prompt.
4. **Description read from `payload.description` only (empty string when absent).**
   Reason: matches the plan's reference shape; the seed payload in the plan test uses `sections`,
   which intentionally yields an empty description — catalog entries then carry just the name,
   consistent with progressive disclosure (details are fetched on demand, not inlined).

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run` in `packages/agent-server`: 10 files, 58 tests, all pass.
- `npx biome check` on the three touched files: clean.
- `npx tsgo --noEmit` in `packages/agent-server`: my files are clean; 4 pre-existing errors remain in
  `src/openai-compat.ts` and `src/server.ts` (untouched by this task, present on the branch before this change).
