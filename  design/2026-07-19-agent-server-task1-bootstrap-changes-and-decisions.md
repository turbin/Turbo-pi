# Agent Server V1.1 P0 — Task 1: Package Bootstrap — Changes and Decisions

Date: 2026-07-19
Task: Initialize `packages/agent-server` per `.superpowers/sdd/task-1-brief.md`.
Branch: feature/agent-gateway-design

## Changes

- Created `packages/agent-server/` (`@earendil-works/agent-server`, private, v0.1.0):
  - `package.json` — `test` (vitest run) and `check` (tsgo --noEmit) scripts; deps `better-sqlite3`, `fastify`, `zod`, `@earendil-works/pi-ai`; devDeps `@types/better-sqlite3`, `vitest`.
  - `tsconfig.json` — extends root `tsconfig.base.json` (ES2022, Bundler resolution).
  - `vitest.config.ts` — node environment, `test/**/*.test.ts` include.
  - `src/types.ts` — `StreamRequest`, `ProxyStreamOptions`, `Experience`, `RetrievedExperience`, `InjectionPayload`; re-exports `AssistantMessageEvent`.
  - `src/index.ts` — barrel re-exporting `types.ts` and `server.ts`.
  - `src/server.ts` — placeholder module (server implementation lands in a later task).
- Updated root `package-lock.json` for the new workspace.

## Decisions (with reasons)

1. **Pinned exact dependency versions** (`better-sqlite3@11.10.0`, `fastify@5.10.0`, `zod@3.25.76`, `@types/better-sqlite3@7.6.13`) instead of the brief's `^` ranges.
   Reason: repo policy (`scripts/check-pinned-deps.mjs`, enforced by `npm run check`) requires exact versions for direct external deps.
2. **vitest `4.1.9`** instead of the brief's `^3.0.0`.
   Reason: the repo standardized on Vitest 4 (`packages/ai`, `packages/agent`, `packages/coding-agent` all use 4.1.9); a second major version would fork the test toolchain.
3. **Added `@earendil-works/pi-ai: ^0.80.10` as an explicit dependency.**
   Reason: `src/types.ts` imports `Context`, `Model`, `SimpleStreamOptions` from it; undeclared deps rely on hoisting accidents. `pi-`-prefixed workspace deps are exempt from exact pinning per `check-pinned-deps.mjs`, and `^0.80.10` matches how `packages/agent` declares it.
4. **Relative imports use `.ts` extensions** (`./types.ts`, `./server.ts`) instead of the brief's `.js`.
   Reason: `scripts/check-ts-relative-imports.mjs` forbids relative `.js` imports in non-declaration files; the repo emits via `rewriteRelativeImportExtensions`.
5. **Created `src/server.ts` as an empty placeholder module.**
   Reason: the brief's `index.ts` re-exports `./server` but the brief does not create the file; without it `tsgo --noEmit` fails. Server implementation is a later task.
6. **`passWithNoTests: true` in `vitest.config.ts`.**
   Reason: brief expects `npm test` to exit 0 with no tests found; vitest exits 1 by default in that case.
7. **Added pi-ai source alias in `vitest.config.ts`** (mirrors `packages/agent/vitest.config.ts`).
   Reason: tests resolve `@earendil-works/pi-ai` to `src/`, not `dist/`, matching repo convention (root `tsconfig.json` paths do the same for type-checking).
8. **Added `engines: node >=22.19.0`** to `package.json`.
   Reason: matches root `package.json` and all other packages.
9. **Re-exported `AssistantMessageEvent` from `@earendil-works/pi-ai`** instead of redefining it.
   Reason: it already exists in `packages/ai/src/types.ts:464`; the brief's prose lists it among core types but its code block does not define it.
10. **Committed `package-lock.json` with the change.**
    Reason: a new workspace without a lockfile entry breaks CI `npm ci`. The lockfile diff also hoists vitest 4.1.9 to the root (three workspaces now share it), which is npm's normal dedupe behavior.
11. **Version `0.1.0`, `private: true`** kept per brief.
    Reason: package is internal for now; lockstep release versioning can adopt it later if it becomes publishable.

## Verification

- `npm test` in `packages/agent-server` (Node v24.15.0): "No test files found, exiting with code 0", exit 0.
- `npm run check` in `packages/agent-server` (`tsgo --noEmit`): exit 0.
- Root `npm run check` (biome, pinned-deps, ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser smoke): exit 0.
- Note: default shell node is v20.19.5, below the repo's `>=22.19.0` engine requirement; all commands were run with Node v24.15.0 (nvm).

## Refer Spec

- ` design/2026-07-18-agent-server-experience-replay-spec.md`
- ` design/2026-07-18-agent-server-v1.1-p0-plan.md`
