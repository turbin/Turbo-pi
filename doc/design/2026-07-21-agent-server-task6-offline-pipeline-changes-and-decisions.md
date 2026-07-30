# Agent Server Task 6 (P1): Offline Pipeline Subprocess Caller — Changes and Decisions

Date: 2026-07-21
Branch: `feature/agent-gateway-design`
Scope: `packages/agent-server/`

## Changes

- `src/offline/pipeline.ts` — `runOfflinePipeline(inputDir, outputDir, options?)` collects session trajectories, writes them to a temp dir, spawns the three vendored Python handoff packages (`skill_evolution.pipeline`, `sop_lifecycle`, `verification_selection.pipeline`) as `python3 -m` subprocesses with `--input`/`--output` JSON handoff, then stages the resulting `skills.json` / `sops.json` / `cards.json` arrays into `outputDir` and returns `{ skills, sops, cards }` counts. `collectTrajectories` is exported and parses both pi-native session JSONL (`{type:"message", message:{role, content}}`, `toolCall` parts paired to `toolResult` via `toolCallId`) and the custom proxy-handler `{type:"request"}` format.
- `test/offline/pipeline.test.ts` — 7 tests: 3 for `collectTrajectories`, 3 for `runOfflinePipeline` with an injected fake spawn, 1 real end-to-end test against the vendored Python packages (MockLLM fallback, no network).
- `python/` — vendored handoff packages (`skill_evolution`, `sop_lifecycle`, `verification_selection`) with thin CLI entry points matching the SPEC commands. `__pycache__/` junk removed; `python/.gitignore` added (`__pycache__/`, `*.pyc`). Verified no credentials: LLM access is env-var driven (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `TEACHER_MODEL`) with deterministic MockLLM fallback.
- `.gitignore` (package-level, new) — ignores `var/` (runtime data: experience.db, sessions) so it is never committed. Follows the existing per-package `.gitignore` convention (`agent-gateway`, `coding-agent`).

## Decisions

1. **Subprocess orchestration is tested via an injectable `spawnFn` option, not module mocking.**
   Reason: the pipeline's only external effect is spawning Python and reading the `--output` JSON files. `OfflinePipelineOptions.spawnFn` (default `node:child_process` spawn) lets the test supply an EventEmitter-based fake that writes canned JSON arrays to the `--output` path and emits `close` — no `vi.mock` of `node:child_process`, no interception of ESM builtins, and the failure path (non-zero exit with stderr tail) is exercised the same way. This also makes `pythonBin` / `pythonDir` / `timeoutMs` overridable for production flexibility (env vars `AGENT_SERVER_PYTHON` / `AGENT_SERVER_PYTHON_DIR`).

2. **One real end-to-end test runs the actual vendored Python, gated on `python3` availability.**
   Reason: a fake spawn cannot catch CLI-contract drift (arg names, output shape, import errors in the vendored code). The e2e test checks `spawnSync("python3", ["-c", "import sys"])` and uses `describe.runIf` to skip when python3 is missing. `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`/`TEACHER_MODEL` are deleted from `process.env` for the duration (restored in `afterEach`) to force the deterministic MockLLM fallback — no network, runs in ~0.5 s, 120 s timeout guard.

3. **Trajectory collection is format-tolerant and failure-tolerant.**
   Reason: session files on disk may be pi-native (Task 8 target) or the current custom proxy-handler format; both are reduced to one `SessionTrajectory` per file (first user text = `task`, concatenated assistant/toolResult text = `text`, paired `toolCalls`). Malformed JSONL lines are skipped individually so one bad line never aborts a file, and files with no extractable content are dropped from the batch.

4. **Intermediate JSON is staged to `outputDir`; verification/canonicalize and ExperienceStore promotion are deliberately left to Task 7.**
   Reason: per the P1 plan split, this task only runs extraction. Staging the three arrays in `outputDir` gives Task 7 a stable input contract without coupling this stage to the store schema.

5. **Runtime data (`var/`) and Python bytecode are gitignored at package level.**
   Reason: `packages/agent-server/var/` holds local runtime state (experience.db, session captures) that must never be committed; a package-level `.gitignore` matches the repo's existing per-package convention and keeps the rule next to the data. `python/.gitignore` keeps regenerated `__pycache__/` out after local runs (the e2e test regenerates it).

6. **Tests and `npm run check` were run with an arm64 Node (nvm v24.15.0) instead of the default x64-under-Rosetta Node.**
   Reason: the shell's default node (nvm v20.19.5) is an x86_64 binary running under Rosetta, but `node_modules` only contains darwin-arm64 native bindings (`@rolldown/binding-darwin-arm64`, `@biomejs/cli-darwin-arm64`), so vitest and biome fail to start under it. v24.15.0 also satisfies the repo's `node >=22.19.0` requirement (v20 does not). No dependencies were installed or changed.

## Out of scope (TODO)

- Verifier + canonicalize step and promotion of extracted skills/SOPs/cards into the ExperienceStore (Task 7), consuming the staged `skills.json` / `sops.json` / `cards.json`.
- Wiring a real benchmark JSON (`--benchmark`) so the skill-evolution stage produces non-empty output (currently outputs `[]` without one).
- `npm run check` biome autofix also reformatted `packages/agent-server/src/server.ts` (pre-existing formatting drift, not part of this task); left uncommitted for the owning session.

## Refer Spec

- `doc/design/2026-07-19-agent-server-p1-spec.md` §4.2
- `doc/design/2026-07-19-agent-server-p1-plan.md` Task 6
- `.superpowers/sdd/task-6-brief.md`
