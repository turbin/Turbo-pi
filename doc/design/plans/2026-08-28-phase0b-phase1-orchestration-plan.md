# PM 编排计划：Phase 0b 参数预注册 + Phase 1 证据平面

## 1. 目标与范围

基于已完成的 Phase 0a（冻结原则与 fail-closed 合同）和 V3 对抗审核共识，规划后续两个阶段：

- **Phase 0b**：预注册运营与数据参数（P1–P10）
- **Phase 1**：证据平面实现（结构化证据采集、对账、失败 taxonomy）

每个任务：
- 估算 token 成本
- 单次提交行数 **< 3000**
- 采用 TDD 流程
- 并行开发
- 里程碑审查通过后**自动推进**（不再等待人工确认）
- 对抗式 critic-reviewer（≤5 轮）

## 2. 阶段边界与依赖

```text
Phase 0a（done）── Phase 0b（参数登记）── Phase 1（证据平面）
      │                    │                    │
      └────────────────────┴────────────────────┘
                    Phase 2（经验候选 shadow，未排期）
```

- Phase 0b 与 Phase 1 可大部分并行：0b 是纯参数/配置/文档工作，不阻塞 Phase 1 的代码实现。
- Phase 1 必须在 Phase 0b 完成 P3（data class）、P7（gen0 指纹范围）、P8（issue-023 数值）登记后才能最终验收。

## 3. 里程碑（自动推进）

### 里程碑 P0b-1：Phase 0b 参数框架就绪
- 完成参数注册 schema、默认登记表、校验脚本
- 自动进入下一任务

### 里程碑 P0b-2：Phase 0b 参数登记完成
- P1–P10 全部登记，含 owner、依据、版本、有效期、fail-closed 默认值
- 校验通过
- 自动进入 Phase 1 验收

### 里程碑 P1-1：证据采集模块完成
- session/task 关联、tool event、product manifest、grader outcome、user correction、gateway escalation 采集接口
- 自动进入下一任务

### 里程碑 P1-2：证据 artifact 构建器完成
- evidence artifact 聚合、字段校验、写入路径
- 自动进入下一任务

### 里程碑 P1-3：失败 taxonomy 与对账完成
- 失败分类、unknown 桶、对账查询
- 自动进入下一任务

### 里程碑 P1-4：Phase 1 端到端验收
- 随机抽样任务可从 task → request → model run → session → artifacts → grader 完整对账
- 零孤儿记录
- 自动进入汇总

### 里程碑 S6：Phase 0b+1 汇总
- 生成完成决策记录
- 更新 progress 文件

## 4. 任务分解

### Phase 0b 任务组

#### T10：参数注册 schema 与默认表

| 字段 | 内容 |
|---|---|
| ID | P0b-T10 |
| 标题 | 创建参数注册 schema 与默认登记表 |
| 目标 | 定义 `evolution_parameters` 表（参数 ID、名称、owner、value、依据、版本、有效期、fail-closed 默认值、状态）；建立 P1–P10 默认登记表 |
| 依赖 | Phase 0a 已完成 |
| 并行组 | 可与 P1-T11~T13 并行 |
| Token 估算 | 设计 8k + 实现 15k + 测试 10k + 修复 8k = **约 50k** |
| 行数预算 | 约 300 行（含测试） |
| 文件范围 | `packages/agent-server/src/evolution/parameters.ts`（新建）、`test/evolution/parameters.test.ts` |
| TDD 测试 | 参数注册、读取、校验、默认值加载 |
| 负责人 | coder-D |
| 状态 | pending |

#### T11：P1–P10 参数登记与校验

| 字段 | 内容 |
|---|---|
| ID | P0b-T11 |
| 标题 | 登记 P1–P10 参数并实现校验器 |
| 目标 | 将 P1–P10 参数写入默认表；校验器检查 owner/依据/版本/有效期/默认值齐全 |
| 依赖 | T10 |
| 并行组 | 无（Phase 0b 内部串行） |
| Token 估算 | 设计 10k + 实现 20k + 测试 12k + 修复 8k = **约 60k** |
| 行数预算 | 约 400 行（含测试） |
| 文件范围 | `packages/agent-server/src/evolution/parameters.ts` 扩展、`test/evolution/parameters.test.ts` |
| TDD 测试 | 每个 P 项登记成功；缺失字段校验失败 |
| 负责人 | coder-D |
| 状态 | pending |

#### T12：Phase 0b 校验命令

| 字段 | 内容 |
|---|---|
| ID | P0b-T12 |
| 标题 | 创建 `verify-phase0b` 校验命令 |
| 目标 | CLI 命令检查所有 P 项已登记、无过期、fail-closed 默认值存在；输出 JSON 报告 |
| 依赖 | T11 |
| 并行组 | 可与 P1-T11~T13 并行 |
| Token 估算 | 设计 8k + 实现 15k + 测试 10k + 修复 6k = **约 47k** |
| 行数预算 | 约 200 行 |
| 文件范围 | `packages/agent-server/src/evolution/cli.ts` 扩展、`test/evolution/phase0b-verify.test.ts` |
| TDD 测试 | 全部参数登记后 exit 0；缺失参数 exit 1 |
| 负责人 | coder-D |
| 状态 | pending |

### Phase 1 任务组

#### T13：会话/任务与 scaffold/artifact/snapshot 关联

| 字段 | 内容 |
|---|---|
| ID | P1-T13 |
| 标题 | 扩展 session/task 记录，关联 scaffold/artifact/snapshot |
| 目标 | 在 `agent-session.ts` 或 `session-manager.ts` 中保存当前 `artifactId`、`scaffoldHash`、`snapshotSha` 到 session 元数据；不修改 agent-loop.ts |
| 依赖 | M2 T6b 已完成 |
| 并行组 | 可与 T14/T15/T16/T17 并行 |
| Token 估算 | 设计 12k + 实现 25k + 测试 18k + 修复 12k = **约 80k** |
| 行数预算 | 约 350 行（含测试） |
| 文件范围 | `packages/coding-agent/src/core/agent-session.ts` 扩展、`test/suite/evolution/` |
| TDD 测试 | session 启动后元数据包含三个字段；持久化可读取 |
| 负责人 | coder-E |
| 状态 | pending |

#### T14：结构化 tool event 采集

| 字段 | 内容 |
|---|---|
| ID | P1-T14 |
| 标题 | 实现结构化 tool event 采集器 |
| 目标 | 记录每次 tool call 的 tool name、args hash、result hash、duration、error；写入 evidence 域 |
| 依赖 | 无 |
| 并行组 | 可与 T13/T15/T16/T17 并行 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/coding-agent/src/core/evolution/tool-event-collector.ts`（新建）、test |
| TDD 测试 | tool call 产生结构化事件；args/result 哈希正确；error 记录 |
| 负责人 | coder-F |
| 状态 | pending |

#### T15：product manifest 采集

| 字段 | 内容 |
|---|---|
| ID | P1-T15 |
| 标题 | 实现 product manifest 采集器 |
| 目标 | 任务结束后收集产物文件列表、大小、SHA256；写入 evidence 域 |
| 依赖 | 无 |
| 并行组 | 可与 T13/T14/T16/T17 并行 |
| Token 估算 | 设计 8k + 实现 18k + 测试 12k + 修复 8k = **约 55k** |
| 行数预算 | 约 250 行 |
| 文件范围 | `packages/coding-agent/src/core/evolution/product-manifest-collector.ts`（新建）、test |
| TDD 测试 | 产物清单生成；哈希计算正确；空产物处理 |
| 负责人 | coder-F |
| 状态 | pending |

#### T16：grader outcome 与用户纠正采集

| 字段 | 内容 |
|---|---|
| ID | P1-T16 |
| 标题 | 实现 grader outcome 与 user correction 采集接口 |
| 目标 | 提供 `recordGraderOutcome(taskId, outcome)` 与 `recordUserCorrection(taskId, correction)` 接口；写入 evidence 域；字段级校验 |
| 依赖 | 无 |
| 并行组 | 可与 T13/T14/T15/T17 并行 |
| Token 估算 | 设计 10k + 实现 18k + 测试 14k + 修复 10k = **约 63k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/coding-agent/src/core/evolution/outcome-collector.ts`（新建）、test |
| TDD 测试 | outcome/correction 写入成功；缺字段拒绝 |
| 负责人 | coder-G |
| 状态 | pending |

#### T17：gateway escalation join key 采集

| 字段 | 内容 |
|---|---|
| ID | P1-T17 |
| 标题 | 实现 gateway escalation join key 采集 |
| 目标 | 从 gateway 响应中提取 escalation join key（gatewaySequence、qualitySignalsSha）；写入 evidence 域；与 T7 evidence-schema 对齐 |
| 依赖 | 无 |
| 并行组 | 可与 T13/T14/T15/T16 并行 |
| Token 估算 | 设计 8k + 实现 15k + 测试 12k + 修复 8k = **约 50k** |
| 行数预算 | 约 250 行 |
| 文件范围 | `packages/coding-agent/src/core/evolution/escalation-collector.ts`（新建）、test |
| TDD 测试 | join key 解析正确；格式错误拒绝 |
| 负责人 | coder-G |
| 状态 | pending |

#### T18：evidence artifact 构建器

| 字段 | 内容 |
|---|---|
| ID | P1-T18 |
| 标题 | 实现 evidence artifact 构建器 |
| 目标 | 聚合 tool event、product manifest、grader outcome、user correction、escalation join key 为单个 evidence artifact；支持 blob 存储；与 T3 artifact-registry 对接 |
| 依赖 | T13/T14/T15/T16/T17 |
| 并行组 | 无 |
| Token 估算 | 设计 15k + 实现 30k + 测试 20k + 修复 15k = **约 96k** |
| 行数预算 | 约 500 行 |
| 文件范围 | `packages/agent-server/src/evolution/evidence-artifact-builder.ts`（新建）、test |
| TDD 测试 | 聚合生成 artifact；字段完整；可存储可读取 |
| 负责人 | coder-E |
| 状态 | pending |

#### T19：失败 taxonomy 集成

| 字段 | 内容 |
|---|---|
| ID | P1-T19 |
| 标题 | 失败 taxonomy 集成与 unknown 桶 |
| 目标 | 将 T7 的 8 类 taxonomy 集成到 evidence 采集路径；提供 `classifyFailure(taskId, evidenceRefs)` 接口；unknown 桶支持 |
| 依赖 | T18 |
| 并行组 | 可与 T20 并行 |
| Token 估算 | 设计 10k + 实现 18k + 测试 12k + 修复 8k = **约 58k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/agent-server/src/evolution/failure-classifier.ts`（新建）、test |
| TDD 测试 | 分类正确；unknown 桶可用；taxonomy 枚举对齐 |
| 负责人 | coder-E |
| 状态 | pending |

#### T20：证据对账查询

| 字段 | 内容 |
|---|---|
| ID | P1-T20 |
| 标题 | 实现证据对账查询 |
| 目标 | 提供 `reconcileTask(taskId)` 查询：从 task → request → model run → session → artifacts → grader 完整对账；返回零孤儿记录报告 |
| 依赖 | T18/T19 |
| 并行组 | 可与 T19 并行 |
| Token 估算 | 设计 12k + 实现 22k + 测试 15k + 修复 10k = **约 71k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/reconciliation.ts`（新建）、test |
| TDD 测试 | 完整对账成功；孤儿记录检测 |
| 负责人 | coder-G |
| 状态 | pending |

#### T21：Phase 1 集成测试与验收

| 字段 | 内容 |
|---|---|
| ID | P1-T21 |
| 标题 | Phase 1 端到端集成测试 |
| 目标 | 随机抽样任务完整对账；零孤儿记录；与 Phase 0b 参数联动检查 |
| 依赖 | T12/T20 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 20k + 修复 12k = **约 83k** |
| 行数预算 | 约 400 行 |
| 文件范围 | `packages/agent-server/test/evolution/phase1-integration.test.ts` |
| TDD 测试 | 端到端对账；与 phase0b 校验联动 |
| 负责人 | coder-D |
| 状态 | pending |

## 5. 并行开发分组

| 波次 | 并行任务 | 说明 |
|---|---|---|
| 波次 1 | P0b-T10、P1-T13、P1-T14、P1-T15、P1-T16、P1-T17 | 纯模块开发，互不依赖 |
| 波次 2 | P0b-T11、P0b-T12、P1-T18 | T18 依赖波次 1 的采集器 |
| 波次 3 | P1-T19、P1-T20 | 依赖 T18 |
| 波次 4 | P1-T21 | 依赖全部 |

## 6. 汇报节奏

- 每任务完成：简短汇报（文件、行数、测试结果）
- 每里程碑：结构化汇报 + 自动进入下一阶段
- 异常/阻塞：立即汇报

## 7. 对抗式审查（自动）

每个里程碑后由 reviewer 子代理进行 critic-reviewer（≤5 轮）：
- 发现 blocker/warning → coder 修复后重审
- 通过 → 自动进入下一里程碑

## 8. 风险

- Phase 1 涉及 `agent-session.ts` 修改，需保持 agent-loop.ts 零改动
- Phase 0b 的 P1–P10 部分参数可能需要用户补充决策，但可先登记默认 fail-closed 值
- 行数与 token 超预算 50% 时自动拆分任务

## 9. 关联文档

- V3 设计：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md`
- Phase 0a 架构：`doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md`
- Phase 0a 任务书：`doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md`
- Phase 0a 完成记录：`doc/design/2026-08-28-phase0a-m2m3-completion-changes-and-decisions.md`
- 对抗审核：`doc/design/2026-08-28-self-evolving-engineering-design-adversarial-review.md`
