# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository. The full project conventions are in `AGENTS.md` — read it first; this file only adds the design-document reading method and points at the canonical constraint sources.

## Design Documents (` design/`)

All design specs, per-task decision records, live verification reports, phase closeouts, and acceptance reports live in ` design/` — **the directory name starts with a space**. Quote it in shell commands (`ls " design/"`); a bare `design/` path or unquoted glob will miss it or hit a stray wrong directory.

How to read it:

- **Start at ` design/INDEX.md`**: one-line summary of every document (grouped by phase: gateway background → agent-server P0 → P1 → P2 → P3 → A2/B3 → C), a decision-change timeline from P0 onward (【立】created /【改】revised /【废】retired /【留】deferred — each retired decision is traced to the change that replaced it), and a "living decisions" quick-reference table of what is currently in force.
- **Per-phase reading order**: phase spec/plan → per-task `*-changes-and-decisions.md` records → live verification report → closeout / acceptance report.
- **Cross-task constraints** (modifications limited to this repo, omlx config/models untouchable, commit message format `COMPLETED/TODO/Refer Spec` with a conventional prefix, git discipline) have a single canonical home: the "通用约束" section of ` design/2026-07-22-agent-server-p3-candidate-tasks.md`. Change them there, not per document.
- **Maintenance rule**: when adding a new design document, update ` design/INDEX.md` in the same commit.

## Key rules (summary; AGENTS.md is authoritative)

- Commit only files you changed in this session; stage explicit paths; never `git add -A`, `git reset --hard`, `git stash`, or `git commit --no-verify`; never commit unless asked.
- Decision records go to ` design/<date>-<topic>-changes-and-decisions.md`; commit messages use the user's `COMPLETED：/TODO：/Refer Spec：` format with a conventional prefix (e.g. `feat(agent-server): …`).
- Modify nothing outside this repository (user configs, omlx settings/models, system state); when a task needs out-of-repo changes, stop and report to the user.
- After code changes run `npm run check` with full output and fix everything it reports; run package tests per `AGENTS.md` (never the raw full vitest suite).
