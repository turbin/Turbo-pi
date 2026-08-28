# M2-T6b-3 Resolved Manifest Persistence Changes and Decisions

## Task
Persist the resolved manifest in `AgentSession._recordResolvedManifest()` instead of only logging it, with fail-closed validation and graceful degradation during `reload()`.

## Decisions

### 1. Flatten the persisted payload to the canonical resolved-manifest fields
- **Reason**: The downstream T6a runtime resolver consumes a record with `task_id`, `slot`, `resolved_at`, `artifact_id`, `actual_provider_model`, and `env_snapshot`. Keeping the persisted shape identical to that contract avoids a translation layer and makes cross-system reconciliation mechanical.
- Mapping:
  - `task_id` ← `sessionId`
  - `slot` ← `"gen0"` (the only slot in Phase 0a)
  - `resolved_at` ← `Date.now()`
  - `artifact_id` ← `versionContract.artifactId`
  - `actual_provider_model` ← `${model.provider}/${model.id}` when a model is selected
  - `env_snapshot` ← `{ cwd: this._cwd }`

### 2. Validate every required field before writing and throw on any violation
- **Reason**: The architecture requires fail-closed behavior for resolved records. Silent nulls would corrupt downstream reconciliation, so missing or invalid fields must abort the write and surface an error.
- Validations:
  - `task_id`, `slot`, `actual_provider_model`: non-empty strings
  - `resolved_at`: finite number
  - `artifact_id`: 64-character lowercase hex, or the explicit gen0 placeholder `"pending_0b"`
  - `env_snapshot`: object containing a non-empty `cwd` string
  - session directory: must be configured (non-empty string)

### 3. Accept `DEFAULT_VERSION_CONTRACT` (`"pending_0b"`) as a valid `artifact_id`
- **Reason**: In local/dev sessions the version contract legitimately falls back to the default placeholder. Rejecting it would break normal operation, so the validator explicitly allows `"pending_0b"` while still rejecting any other non-hex value.

### 4. Catch and log failures in `reload()` so session shutdown/reload continues
- **Reason**: The requirement is "注入失败会话照常、记录缺字段拒写". Throwing inside `_recordResolvedManifest()` satisfies the fail-closed write guard; catching the throw in `reload()` satisfies the graceful-session requirement.

### 5. Write the file inside `sessionManager.getSessionDir()` with a deterministic name
- **Reason**: The session directory is the existing, stable persistence boundary for the session. Using `resolved-manifest-<slot>-<resolved_at>.json` makes the record discoverable for reconciliation and collision-free under normal clock monotonicity.

### 6. Extend the test harness with an optional `sessionDir`
- **Reason**: `SessionManager.inMemory()` uses an empty session directory, which would cause the write to land in the repo root during tests. Adding a `sessionDir` option lets tests opt into a real on-disk session directory without changing the default in-memory behavior for other tests.

## Files changed
- `packages/coding-agent/src/core/agent-session.ts` (+77 lines)
  - Adds field-level validation.
  - Writes JSON manifest to `resolved-manifest-gen0-<ts>.json`.
  - Wraps `_recordResolvedManifest()` in a try/catch inside `reload()`.
- `packages/coding-agent/test/suite/harness.ts` (+10 lines)
  - Adds optional `sessionDir` harness option.
- `packages/coding-agent/test/suite/evolution/agent-session-version-contract.test.ts` (+72 lines)
  - Asserts manifest file is written with the correct shape.
  - Asserts default contract (`"pending_0b"`) is accepted.
  - Asserts missing/invalid fields cause a throw and skip the write.
  - Asserts `reload()` still completes when recording fails.

## Verification
- `node ../../node_modules/vitest/dist/cli.js --run test/suite/evolution/agent-session-version-contract.test.ts` — 7/7 passed.
- `node ../../node_modules/vitest/dist/cli.js --run test/suite/evolution/` — 16/16 passed.
- `npx biome check <modified files>` — clean.
- `packages/agent/src/agent-loop.ts` remains unchanged.
