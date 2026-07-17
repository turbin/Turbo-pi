# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read this file fully before making changes.

## Project Overview

This is the **Pi agent harness** monorepo (`pi-monorepo`), home of Pi, a self-extensible terminal coding agent. npm workspaces under `packages/*`, published under the `@earendil-works` npm scope. Lockstep versioning: all TypeScript packages share one version and are released together.

Packages:

| Package | Path | Description |
|---|---|---|
| `@earendil-works/pi-ai` | `packages/ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, and many more). One file per provider in `src/providers/<name>.ts` plus a generated `<name>.models.ts`; `src/models.generated.ts` is generated. |
| `@earendil-works/pi-agent-core` | `packages/agent` | Agent runtime: agent loop, tool calling, transport abstraction, state management. `src/harness/` holds the coding-agent harness pieces (compaction, session, skills, system prompt). |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | The `pi` CLI. `src/core/` (agent session, tools in `core/tools/`, extensions, sessions, settings), `src/modes/` (interactive TUI, print mode, RPC), `src/cli/` (startup). |
| `@earendil-works/pi-tui` | `packages/tui` | Terminal UI library with differential rendering, editor component, keybindings. |
| `@earendil-works/pi-orchestrator` | `packages/orchestrator` | Experimental. Supervises multiple pi instances over an IPC socket and exposes an RPC/CLI interface. Unstable, may change or be removed. |
| `agent-gateway` | `packages/agent-gateway` | Independent **Python** package (not an npm workspace). FastAPI server exposing an OpenAI-compatible API that routes to a local model server with quality-gated cloud escalation. Python 3.12, deps via `uv`. See its own `README.md`. |

Other notable entries:

- `.pi/` — this repo's own pi configuration (extensions, prompt templates, skills) used when running pi here.
- ` design/` — design documents (note: the directory name contains a leading space).
- `scripts/` — repo tooling (release, shrinkwrap generation, checks, stats).
- `packages/coding-agent/docs/` — user documentation; `packages/coding-agent/examples/` — extension examples (some are their own workspaces).

## Technology Stack

- TypeScript (ES2022, ESM, Node16/NodeNext resolution), Node `>=22.19.0`.
- Type checking/build via `tsgo` (`@typescript/native-preview`); run-from-source via `tsx`.
- Lint/format via Biome 2.3.5 (`biome.json`): tabs (width 3), line width 120.
- Tests via Vitest 4 (`packages/ai`, `packages/agent`, `packages/coding-agent`); `packages/tui` uses `node --test`.
- TypeScript source uses **erasable syntax only** (Node strip-only mode), enforced by `erasableSyntaxOnly` in `tsconfig.base.json`.
- Root `tsconfig.json` maps `@earendil-works/*` imports directly to `src/`, so tests and `tsx` run against sources, not `dist/`.

## Build and Test Commands

```bash
npm install --ignore-scripts   # hydrate deps (never run lifecycle scripts unless asked)
npm run build                  # build all TS packages (tui -> ai -> agent -> coding-agent -> orchestrator)
npm run check                  # biome check --write + pinned-deps + ts-imports + shrinkwrap checks + tsgo --noEmit + browser smoke
./test.sh                      # run non-e2e tests with API keys and auth stripped
./pi-test.sh                   # run the pi CLI from sources (tsx); --no-env strips API keys
```

- After code changes (not docs): run `npm run check` with full output (no tail). Fix all errors, warnings, and infos before committing. `npm run check` does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. To run a specific test, run from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate until it passes.
- Python package: `cd packages/agent-gateway && uv sync && uv run pytest` (run with `uv run python -m agent_gateway`).

## Code Style Guidelines

### Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!").
- Technical prose only, be direct.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

### Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Testing Instructions

- `./test.sh` moves `~/.pi/agent/auth.json` aside, unsets all provider API keys, sets `PI_NO_LOCAL_LLM=1`, then runs `npm test` across workspaces. Tests that need real providers skip themselves without keys.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider (`registerFauxProvider` from `@earendil-works/pi-ai/compat`). No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- `packages/tui` tests run with `node --test test/*.test.ts` (not vitest).
- `packages/agent` also has a harness suite: `npm run test:harness` (vitest.harness.config.ts).
- CI (`.github/workflows/ci.yml`) runs on Ubuntu: `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `npm test`.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

### Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- `.npmrc` sets `save-exact=true` and `min-release-age=2`.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit (husky, `.husky/pre-commit`) blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` and runs `npm run check`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Commit Format and Decision Records (user convention, long-term)

This overrides the `{feat,fix,docs}[...]` message format above for work done in this repo per user instruction (2026-07-17).

After completing any change task:

1. Summarize every design decision made during the work, with the reason for each, and save it as a Markdown file under ` design/` (note: the directory name contains a leading space), named `<date>-<topic>-changes-and-decisions.md`.
2. Commit the change points with a message in exactly this format:

   ```text
   COMPLETED：<描述完成的任务>
   TODO：<描述待完成的任务>
   Refer Spec：<本次修改引用的 spec>；<本次所有决策引用的 spec 与决策记录文档>
   ```

   - `COMPLETED`: what was finished.
   - `TODO`: what remains unfinished or blocked.
   - `Refer Spec`: the spec(s) this change implements, plus the decision-record document and any spec cited by the decisions.

All other Git rules above still apply (stage explicit paths only, commit only your own session's files, never commit unless asked).

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Security Considerations

- Pi has no built-in permission system; it runs with the launching user's full permissions. Treat the local user account as the trust boundary (see `SECURITY.md`). Containerization patterns are documented in `packages/coding-agent/docs/containerization.md`.
- Files like `AGENTS.md`, skills, and extensions are prompt-injection vectors by design; only work in trusted repositories with trusted extensions.
- Never read, copy, or transmit credential files (`~/.pi/agent/auth.json`, `.env`, API keys). `test.sh` deliberately strips auth and keys — keep tests key-free.
- Report vulnerabilities privately per `SECURITY.md` (`security@earendil.com` or GitHub Security Advisories); never open public issues for security reports.

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
