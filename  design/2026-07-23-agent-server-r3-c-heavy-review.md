# R3：C-重 Go/No-Go 评审 + 触发评审正式结论

日期：2026-07-23
任务书：` design/2026-07-23-agent-server-r-real-teacher-tasks.md` R3
数据基础：R1（` design/2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md`）、R2（` design/2026-07-23-agent-server-r2-mock-vs-real-evaluation.md`）

---

## 1. C-重 Go/No-Go 评审

### 结论：**No-Go**（C-轻通路在真实 teacher 下成立，不立项独立 LLM 提炼管线）

### 数据依据

C 决策 1 的观察项："Method/Guard 的每轮产量、质量分布；若产量不足再立项 C-重"。runbook 触发条件为"ABILITY 自然产量连续 4 周为 0"。R1 真实 teacher 数据提前回答了该观察项：

| 观察项 | 判定标准 | R1 实测 | 判定 |
|---|---|---|---|
| Method 每轮产量 | >0 即通路成立 | 单轮 4 张（5 个 session，无新输入） | 达标 |
| role 分布 | 不结构性偏 Workflow | 4 Method / 0 Workflow | 达标 |
| 质量分布 | 脱离 Mock 关键词档 | 0.7241/0.7311×3 | 达标（粒度粗，见观察项 2） |
| Guard 产量 | — | 0（两轮真实/Mock 均 0） | 不足，但不构成 C-重理由（见下） |

### 理由

1. 此前"ABILITY 产量偏低"的证据全部来自 MockLLM 路径；R2 已证实偏倚是关键词门控的产物而非 C-轻通路的产物。真实 teacher 下 C-轻通路单轮产量健康，新建独立提炼管线（C-重）与现有 verification_selection 能力重叠的判断（C 决策 1 原始理由）继续成立。
2. Guard 两轮产量为 0 的真实原因是**数据面**：现有 5 个 session 不含"必须避免的失败模式"类轨迹，且 C 决策 3 明确 Guard 只来自验证通过 cards 的 boundary、不从失败轨迹反推。这是观察项而非管线缺陷；C-重管线在同样数据面下也无法产出 Guard。
3. 零新 LLM 调用的 C-轻通路成本优势真实存在（R2 §2.2：主要成本在 verification 派生，独立管线只会增加调用）。

### 重启条件（写入 runbook 观察项）

- 真实 teacher 下 ABILITY 自然产量连续 4 周为 0（原触发条件维持）；
- 或 quality 聚集（观察项 2）被证实导致注入端无法区分优劣（截断/排序失效）。

## 2. 触发评审正式结论（R2 §3 两项）

| # | 触发条件 | 正式结论 | 动作 |
|---|---|---|---|
| 1 | Method/Guard 库存合计 ≥6（实际 7） | 截断发生，被截的是 0.6528 Mock 时代 retry Method（与 0.7241 真实版同源），**不可惜；上限 5 维持**，不引入衰减 | runbook 观察继续：被截条目 quality 上升时再评审 |
| 2 | 并存行 proxy >0（实际 3） | 语义为"同轨迹不同 role"（Mock Workflow + 真实 Method 各一张），**非 C 已知限制的重复晋升，不立项清理** | runbook §3 动作表已补判读规则（本次修订） |

## 3. runbook 修订（本次一并完成）

` design/2026-07-23-agent-server-observation-runbook.md` §3 动作表两处修订：

1. 并存行行：补判读规则——命中后先查 type/role 组合，"同 taskId 不同 role"为非重复（多 teacher 时代常态），仅"同 role 同内容跨 type"才是 C 已知限制的重复晋升。
2. 新增 metric 判读规则（R2 §1.6）：`etlInserted=0 且 metric>0` 为健康（重派生有新产出）；`etlInserted>0 且 metric=0` 才是异常。

## 4. 观察项移交（R 里程碑产生，进 runbook/基线）

1. 增量派生：session 数 ~50 前立项（R2 §2.2）。
2. verifier 文本回退区分度粗（0.724-0.731 聚集）：若 omlx 未来支持 logprobs，回退通路可切回期望化打分。
3. rescore 规模化风险：dormant 积压时先治理超时再放量（R1 决策 1）。
4. Guard 产量为 0：数据面问题，随真实 session 积累观察。

## 5. R 里程碑收口结论

- R1 通过、R2 通过、R3 No-Go 有据。R 里程碑 agent 侧全部完成。
- 遗留用户动作：plist 切换真实 teacher（R2 §2.1）；N2 metric>0 手工验证、N3 安装（Post-C 遗留，与本里程碑独立）。
- C 决策 1 观察项状态：**已评审关闭（C-轻成立，重启条件明确）**；其余 4 项 C 决策维持暂定观察。

Refer Spec：` design/2026-07-23-agent-server-r-real-teacher-tasks.md`（R3）；` design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`（决策 1）；` design/2026-07-23-agent-server-r2-mock-vs-real-evaluation.md`（数据与触发评审）；` design/2026-07-23-agent-server-observation-runbook.md`（触发条件与本次修订）
