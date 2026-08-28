# M2-T6b-2 Version Contract Wiring Changes and Decisions

## Task
Wire the version contract module created in M2-T6b-1 into `packages/coding-agent/src/core/agent-session.ts` with a minimal diff.

## Decisions

### 1. Load the contract once in `AgentSession` and expose it via a read-only getter
- **Reason**: The contract is immutable for the lifetime of the session. Loading it in the constructor and caching it in `_versionContract` avoids repeated environment lookups and gives downstream code stable access through `session.versionContract`.

### 2. Inject the contract into both the system-prompt context and the extension context
- **Reason**: Requirement 3 asked for the three fields to be readable by "system prompt builders, extension contexts". The cleanest existing hooks were:
  - `BuildSystemPromptOptions` for system-prompt construction (`_rebuildSystemPrompt`).
  - `ExtensionContext` for extension/tool handlers (`ExtensionRunner.createContext()`).
- The field is optional in `BuildSystemPromptOptions` to keep the diff minimal and avoid forcing every test/future caller to provide it; it is required in `ExtensionContext` because the runner always has the contract available.

### 3. Pass the contract to `ExtensionRunner` through its constructor
- **Reason**: The contract is static for a given runner instance. Adding it as a constructor parameter keeps `createContext()` a simple property read and avoids adding another binding method or context-action callback. Only `AgentSession._buildRuntime()` constructs `ExtensionRunner`, so the blast radius is small.

### 4. Call `_recordResolvedManifest()` from `reload()`
- **Reason**: `reload()` already emits `session_shutdown` with reason `"reload"`, making it the single most appropriate existing shutdown hook. No new public method or event listener was needed. The method prepares the payload (version contract, session provider/model, and `{ cwd }`) and logs it with `console.debug`; persistence is intentionally left for M2-T6b-3.

### 5. Updated existing `ExtensionRunner` test callers and the TUI shortcut context
- **Reason**: Adding a required `versionContract` field to `ExtensionContext` and a constructor parameter to `ExtensionRunner` made these mechanical updates necessary for compilation. All updates use `DEFAULT_VERSION_CONTRACT` to stay neutral.

## Files changed
- `packages/coding-agent/src/core/agent-session.ts` (+27)
- `packages/coding-agent/src/core/extensions/runner.ts` (+8)
- `packages/coding-agent/src/core/extensions/types.ts` (+3)
- `packages/coding-agent/src/core/system-prompt.ts` (+3)
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (+1)
- `packages/coding-agent/test/suite/evolution/agent-session-version-contract.test.ts` (new, +125)
- Mechanical test updates in `extensions-input-event.test.ts`, `extensions-runner.test.ts`, `resource-loader.test.ts`, `trigger-compact-extension.test.ts`.

## Verification
- `node ../../node_modules/vitest/dist/cli.js --run test/suite/evolution/version-contract.test.ts` passes.
- New `agent-session-version-contract.test.ts` passes.
- Full `coding-agent` suite passes: 171 files, 1583 tests passed.
- `npx tsgo --noEmit -p tsconfig.build.json` passes for `packages/coding-agent`.
- `packages/agent/src/agent-loop.ts` has zero diff.
