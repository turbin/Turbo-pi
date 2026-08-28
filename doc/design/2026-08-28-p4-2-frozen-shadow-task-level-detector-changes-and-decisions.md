# P4-2：frozen shadow 任务级 detector v1（规则版）决策记录

日期：2026-08-28  
任务：Phase 4 Task P4-2 — 任务级 detector v1（规则版）  
上游计划：`doc/design/plans/2026-08-28-phase4-detector-teacher-plan.md`  
相关实现：
- `packages/agent/src/harness/detector/task-level-detector.ts`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/coding-agent/src/core/evidence-sink.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/scaffold/resolver.ts`
- `packages/coding-agent/test/suite/evolution/task-level-detector.test.ts`

## 决策清单

### D-01：detector 定位——只读 shadow，不干预 loop
- **决策**：detector 仅作为事件订阅者/顾问计算信号并写入证据平面，绝不返回影响循环控制流的结果。
- **理由**：Phase 4 明确处于"冻结 shadow"阶段，任何自动干预都需要人工 Go Gate；先收集可审计信号再评估召回/误报。
- **实现**：
  - `AgentHarness` 新增 `subscribeShadow`，shadow listener 错误被吞掉、返回值被忽略。
  - `AgentHarness.attachShadowTaskLevelDetector` 只读地订阅 `agent_start` / `before_agent_start` / `tool_execution_end` / `turn_end` / `agent_end`。
  - `AgentSession` 中将 detector 输出作为可选字段传入 `evidence-sink`，不影响原有 loop。

### D-02：detector 放在 `packages/agent/src/harness/detector/`，避免跨包耦合
- **决策**：纯计算逻辑放在 `packages/agent`，通过 `@earendil-works/pi-agent-core` 导出；具体证据持久化由 `packages/coding-agent` 完成。
- **理由**：`packages/agent` 不应依赖 `packages/coding-agent`；`coding-agent` 已依赖 `agent`，可复用 detector。
- **实现**：detector 输入使用本地定义的 `TaskLevelDetectorScaffold` 等接口，`ScaffoldConfig` 通过结构类型匹配传入。

### D-03：v1 规则集合——简单、可解释、可回归
- **决策**：v1 采用确定性规则，信号包括：
  - `repeatedToolFailure`：同一工具名连续失败 N 次（默认 N=2，可由 scaffold 配置）。
  - `progressStalled`：连续 tool events 的 `argsHash` 相同。
  - `deliveryMissing`：有 tool use 后，最终 assistant message 无可交付内容（无 text/thinking/file）。
  - `escalationRecommended`：任一上述信号 confidence > 0.5。
- **理由**：规则版先做召回与可解释性验证，为后续 ML/LLM 版建立基准和回归测试。
- **实现**：`computeTaskLevelDetectorSnapshot` 纯函数，side-effect-free。

### D-04：confidence 与 evidence refs 设计
- **决策**：每个信号带 `confidence`（0–1）和 `evidenceRefs`（字符串引用，如 `tool_event:0`、`turn:1`）。
- **理由**：证据平面需要可追溯；升级门需要阈值比较；引用格式保持人类可读且便于与 blob 索引对齐。
- **实现**：snapshot 包含 `signals`、`recommended`、`originalTask`、`computedAt`。

### D-05：detector 版本门控——`taskLevelDetectorVersion`
- **决策**：`ScaffoldConfig.taskLevelDetectorVersion` 控制开关；`"off"` 或 undefined 禁用，`"v1-rule"` 启用 v1。
- **理由**：与 Phase 3 已定义的 scaffold 字段保持一致；支持后续切换 v2 时按版本隔离评估。
- **实现**：
  - `AgentSessionConfig` 新增可选 `taskLevelDetectorVersion`，默认 `"v1-rule"`。
  - `AgentSession.taskLevelDetectorVersion` getter 供 `resolveScaffoldConfig` 使用。
  - 检测器在 `version === "off"` 时返回空 snapshot。

### D-06：证据 artifact 中嵌入 detector snapshot
- **决策**：`evidence-sink` 在 composite evidence blob 中增加 `detector_snapshot` 字段，并在 manifest `evidence_refs` 中登记 `detector_signals:<count>`。
- **理由**：P4-1 证据平面已固化，P4-2 只需追加只读信号，不破坏现有 artifact 结构。
- **实现**：`EvidenceArtifactInput` 新增可选 `detectorSnapshot`；blob 内容与 manifest refs 同步更新。

### D-07：浏览器 bundle 兼容性
- **决策**：detector 不使用 `node:crypto`，改用浏览器安全的确定性 64-bit 字符串哈希（cyrb53）。
- **理由**：`packages/agent` 会被浏览器 smoke 打包；`node:crypto` 无法被 esbuild 解析。
- **实现**：`hashCanonicalForDetector` 使用 cyrb53；仅用于 progress-stall 检测，不需要密码学安全。

### D-08：测试策略——faux provider + 证据 artifact 断言
- **决策**：新增 `packages/coding-agent/test/suite/evolution/task-level-detector.test.ts`，用 faux provider 模拟重复失败、正常完成、交付缺失三种场景，并断言 snapshot 进入 evidence artifact。
- **理由**：不调用真实模型；覆盖 detector → evidence 的端到端路径；作为回归测试永久保留。
- **实现**：4 个测试用例，验证 detector 启用/禁用、信号存在性、escalation 推荐。

## 验证结果

- `npx tsgo --noEmit`：通过。
- `npm run check`：通过（biome、pinned-deps、ts-imports、shrinkwrap、install-lock、tsgo、browser-smoke）。
- `node ../../node_modules/vitest/dist/cli.js --run test/suite/evolution/`（`packages/coding-agent`）：9 文件 66 测试通过。
- `./test.sh`：通过 74 个测试文件 / 555 测试；唯一失败为 `test/fireworks-models.test.ts` 的 Fireworks 模型注册测试，依赖上游 fireworks 模型目录，与本次改动无关。

## 遗留与 TODO

- P4-3：teacher correction 回流 pipeline（DLP + 脱敏 + outcome 对齐）。
- P4-4：Phase 4 集成测试与 shadow 评估指标。
- S9：Phase 4 收尾决策记录、INDEX 更新、回归测试归档。
- detector v2：在 v1 规则基线稳定后，再引入基于历史失败簇的轻量模型/LLM 信号；同一批数据不既训练又测试。
