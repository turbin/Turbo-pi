# Phase 3 scaffold 配置进化完成决策记录

日期：2026-08-28

引用：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 3、`doc/design/plans/2026-08-28-phase3-orchestration-plan.md`

## 结论

完成 Phase 3（scaffold 配置进化）全部 6 项任务（T29–T34）：

- T29：在 `packages/coding-agent` 外提 scaffold v1 为不可变、可哈希配置，并提供运行时解析器。
- T30：在 `packages/agent-server/evolution` 实现 5 个 scaffold operator（draft/improve/debug/crossover/consolidate），输出统一 `scaffold_config` artifact。
- T31：实现 autoresearch 式 `ExperimentProgram` 与有界 trial loop，支持 maxTrials、maxConsecutiveCrashes、token/wall-time 预算、平台期停止与 provisional frontier。
- T32：实现 archive，保留 champion/stepping-stone/specialist 三类候选并执行 retention limits。
- T33：实现 `CanaryManager`，支持人工批准的 canary/active 两级晋升与 rollback。
- T34：完成 Phase 3 端到端集成测试，覆盖候选生成 → 实验评估 → 可信门 → archive → canary → active → rollback 到 gen0 全链。

测试基线：agent-server evolution 27 个测试文件 247 个测试全绿；coding-agent evolution 7 个测试文件 61 个测试全绿。新增代码均通过 biome check 与 tsgo 类型检查（仅存在 packages/ai/test 的 43 个预存 model-id 错误，不在本阶段范围）。

## 决策

### P3-D1：coding-agent 与 agent-server 各保留一份 scaffold 类型

原因：`packages/agent-server` 不依赖 `packages/coding-agent`，且进化控制面需要独立演进。两份类型字段保持一致，通过集成测试与 canonical JSON 哈希间接对齐；未来若需共享可再提取公共包，但当前避免新增包间依赖。

### P3-D2：scaffold operator 复用统一 operator 集合（draft/improve/debug/crossover/consolidate）

原因：与 V3 设计 §6.2 / §8.2 一致，经验、配置、源码候选共用同一 operator 命名空间，便于统一谱系与审计。

### P3-D3：operator 输出必须是内容寻址 `scaffold_config` artifact

原因：保证候选不可变、可复算，且与现有 `artifact_immutable_manifests` / `lineage_edges` schema 直接兼容。

### P3-D4：ExperimentProgram 固定 evaluator、scope、budget 与停止规则

原因：落实 autoresearch 纪律，防止候选同时改变目标、评价器和预算，避免 Goodhart/Wireheading 路径。

### P3-D5：trial loop 记录 crash 作为停止信号

原因：高方差 agent 任务中，连续 crash 是比单一分数更危险的成本/安全信号；记入 ledger 后 stop rule 可 fail-closed。

### P3-D6：archive 角色分配采用分层规则

原因：champion 取全局最高 primary score，stepping-stone 取与 champion 结构不同的候选，specialist 取各 domain 最优；避免单链 hill-climbing，符合 DGM 档案思想（V3 §5.2 / SE-07）。

### P3-D7：canary/active 晋升必须显式人工批准

原因：M2/M3 配置变更影响在线行为，必须保留人类保留权（V3 §6.3 / §13）；`CanaryManager` 仅在没有正确状态机前驱时拒绝，不替代人工判断。

### P3-D8：rollback 直接指向上一已知良好 artifact（通常为 gen0 bundle）

原因：本阶段不维护复杂的 multi-version 槽位历史；rollback 演练的核心是验证可一键切回 generation 0，满足验收标准。

### P3-D9：Phase 3 集成测试使用确定性 mock evaluator

原因：真实 LLM/任务评估在 Phase 0b 与 D 阶段已有独立清单约束；本阶段聚焦控制面闭环正确性，因此用确定性分数模拟 evaluator，同时保留 `measurement-gate` 与 `checkMeasurementCredibility` 真实路径。

## 文件变更

新增：

- `packages/coding-agent/src/core/scaffold/schema.ts`
- `packages/coding-agent/src/core/scaffold/fingerprint.ts`
- `packages/coding-agent/src/core/scaffold/resolver.ts`
- `packages/coding-agent/src/core/scaffold/index.ts`
- `packages/coding-agent/test/suite/evolution/scaffold-config.test.ts`
- `packages/agent-server/src/evolution/scaffold-config.ts`
- `packages/agent-server/src/evolution/scaffold-operators.ts`
- `packages/agent-server/src/evolution/experiment-program.ts`
- `packages/agent-server/src/evolution/archive.ts`
- `packages/agent-server/src/evolution/canary-manager.ts`
- `packages/agent-server/test/evolution/scaffold-operators.test.ts`
- `packages/agent-server/test/evolution/experiment-program.test.ts`
- `packages/agent-server/test/evolution/archive.test.ts`
- `packages/agent-server/test/evolution/canary-manager.test.ts`
- `packages/agent-server/test/evolution/phase3-integration.test.ts`

修改：

- `doc/design/plans/2026-08-28-phase3-orchestration-plan.md`（里程碑与任务状态更新）

## 验证

```bash
# coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/evolution/scaffold-config.test.ts

# agent-server（Node 25.9.0）
../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run test/evolution/

# 类型检查（本阶段新增文件无新增错误）
npx tsgo --noEmit
```

## 遗留与下一步

- Phase 3 控制面当前为本地诊断模式；生产 WORM 锚定、独立 TEK 进程/OS 身份、签名轮换仍属 Phase 0b 参数，待责任人确认后排期。
- 真实 scaffold 配置切换需要与 `packages/coding-agent/src/core/agent-session.ts` 的运行时加载路径对接（当前 resolver 已提供配置提取，但实际切换仍由人工通过 canary/rollback 演练控制）。
- 下一工程授权点为 S8 汇总与是否进入 Phase 4（任务级 detector / teacher 回流）的 Go/No-Go 评审。
