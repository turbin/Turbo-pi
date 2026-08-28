# Phase 0a M2/M3 完成决策记录

## 决策项

### 1. T9 gen0-rebuild 首事件类型：选项 A（shadow → active）

- **原因**：T5 状态机已冻结并通过 M1 审查，其 `FIRST_EVENT_TYPES` 要求首事件类型为 `shadow`。修改 T5 会触碰冻结面并触发重新审查。T9 作为机械重建脚本，先 emit `shadow` 再 emit `active` 可满足状态机约束，且不改动 `promotion-controller.ts`。
- **结果**：`cli.ts` 实际发出 5 个事件（shadow → canary_pending_approval → canary → active_pending_approval → active），这是当前状态机允许到达 `active` 的最短路径。

### 2. T8 子套件合并为单一 coder 任务

- **原因**：T8 所有子套件写入同一测试文件 `contract-suite.test.ts`。若拆给多个 coder 并行，会产生高频文件冲突和合并成本。
- **结果**：由 coder-B 顺序实现全部 5 个 describe 块，总长度 558 行，仍远低于 3000 行上限。

### 3. T6b 注入点选择

- **原因**：`agent-session.ts` 是 3283 行单体，要求最小侵入。`_installAgentNextTurnRefresh` 和 `reload()` 是已存在的生命周期钩子，分别对应上下文注入和会话关闭。
- **结果**：版本契约注入 `BuildSystemPromptOptions` 与 `ExtensionContext`；resolved manifest 记录在 `reload()` 中触发，由 `try/catch` 保证记录失败不中断会话。

### 4. T9 部署事件时间戳确定性

- **原因**：reviewer round 1 指出 `Date.now()` 导致 fresh `dataDir` 的 `deployment_event_id` 不稳定，违反 canonical hash 无时间戳噪声原则。
- **结果**：gen0 事件使用 `occurredAt = 0` 作为确定性锚点，事件 ID 跨目录稳定。

### 5. T9 输入校验前置

- **原因**：reviewer round 1 发现 `pinTaskContract` 在本地 scaffold/config 校验前调用，会产生无效 TEK 契约副作用。
- **结果**：`collectGenerationZeroFingerprints()` 与 missing-input 检查移至 `runGen0Rebuild` 最顶部，TEK 进程在验证通过后启动。

### 6. T9 资源关闭

- **原因**：reviewer round 1 发现 DB/registry 句柄未关闭。
- **结果**：`finally` 块中关闭 `evo` 和 `registry` 再停止 TEK 子进程。

### 7. T9 退出码语义

- **原因**：reviewer round 1 发现非 `UsageError`/`ContractError` 的异常被映射为 `2`（usage），与需求不符。
- **结果**：默认异常映射为 `1`（contract/build failure），仅 `UsageError` 使用 `2`。

## 验证结果

| 范围 | 测试文件数 | 用例数 | 结果 |
|---|---|---|---|
| coding-agent evolution | 2 | 16 | passed |
| agent-server evolution | 9 | 115 | passed |
| evaluation-kernel IPC | 1 | 21 | passed |
| agent-loop.ts diff | — | — | empty |
| biome check | 46 files | — | clean |

## 引用

- 任务书：`doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md`
- 架构：`doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md`
- PM 编排计划：`doc/design/plans/2026-08-28-pm-orchestration-plan.md`
- 进度：`doc/design/progress/2026-08-28-phase0a-progress.md`
