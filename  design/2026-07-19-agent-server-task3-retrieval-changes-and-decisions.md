# Agent Server Task 3: Retrieval with FTS + Cosine Re-ranking — Changes and Decisions

Date: 2026-07-19
Scope: `packages/agent-server/` only
Brief: `.superpowers/sdd/task-3-brief.md`

## Changes

- Created `packages/agent-server/src/retrieval.ts`
  - `retrieve(store, query, limit)`: FTS bm25 fetches up to `min(limit * 3, 24)` candidates via `ExperienceStore.search`, then cosine re-ranks and returns the top `limit` as `RetrievedExperience[]`.
  - `buildFtsQuery`: converts free-text queries into a safe FTS5 MATCH expression.
  - `cosineScore` / `tokenize`: bag-of-tokens cosine over CJK single chars + bigrams and lowercase alphanumeric words.
- Created `packages/agent-server/test/retrieval.test.ts` — 7 tests (CJK re-rank ordering, CJK prefix match inside a longer run, English re-rank, no-match, no-token query, FTS5 special characters, limit).

## Decisions

1. **Build the FTS MATCH expression in retrieval instead of passing the raw query through.**
   Reason: raw user text can contain FTS5 syntax characters (`"`, `:`, `OR`, parens) that throw SQLite errors; also unicode61 stores a contiguous CJK run as a single token, so a bare CJK query only matches identical runs. `buildFtsQuery` quotes every extracted token (doubling embedded quotes) and ORs them, making injection-safe queries.

2. **CJK runs use FTS5 prefix queries (`"量子计算"*`).**
   Reason: because unicode61 does not segment CJK, a stored run like `量子计算入门指南` is one token; only a prefix query lets the shorter query run `量子计算` match inside it. This is the retrieval-side answer to the Task 2 review note about CJK tokenization.

3. **Cosine over token sets: `intersection / sqrt(|q| * |t|)`.**
   Reason: the brief's sketch (`intersection / sqrt(union)`) is neither cosine nor Jaccard and left an unused variable; set-based cosine is the standard form and rewards short, fully-overlapping texts, which matches the re-rank intent. Tokenizer keeps the brief's CJK single-char + bigram scheme; English words are lowercased so case does not split tokens.

4. **Candidate pool capped at `min(limit * 3, 24)`.**
   Reason: straight from the brief and spec §5.1 (bm25 top-24 → re-rank top-8 for the default limit).

5. **No `status` filtering added.**
   Reason: `ExperienceStore.search` (Task 2) has no status filter; the brief for Task 3 does not add one either. Filtering `removed` experiences is deferred to the injection task (Task 4), same as Task 2's report noted.

## Verification

All commands run from `packages/agent-server/` with Node 24 (`~/.nvm/versions/node/v24.15.0/bin/node`; the default PATH node is v20 and cannot load the rolldown native binding):

- `node ../../node_modules/vitest/dist/cli.js --run test/retrieval.test.ts` — 7 passed, 0 failed.
- Verified failing-first per TDD: with `src/retrieval.ts` moved aside, the test file fails to load.
- Full package suite (`vitest run`): 2 files, 10 tests, all passed.
- `tsgo --noEmit` — exit 0.
- `biome check src/retrieval.ts test/retrieval.test.ts` (arm64 CLI binary directly) — clean, no fixes.

## Refer Spec

- ` design/2026-07-18-agent-server-experience-replay-spec.md` §3.3, §5.1
- ` design/2026-07-18-agent-server-v1.1-p0-plan.md` Task 3
- `.superpowers/sdd/task-3-brief.md`
