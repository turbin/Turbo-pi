| P3-T29：scaffold v1 外提与指纹 | **in_progress** | coder-M | 2026-08-28T15:00:00+08:00 | |
| P3-T30：scaffold operator 实现 | **in_progress** | coder-N | 2026-08-28T15:00:00+08:00 | |
| P3-T31：ExperimentProgram 与 trial loop | **in_progress** | coder-O | 2026-08-28T15:00:00+08:00 | |
| P3-T32：archive champion/stepping-stone/specialist | **in_progress** | coder-P | 2026-08-28T15:00:00+08:00 | |
| P3-T33：人工批准 canary/rollback 演练 | pending | | | |
| P3-T34：Phase 3 端到端集成测试 | pending | | | || P2-T22：经验快照构建器 | done | coder-H | 2026-08-28T14:05:00+08:00 | `experience-snapshot-builder.ts` 143 行 + test 137 行，5 用例绿 |
| P2-T23：lineage 追踪 | done | coder-I | 2026-08-28T14:05:00+08:00 | `lineage.ts` 133 行 + test 110 行，9 用例绿；`schema.ts` +13 行 |
| P2-T24：offline pipeline 到 candidate generator 适配 | done | coder-J | 2026-08-28T14:05:00+08:00 | `candidate-generator.ts` 262 行 + test 231 行，9 用例绿 |
| P2-T25：可执行 replay/validation | done | coder-K | 2026-08-28T14:15:00+08:00 | `replay-validator.ts` 234 行 + test 188 行，9 用例绿 |
| P2-T26：shadow-only 晋升 | done | coder-K | 2026-08-28T14:25:00+08:00 | `shadow-promoter.ts` 81 行 + test 203 行，5 用例绿 |
| P2-T27：post-D E0/E1 测量可信度集成 | done | coder-L | 2026-08-28T14:25:00+08:00 | `measurement-gate.ts` 154 行 + test 175 行，12 用例绿 |
| P2-T28：Phase 2 端到端集成测试 | **in_progress** | coder-D | 2026-08-28T14:30:00+08:00 | |# Phase 0a / 0b / 1 — 进度与交接

状态：进行中  
任务书：`doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md`  
PM 编排计划（Phase 0a）：`doc/design/plans/2026-08-28-pm-orchestration-plan.md`  
PM 编排计划（Phase 0b/1）：`doc/design/plans/2026-08-28-phase0b-phase1-orchestration-plan.md`  
当前里程碑：**Phase 3 波次 1 进行中（自动推进）**  
最近更新：2026-08-28T15:00:00+08:00 by PM（Phase 3 计划已生成，波次 1 已启动）

## 1. 子任务状态表

### Phase 0a

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| T1：evolution.db schema 与不变性约束 | done | coder-A | 2026-08-28T12:45:00+08:00 | `packages/agent-server/src/evolution/schema.ts`、`db.ts`、`append-only-dao.ts`、`test/evolution/schema.test.ts`（23 用例全绿） |
| T2：canonical artifact manifest 与 content-addressed hash | done | coder-B | 2026-08-28T12:08:00+08:00 | `packages/agent-server/src/evolution/canonical.ts`、`artifact-schema.ts`、`test/evolution/canonical.test.ts`（17 用例全绿） |
| T3：bundle builder / artifact registry（含 generation-0 构建） | done | coder-A | 2026-08-28T15:05:00+08:00 | `packages/agent-server/src/evolution/artifact-registry.ts`、`bundle-builder.ts`、`fingerprint.ts`、`build-gen0.ts`；`test/evolution/registry.test.ts`（9 用例全绿） |
| T4：Trusted Evaluation Kernel（TEK）骨架 | done | coder-C | 2026-08-28T14:15:00+08:00 | `packages/evaluation-kernel/` 全套骨架 + `test/ipc.test.ts` 21/21 绿 |
| T5：Promotion Controller 骨架与 deployment_event_stream | done | coder-B | 2026-08-28T15:15:00+08:00 | `packages/agent-server/src/evolution/promotion-controller.ts`、`audit-writer.ts`；`test/evolution/promotion.test.ts`（8 用例全绿） |
| T6a：slot 解析与 resolved manifest 记录 | done | coder-A | 2026-08-28T15:20:00+08:00 | `packages/agent-server/src/evolution/runtime-resolver.ts`、`record-resolved.ts`；`test/evolution/resolver.test.ts`（9 用例全绿） |
| T7：evidence plane 结构化字段扩展 | done | coder-C | 2026-08-28T15:10:00+08:00 | `packages/agent-server/src/evolution/evidence-schema.ts`、`taxonomy.ts`；`test/evolution/evidence-schema.test.ts`（10 用例全绿） |
| T6b-1：创建 `version-contract.ts` 读取模块 | done | coder-A | 2026-08-28T11:45:00+08:00 | `packages/coding-agent/src/core/evolution/version-contract.ts` 66 行 + test 111 行，9 用例绿 |
| T6b-2：agent-session 最小侵入式注入点 | done | coder-A | 2026-08-28T12:00:00+08:00 | `agent-session.ts` 27 行 diff + 上下文扩展 18 行，13 用例绿；agent-loop.ts 零 diff |
| T6b-3：会话结束 resolved manifest 记录器 | done | coder-A | 2026-08-28T12:20:00+08:00 | `agent-session.ts` +77 行，`harness.ts` +10 行，测试 197 行，7 用例绿 |
| T8：契约测试与 fail-closed 测试套件 | done | coder-B | 2026-08-28T12:00:00+08:00 | `contract-suite.test.ts` 558 行，17 用例绿 |
| T9：集成验收脚本（generation-0 一键重建） | done | coder-C | 2026-08-28T12:20:00+08:00 | `cli.ts` 520 行，13 用例绿 |

### Phase 0b + Phase 1

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| P0b-T10：参数注册 schema 与默认表 | done | coder-D | 2026-08-28T13:10:00+08:00 | `parameters.ts` 191 行 + test 123 行，12 用例绿 |
| P0b-T11：P1–P10 参数登记与校验 | done | coder-D | 2026-08-28T13:20:00+08:00 | `parameters.ts` +67 行，test 190 行，19 用例绿 |
| P0b-T12：Phase 0b 校验命令 | done | coder-D | 2026-08-28T13:20:00+08:00 | `cli.ts` +126 行，test 123 行，7 用例绿 |
| P1-T13：会话/任务与 scaffold/artifact/snapshot 关联 | done | coder-E | 2026-08-28T13:10:00+08:00 | `agent-session.ts` +30 行，test 293 行，12 用例绿 |
| P1-T14：结构化 tool event 采集 | done | coder-F | 2026-08-28T13:10:00+08:00 | `tool-event-collector.ts` 69 行 + test 84 行，8 用例绿 |
| P1-T15：product manifest 采集 | done | coder-F | 2026-08-28T13:10:00+08:00 | `product-manifest-collector.ts` 92 行 + test 101 行，8 用例绿 |
| P1-T16：grader outcome 与 user correction 采集 | done | coder-G | 2026-08-28T13:10:00+08:00 | `outcome-collector.ts` 106 行 + test 124 行，12 用例绿 |
| P1-T17：gateway escalation join key 采集 | done | coder-G | 2026-08-28T13:10:00+08:00 | `escalation-collector.ts` 78 行 + test 82 行，12 用例绿 |
| P1-T18：evidence artifact 构建器 | done | coder-E | 2026-08-28T13:20:00+08:00 | `evidence-artifact-builder.ts` 219 行 + test 186 行，6 用例绿 |
| P1-T19：失败 taxonomy 集成 | done | coder-E | 2026-08-28T13:30:00+08:00 | `failure-classifier.ts` 167 行 + test 174 行，13 用例绿 |
| P1-T20：证据对账查询 | done | coder-G | 2026-08-28T13:30:00+08:00 | `reconciliation.ts` 196 行 + test 157 行，6 用例绿 |
| P1-T21：Phase 1 端到端集成测试 | done | coder-D | 2026-08-28T13:40:00+08:00 | `phase1-integration.test.ts` 282 行，3 用例绿 |

### Phase 2

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| P2-T22：经验快照构建器 | **in_progress** | coder-H | 2026-08-28T14:00:00+08:00 | |
| P2-T23：lineage 追踪 | **in_progress** | coder-I | 2026-08-28T14:00:00+08:00 | |
| P2-T24：offline pipeline 到 candidate generator 适配 | **in_progress** | coder-J | 2026-08-28T14:00:00+08:00 | |
| P2-T25：可执行 replay/validation | pending | | | |
| P2-T26：shadow-only 晋升 | pending | | | |
| P2-T27：post-D E0/E1 测量可信度集成 | pending | | | |
| P2-T28：Phase 2 端到端集成测试 | pending | | | |

## 2. 里程碑状态

| 里程碑 | 状态 | 检查点 | 目标日期 |
|---|---|---|---|
| M0：Schema + TEK 包结构 + bundle registry 合同冻结 | done | 架构师 + 用户确认字段/契约/包入仓方式 | 2026-08-28 |
| M1：Artifact/Promotion/Runtime 三条主线可独立跑通 | done | 架构师 + 用户现场演示 CAS/状态机/断号 | 2026-08-28 |
| S1：M2/M3 任务分解与依赖确认 | done | 用户确认任务拆分、token/行数预算、里程碑顺序 | 2026-08-28 |
| S2：M2 T6b 实现完成 | done | T6b-1~3 全绿、agent-loop.ts 零改动 | 2026-08-28 |
| S3：M3 T8 实现完成 | done | 契约套件全绿 + 静态扫描通过 | 2026-08-28 |
| S4：M3 T9 实现完成 | done | gen0-rebuild 命令可用 + 集成测试绿 | 2026-08-28 |
| S5：Phase 0a M2/M3 汇总 | done | 用户最终验收 A1–A11 | 2026-08-28 |
| P0b-1：Phase 0b 参数框架就绪 | done | 自动推进 | 2026-08-28 |
| P0b-2：Phase 0b 参数登记完成 | done | 自动推进（review round 1 PASS_WITH_MINOR） | 2026-08-28 |
| P1-1：证据采集模块完成 | done | 自动推进 | 2026-08-28 |
| P1-2：证据 artifact 构建器完成 | done | 自动推进 | 2026-08-28 |
| P1-3：失败 taxonomy 与对账完成 | done | 自动推进（review round 1 PASS_WITH_MINOR） | 2026-08-28 |
| P1-4：Phase 1 端到端验收 | done | 自动推进（review round 1 PASS） | 2026-08-28 |
| S6：Phase 0b+1 汇总 | done | 自动推进 | 2026-08-28 |
| P2-1：经验快照构建器与谱系 | done | 自动推进（round 2 PASS） | 2026-08-28 |
| P2-2：候选生成器适配 | done | 自动推进（round 2 PASS） | 2026-08-28 |
| P2-3：可执行 replay/validation | done | 自动推进（round 2 PASS） | 2026-08-28 |
| P2-4：shadow-only 晋升 | done | 自动推进（round 2 PASS） | 2026-08-28 |
| P2-5：测量可信度集成 | done | 自动推进（round 1 PASS_WITH_MINOR） | 2026-08-28 |
| S7：Phase 2 汇总 | done | 自动推进 | 2026-08-28 |

## 3. 交接信息（跨 agent 共享事实）

- Phase 0a 完成决策记录：`doc/design/2026-08-28-phase0a-m2m3-completion-changes-and-decisions.md`。
- Phase 0b/1 PM 编排计划：`doc/design/plans/2026-08-28-phase0b-phase1-orchestration-plan.md`。
- 当前时间 2026-08-28T13:25:00+08:00 落在 14:00–18:00 禁启窗口外，可继续运行。

## 4. 断点恢复指引

如果从零接手：
1. 先读 V3 设计 `doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md`。
2. 再读 Phase 0a 任务书与完成记录。
3. 当前正在执行 Phase 0b/1 波次 3（P1-T19 失败 taxonomy 集成、P1-T20 证据对账查询）。
