# Phase 4 完成报告：任务级 detector 与 teacher 回流

日期：2026-08-28  
状态：已完成  
上游 Spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 4  
执行计划：`doc/design/plans/2026-08-28-phase4-detector-teacher-plan.md`

## 1. 完成内容

| 任务 | 内容 | 关键文件 |
|---|---|---|
| P4-1 | 将现有 collectors 接入 `AgentSession` 事件流并产出 composite evidence artifact | `packages/coding-agent/src/core/evidence-sink.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/test/suite/evolution/agent-session-evidence.test.ts` |
| P4-2 | frozen shadow 任务级 detector v1（规则版）：`repeatedToolFailure` / `progressStalled` / `deliveryMissing` / `escalationRecommended` | `packages/agent/src/harness/detector/task-level-detector.ts`, `packages/agent/src/harness/agent-harness.ts`, `packages/coding-agent/test/suite/evolution/task-level-detector.test.ts` |
| P4-3 | 云教师纠正回流 pipeline：DLP/脱敏/outcome 对齐 | `packages/agent-server/src/evolution/dlp-scan.ts`, `packages/agent-server/src/evolution/teacher-correction-aligner.ts`, `packages/agent-server/test/evolution/teacher-correction-aligner.test.ts` |
| P4-4 | Phase 4 端到端集成测试与 shadow 评估指标 | `packages/agent-server/test/evolution/phase4-integration.test.ts`, `packages/agent-server/src/evolution/detector-metrics.ts`, `packages/agent-server/test/evolution/detector-metrics.test.ts` |

## 2. 关键设计决策

- **只读 shadow 顾问**：detector 以 `AgentHarness` 事件订阅者形式运行，记录信号但不改变 loop 控制流；`taskLevelDetectorVersion` 写入 `ScaffoldConfig`。
- **零跨包依赖**：`coding-agent` 不直接依赖 `agent-server`；`evidence-sink.ts` 作为本地 adapter 镜像 composite artifact 结构。
- **DLP 默认敏感**：teacher correction 回流前经过与 gateway 同款的保守 DLP 扫描；命中时拒绝并记录原因。
- **数据分级 pending**：新增 artifact/ref 继续使用 `data_class: "pending_0b"` / `retention_policy_ref: "pending_0b"`，不自行决定 TTL。
- **评估指标**：`computeDetectorMetrics` 提供 recall、falsePositiveRate、missRate、escalationCostCount、dlpBlockedCount。

## 3. 测试基线

| 范围 | 结果 |
|---|---|
| `npx tsgo --noEmit`（repo root） | 通过 |
| `npm run check`（biome + deps + ts-imports + shrinkwrap + tsgo + browser-smoke） | 通过 |
| `packages/coding-agent` evolution suite | 9 files / 66 tests 通过 |
| `packages/agent-server` evolution suite | 73 files / 609 tests 通过 |
| `./test.sh` | agent-server / coding-agent / agent / tui / evaluation-kernel 均通过；`packages/ai/test/fireworks-models.test.ts` 存在 1 条与上游 Fireworks 目录相关的既有失败，与 Phase 4 无关 |

## 4. 遗留与下一 Go/No-Go 点

- Phase 0b 数据分级、TTL、WORM 锚定频率仍待裁决；本阶段 artifact 使用 `pending_0b` 占位。
- detector v1 为规则版；后续若进入 Phase 5 源码级自举，需对照实验验证规则版收益后再评审 learned detector。
- 下一里程碑：Phase 5 受限源码级自举（需单独 Go Gate 与用户批准）。
