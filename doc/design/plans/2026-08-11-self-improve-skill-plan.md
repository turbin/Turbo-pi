# self-improve 回路方案：支架自改的 skill + extension 两层设计

- 日期：2026-08-11
- 状态：**待用户评审**；实施时间在评审通过、且结合实验完成情况后安排
- 上游依据：
  - SIA 论文（arXiv:2605.27276）Feedback-Agent 闭环（执行 → 分析 → 改进）与译文对比分析（2026-08-11 会话）
  - 姊妹方案（数据层）：`plans/2026-08-11-experience-schema-evolution-plan.md`（经验库溯源三字段；本方案的 `markStaleByScaffoldHash` 触发依赖其 T3）
  - `plans/2026-07-31-agent-self-evolution-roadmap.md`（已批准路线图，本方案属 R3 "harness 自进化（人工审批门）"范畴）
  - 通用约束：`doc/design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"一节

---

## 1. 定位与动机

pi 的支架（skills/extensions/prompts/settings）已具备运行时可改性（agent 写文件 + `/reload` / `ctx.reload()` 热生效），但缺少 SIA 意义上的闭环：没有一个"观察自己的轨迹 → 诊断 → 小步改支架 → 验证 → 生效"的协议。本方案把它落成两层：

- **Skill（策略层）**：教 agent *何时*反思、*改什么*、*怎么验证*——是"规矩与习惯"，与经验库（存"知识"）互补：skill 反思的产出最终仍进经验库。
- **Extension（机制层）**：提供 reflect 工具、验证闸、reload、审计日志——skill 只是提示词层说明，无法注册工具与钩子，机制必须由 extension 承载。

反思模型的选择（2026-08-11 会话结论）：**快环自反思 + 慢环 teacher** 分层。session 内即时小改由 agent 自指完成（零额外调用、上下文保真）；自改 2~3 次仍复发同类错误时升级 teacher 模型（经 agent-gateway 学生-老师链路）。v1 只做自反思，teacher 升级留作后续。

## 2. 总体结构

```
.pi/
├── extensions/self-improve/     # 机制层（S2 阶段交付）
│   └── index.ts
├── skills/self-improve/         # 策略层（S1 阶段交付）
│   └── SKILL.md
└── evolution-log/               # 审计层：每次自改一条记录
    └── <date>-<slug>.md         # 同时是 agent-server 离线慢环的 ETL 输入
```

## 3. S1：Skill（策略层）`.pi/skills/self-improve/SKILL.md`

先行落地，不依赖 schema 方案与 extension——agent 用现有写文件 + `/reload` 能力即可执行，只是缺少机制保障。

```markdown
---
name: self-improve
description: 任务结束后反思轨迹并改进自身支架（skills/extensions/prompts）。
  当用户多次纠正同一问题、工具反复失败、或发现可复用模式时使用。
---

# 触发信号（满足任一）
- 用户在同一 session 纠正同类问题 ≥2 次
- 某工具调用失败率异常、同一错误重试 ≥3 次
- 完成了一类新任务，流程值得固化

# 改进优先级（小步单点，每次只改一处）
1. 更新/新建 skill（最常见：把本次验证过的流程写成 SKILL.md）
2. 调整 prompt 片段
3. 改 extension（仅在需要新机制时）

# 协议
1. 回顾本次 session 轨迹，定位失败/纠正点（S2 后改为调用 reflect 工具）
2. 定位最小改动点，说明动机
3. 改动 → 运行验证 → 全部通过后 /reload
4. 写 evolution-log 条目

# 禁区
- 不修改验证器、回归测试、AGENTS.md
- 不为通过验证而降低检查标准
- 不做无轨迹证据支撑的"预防性"改动
```

## 4. S2：Extension（机制层）`.pi/extensions/self-improve/index.ts`

基于现有 extension API（`registerTool()`、`ctx.reload()`、`tool_result` 钩子）：

1. **`reflect` 工具**：agent 调用后，extension 从 session JSONL 提取本次任务的轨迹诊断（用户纠正点、工具失败聚类、重复尝试位置）+ 当前支架快照（skills/extensions/settings 文件清单 + contentHash），作为 tool_result 返回。v1 自反思；后续版本可经 agent-gateway 调 teacher 模型做外部分析（升级信号：同一问题自改 ≥2 次仍复发）。
2. **验证闸**：`tool_result` 钩子检测到 `.pi/skills|extensions` 被写时，追加提示"先验证再 reload"；验证 = jiti 加载检查 + 受影响最小测试集（改 `packages/*` 时才触发 `npm run check`，而本方案禁区本就排除 packages 改动）；失败时提供仅针对本次改动文件的 git 恢复（遵守仓库 git 纪律：只动自己改过的文件）。
3. **reload**：验证通过后 `ctx.reload()` 热生效。
4. **evolution-log**：每次自改写一条记录（动机、轨迹证据、diff 文件清单、验证结果、当前 scaffoldHash——schema 方案 T2 后可用），供审计与 agent-server ETL 消费。
5. **安全预算**：每 session 自改次数上限（防振荡）；denylist：`AGENTS.md`、验证逻辑自身、`doc/issues-snapshot/` 回归测试、`packages/*` 核心代码——**验证器不可被被优化者修改**（SIA §8 古德哈特教训的硬约束）。

## 5. 与现有栈的关系

```
在线快环（本方案）              离线慢环（已有 agent-server）
session 内即时小改               跨 session 批处理提炼/门控/注入
     │                                ▲
     └────── evolution-log ───────────┘
支架变更后 ──→ markStaleByScaffoldHash（schema 方案 T3 提供）
            触发时机服从 roadmap R3 人工审批门，不自动执行
```

## 6. 与 SIA 的对应

| SIA | 本方案 |
|---|---|
| 执行 A_g | 正常任务执行 |
| 轨迹 τ_g | session JSONL + reflect 工具诊断摘要 |
| Feedback-Agent 分析 | agent 按 SKILL.md 协议自指反思（后续可升级 teacher） |
| A_{g+1} | 改动后的 skills/extensions，`ctx.reload()` 热生效 |
| verifier V | jiti 加载检查 + 最小测试集 + `npm run check`（条件触发） |
| 防 Goodhart | denylist + 验证器不可改 + evolution-log 可审计 |

## 7. 分阶段交付

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| S1 | 仅 SKILL.md（策略先行） | 无 | 零——纯提示词层，可随时撤销 |
| S2 | extension 机制层（reflect 工具、验证闸、reload、evolution-log、安全预算） | S1 试用反馈；建议与 schema 方案 T2（scaffoldHash）之后 | 中——自改机制本身需人工观察期 |

**排期说明**：S1 可在评审通过后立即实施；S2 按用户指示，结合实验完成情况与 schema 方案排期一并安排。S2 落地后应设人工观察期（对照 roadmap R3 人工审批门）。

## 8. 不做的事（范围护栏）

- 不做权重更新/微调（roadmap 四约束之一）。
- v1 不接 teacher 模型（自反思先行，teacher 升级为后续版本）。
- 不改 agent-server 检索/注入行为；不自动触发 stale 复核。
- 不做跨 session 自动学习（那是离线慢环已有职责，本方案只产出 evolution-log 作为其输入）。
- 不动 omlx、不动 Python gateway 包、不动 `packages/*` 核心代码。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 无约束自改导致支架劣化 | S1 阶段改动全部经用户可见的 `/reload` 与 git diff；S2 加次数上限与 denylist；roadmap R3 人工审批门兜底 |
| 自指反思缺乏旁观者视角 | 已接受为 v1 取舍；复发 ≥2 次升级 teacher 的接口预留 |
| 验证闸流于形式（agent 跳过验证） | S2 由 extension 钩子强制提示 + 失败自动回滚；SKILL.md 禁区明示不得降低检查标准 |
| evolution-log 无人消费 | 与 schema 方案 scaffoldHash 对齐后，离线慢环 ETL 直接消费，形成闭环 |
