# Phase 4 实施计划：任务级 detector 与 teacher 回流

日期：2026-08-28  
状态：已完成  
上游约束：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 4

## 1. 目标

在 agent/harness 层实现**只读 shadow 任务级 detector**，识别跨回合进展停滞、重复工具失败、交付缺失等信号；同时将 gateway 云教师纠正经 DLP/脱敏/任务 outcome 对齐后回流到证据平面，为后续经验候选生成提供可审计的纠正信号。

Phase 4 不改变现有注入、晋升或 active scaffold；detector 在人工批准前不自动干预 loop。

## 2. 验收标准

- 一次真实或模拟任务可产出包含 detector 信号、tool events、escalation join key 和 teacher correction 的 composite evidence artifact。
- detector 在重复失败 / 交付缺失场景下召回，正常完成场景下不误报；指标（召回、误报、漏报、升级成本、最小化外发内容）可报告。
- 云升级后的 teacher correction 仅在 DLP 通过、outcome 改善时才生成 evidence ref；DLP 命中或 outcome 未改善时不回流。
- detector 版本先冻结再 shadow 评估；同一批数据不既训练又测试。
- 不触碰 Phase 0a 冻结的 M0 路径与接口。

## 3. 任务拆分

| 编号 | 任务 | 预计工期 | 依赖 | 验收点 |
|---|---|---|---|---|
| P4-1 | 将现有 collectors 接入 `AgentSession` 事件流并产出 evidence artifact | 1–2 天 | Phase 1/2/3 已完成的 collectors、evidence builder | `AgentSession.prompt()` 后可重建 evidence artifact |
| P4-2 | 实现 frozen shadow 任务级 detector v1（规则版） | 2–3 天 | P4-1、scaffold `taskLevelDetectorVersion` | 重复失败/交付缺失场景召回，不误改 loop |
| P4-3 | 云教师纠正回流 pipeline（DLP + 脱敏 + outcome 对齐） | 2–3 天 | gateway escalation marker、grader outcome、P4-1 | DLP 通过且 outcome 改善才生成 teacher_correction ref |
| P4-4 | Phase 4 集成测试与 shadow 评估指标 | 1 天 | P4-1~P4-3 | end-to-end 测试覆盖 detector → evidence → teacher correction |
| S9 | Phase 4 收尾：决策记录、INDEX 更新、回归测试 | 0.5 天 | P4-4 | 文档与测试归档 |

## 4. 关键设计决策

### 4.1 detector 挂载位置

作为 `AgentHarness` 事件订阅者 / `shouldStopAfterTurn` 风格顾问，只读建议，不阻塞用户输出。版本号写入 `ScaffoldConfig.taskLevelDetectorVersion`。

### 4.2 证据汇聚

`AgentSession` 实例化并消费四个 collector：
- `tool-event-collector.ts`
- `outcome-collector.ts`
- `escalation-collector.ts`
- `product-manifest-collector.ts`

task 结束时通过 `evidence-sink.ts` 把结构镜像灌入 `packages/agent-server` 的 `evidence-artifact-builder`。

### 4.3 teacher correction 对齐

新建 `packages/agent-server/src/evolution/teacher-correction-aligner.ts`：
- 输入：local run、escalation run、gateway marker、grader outcome、user correction。
- 输出：teacher_correction evidence ref 或拒绝原因。
- DLP/脱敏默认复用 gateway 规则（pattern 列表待 Phase 0b 裁决，暂用与 gateway 同款的保守集合）。

### 4.4 数据分级

新增 artifact 继续使用 `data_class: "pending_0b"` 和 `retention_policy_ref: "pending_0b"`，不自行决定 TTL。

## 5. 风险与约束

- **M0 冻结**：不得修改 `packages/agent/src/agent-loop.ts`、`packages/evaluation-kernel/`、`packages/agent-server/src/evolution/promotion-controller.ts` 等。detector 以插件/钩子形式存在。
- **TEK 边界**：若需要 TEK 验证，只通过窄 IPC 调用。
- **Gateway 边界**：gateway 只做请求级质量门，跨 turn detector 不上沉/不下沉。
- **未授权不干预**：detector 信号只记录、报告、candidate 生成；不自动修改 active scaffold 或用户输出。

## 6. 变更登记

本计划创建/修订时同步更新 `doc/design/INDEX.md`。
