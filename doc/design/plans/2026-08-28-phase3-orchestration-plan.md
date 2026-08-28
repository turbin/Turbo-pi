# PM 编排计划：Phase 3 scaffold 配置进化

## 1. 目标与范围

基于 Phase 0a/0b/1/2 已完成的基础设施，实现 Phase 3：
- 外提 scaffold v1 为不可变、可哈希配置
- 实现小范围 operator（检索上限、注入模板、工具启用、prompt 片段）
- archive 保留 champion/stepping-stone/specialist
- 实现 autoresearch 式 ExperimentProgram、有界 trial loop、签名事件链和 provisional frontier
- 人工批准 canary 与 rollback 演练

验收标准：至少一个真实候选完成全评估并按预注册门得到可复算的批准或拒绝结论；若获批则经人工进入 canary；无论候选是否获批，一键切回 generation 0 的演练均成功。

## 2. 里程碑（自动推进）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| P3-1 | scaffold v1 外提与指纹 | 完成 |
| P3-2 | scaffold operator 实现 | 完成 |
| P3-3 | ExperimentProgram 与 trial loop | 完成 |
| P3-4 | archive champion/stepping-stone/specialist | 完成 |
| P3-5 | 人工批准 canary/rollback 演练 | 完成 |
| S8 | Phase 3 汇总 | 完成 |

## 3. 任务分解

### T29：scaffold v1 外提与指纹

| 字段 | 内容 |
|---|---|
| 标题 | 将 scaffold 配置外提为不可变、可哈希配置 |
| 目标 | 提取 system prompt、tools、retrieval limits、injection limits、compaction、retry 等配置为 canonical JSON；生成 scaffold hash；与 gen0 bundle 对齐 |
| 依赖 | Phase 0a 已完成 |
| 并行组 | 可与 T30/T31 并行 |
| Token 估算 | 设计 15k + 实现 30k + 测试 20k + 修复 15k = **约 96k** |
| 行数预算 | 约 500 行 |
| 文件范围 | `packages/coding-agent/src/core/scaffold/`（新建）、test |
| TDD 测试 | 配置外提、hash 稳定性、与 gen0 对齐 |
| 负责人 | coder-M |
| 状态 | done |

### T30：scaffold operator 实现

| 字段 | 内容 |
|---|---|
| 标题 | 实现小范围 scaffold operator |
| 目标 | 支持 draft/improve/debug/crossover/consolidate 对 scaffold 配置的操作；输出为 scaffold config artifact |
| 依赖 | T29 |
| 并行组 | 无 |
| Token 估算 | 设计 15k + 实现 35k + 测试 25k + 修复 15k = **约 105k** |
| 行数预算 | 约 600 行 |
| 文件范围 | `packages/agent-server/src/evolution/scaffold-operators.ts`（新建）、test |
| TDD 测试 | 各 operator 行为、artifact 生成、边界条件 |
| 负责人 | coder-N |
| 状态 | done |

### T31：ExperimentProgram 与 trial loop

| 字段 | 内容 |
|---|---|
| 标题 | 实现 autoresearch 式 ExperimentProgram 与有界 trial loop |
| 目标 | ExperimentProgram 包含 baseline、scope、evaluator、hypothesis、metrics、hard guardrails、固定预算；trial loop 支持 maxTrials、maxConsecutiveCrashes、平台期停止 |
| 依赖 | T30 |
| 并行组 | 可与 T32 并行 |
| Token 估算 | 设计 15k + 实现 35k + 测试 25k + 修复 15k = **约 105k** |
| 行数预算 | 约 600 行 |
| 文件范围 | `packages/agent-server/src/evolution/experiment-program.ts`（新建）、test |
| TDD 测试 | program 创建、trial 循环、停止条件 |
| 负责人 | coder-O |
| 状态 | done |

### T32：archive champion/stepping-stone/specialist

| 字段 | 内容 |
|---|---|
| 标题 | 实现 archive 三类候选保留策略 |
| 目标 | archive 保留 champion（综合最优）、stepping-stone（结构新颖）、specialist（特定 domain 更优）；支持查询与检索 |
| 依赖 | T30 |
| 并行组 | 可与 T31 并行 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/archive.ts`（新建）、test |
| TDD 测试 | 三类候选保留、查询、检索 |
| 负责人 | coder-P |
| 状态 | done |

### T33：人工批准 canary/rollback 演练

| 字段 | 内容 |
|---|---|
| 标题 | 实现人工批准 canary 与 rollback 演练 |
| 目标 | 提供 CLI/接口供人工批准 canary；实现 rollback 到上一已知良好版本；演练脚本 |
| 依赖 | T31/T32 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 18k + 修复 12k = **约 80k** |
| 行数预算 | 约 450 行 |
| 文件范围 | `packages/agent-server/src/evolution/canary-manager.ts`（新建）、test |
| TDD 测试 | canary 批准、rollback、演练 |
| 负责人 | coder-D |
| 状态 | done |

### T34：Phase 3 集成测试

| 字段 | 内容 |
|---|---|
| 标题 | Phase 3 端到端集成测试 |
| 目标 | 真实候选完成全评估并按预注册门得到可复算结论；rollback 到 gen0 成功 |
| 依赖 | T33 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 20k + 修复 12k = **约 83k** |
| 行数预算 | 约 400 行 |
| 文件范围 | `packages/agent-server/test/evolution/phase3-integration.test.ts` |
| TDD 测试 | 端到端全链、rollback 演练 |
| 负责人 | coder-D |
| 状态 | done |

## 4. 并行开发分组

| 波次 | 并行任务 |
|---|---|
| 波次 1 | T29、T30、T31、T32 |
| 波次 2 | T33 |
| 波次 3 | T34 |

## 5. 关联文档

- V3 设计：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 3
- Phase 2 完成记录：`doc/design/2026-08-28-phase2-completion-changes-and-decisions.md`
