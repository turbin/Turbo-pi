# PM 编排计划：Phase 2 经验候选 shadow

## 1. 目标与范围

基于 Phase 0b/1 已完成的证据平面，实现 Phase 2：
- 将现有 offline pipeline 接成 M1 candidate generator
- 新增版本化 experience snapshot builder 和 lineage
- LLM 质量门后增加 executable replay/validation；候选仅进入 shadow
- 用当前 post-D E0/E1 机制验证测量可信度后再做真实比较

验收标准：完成一次 `active v1 → candidate v2 → rejected/accepted shadow` 全链，active 未被自动改写，结果可复算。

## 2. 里程碑（自动推进）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| P2-1 | 经验快照构建器与谱系 | 进行中 |
| P2-2 | 候选生成器适配 | 进行中 |
| P2-3 | 可执行 replay/validation | 进行中 |
| P2-4 | shadow-only 晋升 | 进行中 |
| P2-5 | 测量可信度集成 | 进行中 |
| S7 | Phase 2 汇总 | 待启动 |

## 3. 任务分解

### T22：经验快照构建器

| 字段 | 内容 |
|---|---|
| 标题 | 版本化 experience snapshot builder |
| 目标 | 从当前 active experience 库生成不可变快照 artifact；记录 snapshot SHA、条目数、来源 DB SHA |
| 依赖 | T3 artifact-registry |
| 并行组 | 可与 T23/T24 并行 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/experience-snapshot-builder.ts`（新建）、test |
| TDD 测试 | 快照生成、内容哈希、版本递增 |
| 负责人 | coder-H |
| 状态 | pending |

### T23：lineage 追踪

| 字段 | 内容 |
|---|---|
| 标题 | artifact lineage 追踪 |
| 目标 | 记录 parent/child/operator 关系；支持 improve/debug/crossover/consolidate/rollback |
| 依赖 | T22 |
| 并行组 | 可与 T22/T24 并行 |
| Token 估算 | 设计 8k + 实现 18k + 测试 12k + 修复 8k = **约 55k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/agent-server/src/evolution/lineage.ts`（新建）、test |
| TDD 测试 | 谱系记录、父代查询、crossover 来源追踪 |
| 负责人 | coder-I |
| 状态 | pending |

### T24：offline pipeline 到 candidate generator 适配

| 字段 | 内容 |
|---|---|
| 标题 | 将现有 offline pipeline 接成 M1 candidate generator |
| 目标 | 包装现有 `runDailyEvolution` 为 candidate generator；输出为 experience snapshot artifact |
| 依赖 | T22 |
| 并行组 | 可与 T22/T23 并行 |
| Token 估算 | 设计 15k + 实现 30k + 测试 20k + 修复 15k = **约 96k** |
| 行数预算 | 约 500 行 |
| 文件范围 | `packages/agent-server/src/evolution/candidate-generator.ts`（新建）、test |
| TDD 测试 | 生成候选、输出 artifact、保留失败记录 |
| 负责人 | coder-J |
| 状态 | pending |

### T25：可执行 replay/validation

| 字段 | 内容 |
|---|---|
| 标题 | 候选经验 replay/validation |
| 目标 | 对候选 experience snapshot 执行 paired replay；与 baseline 比较；结果进入 attestation |
| 依赖 | T24 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 18k + 修复 12k = **约 80k** |
| 行数预算 | 约 400 行 |
| 文件范围 | `packages/agent-server/src/evolution/replay-validator.ts`（新建）、test |
| TDD 测试 | replay 执行、baseline 比较、attestation 生成 |
| 负责人 | coder-K |
| 状态 | pending |

### T26：shadow-only 晋升

| 字段 | 内容 |
|---|---|
| 标题 | M1 候选 shadow-only 晋升 |
| 目标 | 候选经 replay/validation 后进入 shadow slot；不得自动替换 active；shadow 结果记录 |
| 依赖 | T25、T5 promotion controller |
| 并行组 | 无 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/shadow-promoter.ts`（新建）、test |
| TDD 测试 | shadow 事件发射、active 不被替换、结果记录 |
| 负责人 | coder-K |
| 状态 | pending |

### T27：post-D E0/E1 测量可信度集成

| 字段 | 内容 |
|---|---|
| 标题 | post-D E0/E1 测量可信度集成 |
| 目标 | 在 replay/validation 前执行 E0/E1 检查；不信任测量时拒绝进入 shadow |
| 依赖 | T25 |
| 并行组 | 可与 T26 并行 |
| Token 估算 | 设计 12k + 实现 22k + 测试 15k + 修复 10k = **约 71k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/measurement-gate.ts`（新建）、test |
| TDD 测试 | E0/E1 检查、不信任时拒绝 |
| 负责人 | coder-L |
| 状态 | pending |

### T28：Phase 2 集成测试

| 字段 | 内容 |
|---|---|
| 标题 | Phase 2 端到端集成测试 |
| 目标 | active v1 → candidate v2 → shadow 全链；active 不被改写；结果可复算 |
| 依赖 | T26/T27 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 20k + 修复 12k = **约 83k** |
| 行数预算 | 约 400 行 |
| 文件范围 | `packages/agent-server/test/evolution/phase2-integration.test.ts` |
| TDD 测试 | 端到端全链 |
| 负责人 | coder-D |
| 状态 | pending |

## 4. 并行开发分组

| 波次 | 并行任务 |
|---|---|
| 波次 1 | T22、T23、T24 |
| 波次 2 | T25 |
| 波次 3 | T26、T27 |
| 波次 4 | T28 |

## 5. 关联文档

- V3 设计：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 2
- Phase 0a/0b/1 完成记录：`doc/design/2026-08-28-phase0a-m2m3-completion-changes-and-decisions.md`、`doc/design/2026-08-28-phase0b-phase1-completion-changes-and-decisions.md`
