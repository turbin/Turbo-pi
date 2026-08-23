# D1 全部任务云升级为 0：门控有效性诊断报告

日期：2026-08-21  
状态：**诊断完成；D 阶段线上门控改造 deferred，D1-D7 期间只允许 shadow/反事实审计**  
范围：D 阶段 9B QCB D1（`campaign-20260819`）  
依据：`doc/design/preview.html`、`doc/design/2026-08-19-9b-campaign-experiment-design.md`、
`packages/agent-server/eval/campaign_metrics.py`、gateway `model_runs` 真值表

## 1. 结论

**D1 的云升级确实为 0，不是 `run.jsonl` 标注丢失；但这暴露了高严重度的构念有效性问题。**

当前门控只识别单次模型响应的协议级故障，不能识别任务级循环、无进展、错误计划、工具执行失败或交付物未完成。因此：

- `0%` 只能解释为“可观察协议级升级率为 0%”；
- 不能解释为“教师需求率为 0%”或“9B 已实现自主完成”；
- 判据①②必须与 AutonomousSuccessRate、MissedEscalationRate 联合报告，禁止单独据此宣告自主性达标。

D1 预注册 addendum 口径识别出 23 个明显失败任务，23 个全部未升级：

```text
MissedEscalationRate = 23 / 23 = 100%
```

这不是 gateway 路由故障的直接证据，而是现有门控对任务级失败召回率为 0 的证据。

## 2. 数据范围与指标定义

### 2.1 数据范围

| 数据源 | 粒度 | D1 范围 | 用途 |
|---|---:|---:|---|
| `eval/results/campaign-20260819/run.jsonl` | task | 52 行 | 任务得分、终止原因、升级标记 |
| gateway `request_executions` | request/trace | 1,369 个唯一 trace | trace 覆盖与请求状态 |
| gateway `model_runs` | model run | 1,369 个 primary run | provider、purpose、quality signals、升级真值 |
| `quality.py` | code contract | 4 类门控 | 判定门控可观测边界 |

时间窗口：gateway UTC `2026-08-19 06:54:20` 至 `2026-08-20 13:02:43`，由 D1 trace_id 集合限定，不使用共享 DB 的模糊自然日窗口。

### 2.2 预注册口径

- AutonomousSuccess：`score >= 0.5 ∧ escalated=false`。
- ObviousFailure：`score < 0.3`，或 `grading_error`，或
  `termination_reason=max_turns ∧ score < 0.5`。
- MissedEscalationRate：明显失败且未升级的任务数 / 明显失败任务数。
- 升级真值：gateway `model_runs.purpose='escalation'`，不以 campaign 单侧字段自证。

## 3. 三层证据对账

| 检查项 | 结果 | 判读 |
|---|---:|---|
| campaign 升级字段完整性 | 52/52 均存在且为 `false` | 无缺字段默认值假绿 |
| D1 trace_id 唯一性 | 1,369/1,369，无重复 | 请求集合可完整对账 |
| gateway execution 覆盖 | 1,369/1,369 | 无 trace 遗失 |
| gateway primary 覆盖 | 1,369/1,369，`omlx/succeeded` | 全部请求确由本地 9B 服务 |
| gateway escalation run | 0 | 真实未调用云端升级腿 |
| primary finish_reason | `tool_calls=1,347`、`stop=22` | 无 `length` |
| 明显失败漏升级 | 23/23 | 门控未捕捉任务级明显失败 |

以上证据排除了 issue-004/015 同类的“客户端标记断裂”解释。gateway 表是升级事实的 owner，且本次 D1 trace 覆盖率为 100%。

## 4. 任务结果与门控结果背离

52 个任务的互斥分类：

| 分类 | 任务数 | 占比 |
|---|---:|---:|
| 自主成功 | 22 | 42.3% |
| 明显失败且未升级 | 23 | 44.2% |
| 其他未通过且未升级 | 7 | 13.5% |
| 发生云升级 | 0 | 0% |

实验臂单独看：

- 重复任务通过率：8/20 = 40%；
- 新任务通过率：3/12 = 25%；
- 实验臂总体通过率：11/32 = 34.4%；
- 实验臂升级率：0%。

因此，升级率与任务成功之间没有形成预期的互补关系：失败没有进入教师腿，自主成功率也不足以解释“无需升级”。

## 5. 根因

`agent_gateway.quality.evaluate_quality()` 当前只观察四类单请求信号：

1. 工具调用结构或参数 schema 非法；
2. `finish_reason=length`；
3. content 与 tool_calls 同时为空；
4. 请求强制指定工具但模型未调用。

D1 中 98.4% 请求以格式合法的 `tool_calls` 结束。只要 9B 能持续生成合法 bash 调用，即使它重复命令、选错文件、没有推进任务或最终耗尽 30 回合，每一轮仍会被门控判为合格。

当前门控没有以下任务级信息：

- judge/functional score；
- 工具调用是否成功；
- 是否反复进入近似状态；
- 是否连续若干回合没有新增交付物或状态推进；
- 是否接近 `MAX_TURNS`；
- 关键 deliverables 是否存在。

所以本次 `0%` 是现行门控定义的自然结果，不是反常的数据库现象。

## 6. 影响分级

### 6.1 已验证影响

- **高：自主性结论失真。** 判据①②单独使用会结构性易绿。
- **高：教师闭环未被触发。** 23 个明显失败没有产生云教师修复轨迹。
- **中：成本指标失去解释力。** 云成本为 0 是门控不召回与模型独立性的混合结果。
- **中：北极星“升级率下降”不可单独比较。** 不同模型的协议输出形态会改变升级率，但不等于任务能力变化。

### 6.2 尚未验证

尚未对 23 个明显失败做教师反事实重放，因此不能断言其中多少任务可被 DeepSeek/Oracle Plan 挽救。这个比例决定任务级门控漏召回的实际收益损失。

## 7. D 阵段处置裁决

### 7.1 D1-D7 期间保持线上门控不变

原因：D1 已按当前口径起跑；中途改变路由门控会同时改变模型、成本、轨迹和进化输入，破坏 D1-D7 跨日可比性与预注册实验完整性。

### 7.2 立即修改解释口径

- 所有日报/阶段报告把原“升级率”写为“协议级升级率”；
- 必须同报 AutonomousSuccessRate、MissedEscalationRate、明显失败数；
- D2 可以继续承担四臂零差校准，但不得以升级率 0% 宣布自主性达标；
- D7 最终结论必须把本报告列为判据①②的解释限制。

### 7.3 允许的 D 阶段工作

只允许不改变路由结果的诊断：

1. D2 后从明显失败中确定性抽样 5-10 个任务；
2. 执行既有 T8 Oracle Teacher Plan / Teacher Direct Solve 反事实诊断；
3. 离线计算教师挽救率、RetrievalLoss、ExecutionGap；
4. 以 shadow-only 方式计算循环、无进展、工具失败、接近回合上限信号；
5. 不把 shadow 结果写回 D1-D7 路由或 evolution eligibility。

### 7.4 延后到 D 阶段收口后的工作

- 修改 gateway 在线门控；
- 新增任务级升级状态机；
- 调整云升级预算或触发阈值；
- 用新门控重新解释 D1-D7 的升级率；
- 正式接入下列候选信号：循环率、状态推进率、工具失败率、deliverable 缺失、回合预算逼近。

正式实现前必须以 D1-D7 轨迹离线回放，预注册召回率、误报率、成本上限和 DLP 风险，再单独立项。

## 8. Agent 交接要求

Kimi、pi、Claude 及后续接手 agent 必须遵守：

1. 不得在 D1-D7 中途实现或启用任务级线上升级门控；
2. 不得把 D1 `0%` 写成“无需教师”或“自主性达标”；
3. D2/D7 报告必须引用本报告并联合报告协议级升级率、AutonomousSuccessRate、MissedEscalationRate 与明显失败数；
4. 可以执行 Oracle/shadow 诊断，但必须保持写入隔离且不进入 evolution；
5. 门控正式改造统一延后到 D 阶段收口报告交付后，由用户另行批准。

## 9. 后续验收问题

1. 23 个明显失败中，Teacher Direct Solve 可挽救多少？
2. 哪种任务级信号能最早预测最终失败？
3. 在可接受误报率下，任务级升级能否提高 FunctionalSuccess 且控制云成本？
4. 新门控是否需要独立实验，而不是复用 D1-D7 结论？

Refer Spec：`doc/design/preview.html`（§3 假独立指标、§13 audit、解释红线）；
`doc/design/2026-08-19-d-stage-addendum-v2-main-review-and-decisions.md`（§六 FP deferred）；
`doc/design/2026-08-19-9b-campaign-experiment-design.md`；
`doc/design/2026-08-21-d1-zero-cloud-escalation-changes-and-decisions.md`
