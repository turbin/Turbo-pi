# PM 编排计划：Phase 0a M2/M3 任务分解与多 Agent 协同

## 1. 目标与范围

将 Phase 0a 剩余工作（M2 T6b agent-session 版本契约注入、M3 T8 跨实现契约套件 + T9 gen0 重建集成）拆分为可并行开发、可度量、可审查的开发任务。

每个任务：
- 估算 token 成本（设计 + 实现 + 测试 + 修复）
- 单次代码提交行数控制在 **< 3000 行**
- 采用 TDD 流程
- 指派 coder 子代理实现
- 在里程碑节点由 reviewer 子代理与 coder 进行迭代式 critic-reviewer（最多 5 轮）

## 2. 角色与流程

```
PM（根 agent）
├── 维护本计划、进度表、里程碑检查点
├── 定时向用户汇报
├── 派发任务给 coder
└── 组织 reviewer 做里程碑审查

coder × N
├── 按 TDD 写测试 → 实现 → 跑测试 → 修复
├── 每任务产出：代码 + 测试 + 变更说明
└── 提交前自审（行数、token、风格）

reviewer × 1（ per 里程碑）
├── 检查功能、测试覆盖、架构一致性、行数、token 使用
├── 与 coder 迭代 critic-reviewer（≤ 5 轮）
└── 产出审查报告
```

## 3. 任务分解模板

每个任务卡片包含：

| 字段 | 说明 |
|---|---|
| ID | 如 `M2-T6b-1` |
| 标题 | 一句话描述 |
| 目标 | 完成标准（可验证） |
| 依赖 | 前置任务或文件 |
| 并行组 | 可与哪些任务同时做 |
| Token 估算 | 设计/实现/测试/修复/审查分项 |
| 行数预算 | 预计新增/修改行数，必须 < 3000 |
| 文件范围 | 主要改动的文件 |
| TDD 测试 | 需新增的测试文件或测试用例 |
| 负责人 | coder 子代理标识 |
| 状态 | pending / in_progress / review / done |

## 4. Token 成本估算方法

以子代理与模型交互的往返量估算：

- **设计**：读取相关文件 + 写计划/伪代码，约 5k–15k tokens
- **实现**：编码 + 自修正，约 10k–40k tokens
- **测试**：写测试 + 调试到绿，约 5k–20k tokens
- **修复**：处理 reviewer 反馈，约 3k–10k tokens/轮
- **审查**： reviewer 读代码 + 写报告，约 5k–15k tokens

任务总估算 = 以上之和 × 1.2 缓冲系数。

## 5. 行数控制规则

- 单次 commit 新增 + 修改行数（不含测试数据文件、生成的 lockfile）**< 3000 行**
- 超过时拆分为子任务
- 必须保留中间演进记录，避免一次性大 diff
- 提交信息遵循 `COMPLETED：... / TODO：... / Refer Spec：...` 格式

## 6. 里程碑与检查点

> 2026-08-28 更新：用户要求取消人工确认节点，里程碑审查通过后**自动推进**。仅当 reviewer 发现 blocker 或 coder 修复无法达成一致时才升级用户。

### 里程碑 S1：M2/M3 任务分解与依赖确认
- 检查点：用户确认任务拆分、token/行数预算、里程碑顺序
- 输出：经用户批准的本计划
- **状态**：已完成

### 里程碑 S2：M2 T6b 实现完成
- 检查点：T6b 所有测试通过、biome/tsgo 零错误、agent-loop.ts 零改动
- Reviewer 完成 ≤5 轮对抗式 critic-reviewer
- 输出：T6b 审查报告
- **状态**：已完成（1 轮通过）

### 里程碑 S3：M3 T8 实现完成
- 检查点：T8 契约套件全绿、静态扫描通过
- Reviewer 完成 ≤5 轮对抗式 critic-reviewer
- 输出：T8 审查报告
- **状态**：已完成（1 轮通过）

### 里程碑 S4：M3 T9 实现完成
- 检查点：T9 gen0-rebuild 命令可用、集成测试绿、对账报告字段完整
- Reviewer 完成 ≤5 轮对抗式 critic-reviewer
- 输出：T9 审查报告
- **状态**：已完成（2 轮通过，round 1 发现 4 个问题并修复）

### 里程碑 S5：Phase 0a M2/M3 汇总
- 检查点：用户确认 M2+M3 整体可进入下一阶段
- 输出：阶段总结报告 + 更新 `doc/design/progress/`
- **状态**：已完成（用户批准，自动进入下一阶段）

## 7. 汇报节奏

- 每完成一个任务：即时简短汇报（1–2 句）
- 每到达一个里程碑：结构化汇报（进度、阻塞、下一步、需用户决策项）
- 每 30 分钟（若任务未结束）：发送进度心跳

## 8. TDD 流程（coder）

1. 红：根据契约/需求写失败测试
2. 绿：写最小程序使测试通过
3. 重构：在不改变行为的前提下优化
4. 运行相关测试：`./test.sh` 或包级 vitest
5. 运行检查：`npm run check`（若范围允许）
6. 提交（行数 < 3000）

## 9. 对抗式 Critic-Reviewer 流程（≤ 5 轮）

每轮 reviewer 必须以“找到代码必须修复的问题”为立场进行对抗式审查，不得因测试通过就轻易放行。重点攻击方向：

- **fail-closed 绕过**：任何错误路径是否静默降级、返回默认值或继续执行
- **并发/资源**：句柄泄漏、竞态、重复关闭、子进程残留
- **状态机非法路径**：是否所有非法转换都被拒绝，是否有隐藏跳转
- **数据完整性**：canonical hash、签名、seq、previous_event_id 是否可被篡改通过
- **边界条件**：空输入、超大输入、部分 env 变量、缺失文件
- **架构约束**：冻结面是否被触碰、agent-loop.ts 是否零改动、是否有非法跨包导入
- **测试质量**：测试是否真正验证了断言，还是只验证了“没抛错”

流程：
1. reviewer 读代码、测试、文档
2. 列出问题：功能缺陷、测试缺口、架构偏离、风格违规、token/行数超标
3. coder 针对每条问题修复或给出明确不修复理由
4. 重跑测试验证
5. reviewer 判断是否通过；未通过则进入下一轮

最多 5 轮；若 5 轮后仍未通过，PM 升级给用户决策。

> 历史结果：S2/S3 1 轮通过；S4 因 reviewer 发现 call-order、确定性、资源泄漏、退出码 4 个问题，round 2 通过。

---

## 10. M2/M3 详细任务清单

> 状态表同步维护于 `doc/design/progress/2026-08-28-phase0a-progress.md`。

### M2 任务组

#### M2-T6b-1：创建版本契约读取模块

| 字段 | 内容 |
|---|---|
| ID | M2-T6b-1 |
| 标题 | 创建 `version-contract.ts` 读取模块 |
| 目标 | 实现从环境/配置读取 gen0 版本契约（`artifactId`、`scaffoldHash`、`snapshotSha`），提供默认值与校验；不依赖网络或 LLM |
| 依赖 | 无（M1 T6a 已完成） |
| 并行组 | 可与 M3-T8-1 并行 |
| Token 估算 | 设计 8k + 实现 15k + 测试 12k + 修复 8k = **约 43k** |
| 行数预算 | 约 250 行 |
| 文件范围 | `packages/coding-agent/src/core/evolution/version-contract.ts`（新建） |
| TDD 测试 | `packages/coding-agent/test/suite/evolution/version-contract.test.ts`：缺失字段返回默认值、非法字段拒绝、完整字段解析正确 |
| 负责人 | coder-A |
| 状态 | pending |

#### M2-T6b-2：agent-session 注入挂载点

| 字段 | 内容 |
|---|---|
| ID | M2-T6b-2 |
| 标题 | agent-session 最小侵入式注入点 |
| 目标 | 在 `agent-session.ts` 3–5 处挂载版本契约：启动时读取、注入到上下文对象、会话关闭/结束时触发 resolved manifest 记录；**不改动 `agent-loop.ts`** |
| 依赖 | M2-T6b-1 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 25k + 测试 20k + 修复 12k = **约 85k**（大文件 diff 成本高） |
| 行数预算 | 约 150 行（agent-session.ts diff） |
| 文件范围 | `packages/coding-agent/src/core/agent-session.ts` |
| TDD 测试 | 复用 M2-T6b-1 测试文件，补充：启动后会话上下文携带三个字段；关闭时调用记录钩子 |
| 负责人 | coder-A |
| 状态 | pending |

#### M2-T6b-3：会话结束 resolved manifest 记录器

| 字段 | 内容 |
|---|---|
| ID | M2-T6b-3 |
| 标题 | 实现 resolved manifest 记录器 |
| 目标 | 会话结束时收集 actual_provider_model、env 快照、artifactId、slot，写入持久化；缺必填字段时 fail-closed 拒写而非填 null |
| 依赖 | M2-T6b-2 |
| 并行组 | 无 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 300 行（含测试） |
| 文件范围 | `packages/coding-agent/src/core/evolution/version-contract.ts` 扩展；测试文件扩展 |
| TDD 测试 | 同测试文件：完整字段写入成功；缺字段抛错；幂等或重复调用行为确定 |
| 负责人 | coder-A |
| 状态 | pending |

**M2 合计**：约 700 行，Token 约 **194k**，轮次约 4 轮。

### M3 任务组

#### M3-T8-1：契约套件测试辅助与静态扫描框架

| 字段 | 内容 |
|---|---|
| ID | M3-T8-1 |
| 标题 | T8 契约套件辅助函数与静态扫描框架 |
| 目标 | 提供第二把签名密钥生成、journal 状态注入、seq gap 构造、静态 import 扫描、agent-loop diff 断言等辅助；不触碰冻结面 |
| 依赖 | 无 |
| 并行组 | 可与 M2-T6b-1 并行 |
| Token 估算 | 设计 10k + 实现 20k + 测试 10k + 修复 8k = **约 58k** |
| 行数预算 | 约 400 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-helpers.ts`（新建） |
| TDD 测试 | 辅助函数自身测试（key 生成、扫描结果正确） |
| 负责人 | coder-B |
| 状态 | pending |

#### M3-T8-2：consistency 子套件

| 字段 | 内容 |
|---|---|
| ID | M3-T8-2 |
| 标题 | canonical/hash 一致性子套件 |
| 目标 | 验证 `packages/agent-server/src/evolution/canonical.ts`（T2）与 `packages/evaluation-kernel/src/canonical.ts`（T4）对同一 manifest 产生相同 `artifact_id`；含 kernel strip-signature 场景 |
| 依赖 | M3-T8-1 |
| 并行组 | 可与 M3-T8-3/4/5/6 并行（共享同一 test 文件，需协调合并） |
| Token 估算 | 设计 8k + 实现 15k + 测试 12k + 修复 6k = **约 49k** |
| 行数预算 | 约 200 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-suite.test.ts`（新增 describe 块） |
| TDD 测试 | `contract-suite.test.ts` 内 `describe("consistency")` |
| 负责人 | coder-B |
| 状态 | pending |

#### M3-T8-3：signature 子套件

| 字段 | 内容 |
|---|---|
| ID | M3-T8-3 |
| 标题 | 签名/认证子套件 |
| 目标 | 验证：伪造 attestation 拒绝、payload 篡改拒绝、错误 key_id 拒绝、TEK 本地 chain_mode 为 `local_diagnostic` |
| 依赖 | M3-T8-1 |
| 并行组 | 可与 M3-T8-2/4/5/6 并行 |
| Token 估算 | 设计 10k + 实现 20k + 测试 15k + 修复 10k = **约 66k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-suite.test.ts`（新增 describe 块） |
| TDD 测试 | `contract-suite.test.ts` 内 `describe("signature")` |
| 负责人 | coder-B |
| 状态 | pending |

#### M3-T8-4：chain 子套件

| 字段 | 内容 |
|---|---|
| ID | M3-T8-4 |
| 标题 | 事件链 fail-closed 子套件 |
| 目标 | 验证：seq gap 导致 slot 状态 unknown；`previous_event_id` 不匹配拒绝；重复 seq 拒绝；无 shadow 直接 active 拒绝 |
| 依赖 | M3-T8-1 |
| 并行组 | 可与 M3-T8-2/3/5/6 并行 |
| Token 估算 | 设计 8k + 实现 18k + 测试 14k + 修复 8k = **约 58k** |
| 行数预算 | 约 300 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-suite.test.ts`（新增 describe 块） |
| TDD 测试 | `contract-suite.test.ts` 内 `describe("chain")` |
| 负责人 | coder-B |
| 状态 | pending |

#### M3-T8-5：crash 子套件

| 字段 | 内容 |
|---|---|
| ID | M3-T8-5 |
| 标题 | journal 崩溃恢复子套件 |
| 目标 | 验证：`state='written'` journal 行在 replay 时不视为 committed；committed 行幂等 |
| 依赖 | M3-T8-1 |
| 并行组 | 可与 M3-T8-2/3/4/6 并行 |
| Token 估算 | 设计 6k + 实现 12k + 测试 10k + 修复 6k = **约 40k** |
| 行数预算 | 约 150 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-suite.test.ts`（新增 describe 块） |
| TDD 测试 | `contract-suite.test.ts` 内 `describe("crash")` |
| 负责人 | coder-B |
| 状态 | pending |

#### M3-T8-6：permission 子套件

| 字段 | 内容 |
|---|---|
| ID | M3-T8-6 |
| 标题 | M0 只读面与权限子套件 |
| 目标 | 验证：M0 路径写入意图被拒绝；`promotion-controller.ts` 不导入 evaluation-kernel 内部；`agent-loop.ts` diff 为空；报告路径携带 `chain_mode=local_diagnostic` |
| 依赖 | M3-T8-1 |
| 并行组 | 可与 M3-T8-2/3/4/5 并行 |
| Token 估算 | 设计 8k + 实现 15k + 测试 12k + 修复 6k = **约 49k** |
| 行数预算 | 约 250 行 |
| 文件范围 | `packages/agent-server/test/evolution/contract-suite.test.ts`（新增 describe 块） |
| TDD 测试 | `contract-suite.test.ts` 内 `describe("permission")` |
| 负责人 | coder-B |
| 状态 | pending |

**M3-T8 合计**：约 1600 行，Token 约 **320k**（超出任务书 1500 行预算 100 行；由辅助文件拆分控制，仍 < 3000）。

#### M3-T9-1：T5 gen0 首事件类型决策与 CLI 骨架

| 字段 | 内容 |
|---|---|
| ID | M3-T9-1 |
| 标题 | 决策 gen0 首事件类型并搭建 CLI 骨架 |
| 目标 | 解决架构 §4 `active` 首事件与 T5 `shadow` 首事件的冲突；搭建 `packages/agent-server/src/evolution/cli.ts` 非交互脚本骨架；退出码规范 |
| 依赖 | 需用户/架构师决策（阻塞 T9-2） |
| 并行组 | 可与 M3-T8 并行 |
| Token 估算 | 设计 8k + 实现 10k + 测试 5k = **约 28k** |
| 行数预算 | 约 150 行 |
| 文件范围 | `packages/agent-server/src/evolution/cli.ts`（新建） |
| TDD 测试 | CLI 参数解析测试 |
| 负责人 | coder-C |
| 状态 | pending |

#### M3-T9-2：gen0-rebuild 命令实现

| 字段 | 内容 |
|---|---|
| ID | M3-T9-2 |
| 标题 | 实现 gen0-rebuild 完整命令 |
| 目标 | 调用 fingerprint 收集 → pinTaskContract → buildGenerationZeroBundle → storeArtifact → signAttestation → appendAttestation → emitDeploymentEvent → resolveSlot → recordResolvedManifest → reconcileSlot → 打印 JSON 对账报告 |
| 依赖 | M3-T9-1 |
| 并行组 | 无 |
| Token 估算 | 设计 12k + 实现 30k + 测试 20k + 修复 12k = **约 92k** |
| 行数预算 | 约 350 行 |
| 文件范围 | `packages/agent-server/src/evolution/cli.ts` |
| TDD 测试 | `packages/agent-server/test/evolution/gen0-rebuild.integration.test.ts` |
| 负责人 | coder-C |
| 状态 | pending |

#### M3-T9-3：gen0-rebuild 集成测试

| 字段 | 内容 |
|---|---|
| ID | M3-T9-3 |
| 标题 | gen0-rebuild 集成测试与边界用例 |
| 目标 | 验证：一条命令产出可加载 gen0 bundle；对账报告字段完整；字段缺失/不一致时非零退出并标记；重跑幂等/确定性；无 LLM/网络调用 |
| 依赖 | M3-T9-2 |
| 并行组 | 无 |
| Token 估算 | 设计 10k + 实现 20k + 测试 18k + 修复 10k = **约 70k** |
| 行数预算 | 约 250 行 |
| 文件范围 | `packages/agent-server/test/evolution/gen0-rebuild.integration.test.ts`（新建） |
| TDD 测试 | 自身即为 TDD 入口 |
| 负责人 | coder-C |
| 状态 | pending |

**M3-T9 合计**：约 750 行，Token 约 **190k**。

---

## 11. 并行开发分组

| 波次 | 并行任务 | 说明 |
|---|---|---|
| 波次 1 | M2-T6b-1、M3-T8-1 | 都新建辅助模块，互不依赖 |
| 波次 2 | M2-T6b-2、M3-T8-2~6、M3-T9-1 | T6b-2 依赖 T6b-1；T8 子套件依赖 T8-1；T9-1 需决策 |
| 波次 3 | M2-T6b-3、M3-T9-2 | T6b-3 依赖 T6b-2；T9-2 依赖 T9-1 |
| 波次 4 | M3-T9-3 | 依赖 T9-2 |

**关键路径**：M2-T6b-1 → T6b-2 → T6b-3；M3-T8-1 → T8-2~6；M3-T9-1 → T9-2 → T9-3。
T8 与 T9 可大部分并行；T6b 串行。

## 12. 风险与升级条件

- 任一任务实际 token 超过估算 50%：PM 立即汇报并申请调整
- 任一代码 diff 接近 3000 行：必须拆任务
- critic-reviewer 5 轮未通过：升级用户决策
- T9-1 的 T5 首事件类型冲突：需架构师/用户在 S1 或 S3 前裁决
- 09:00–12:00 / 14:00–18:00 不启动新的 pi agent 会话

## 13. 关联文档

- `doc/design/INDEX.md`
- `doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md`
- `doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md`
- `doc/design/progress/2026-08-28-phase0a-progress.md`
- `doc/design/progress/2026-08-28-existing-modules-survey.md`
- `AGENTS.md`
