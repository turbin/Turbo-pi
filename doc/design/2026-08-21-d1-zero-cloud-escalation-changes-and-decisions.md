# D1 零云升级诊断：变更与决策记录

日期：2026-08-21  
状态：完成  
变更范围：仅文档、索引、issue/进度台账；未修改 gateway、campaign 或线上配置

## 完成事项

1. 将 D1 `0%` 云升级从 campaign 字段追溯到 gateway `model_runs` 真值表。
2. 形成正式诊断报告 `2026-08-21-d1-zero-cloud-escalation-diagnostic-report.md`。
3. 登记 issue-019，状态为 deferred。
4. 更新 `doc/design/INDEX.md`、issues index、E/D 进度交接，并为 C 阶段收口报告追加 2026-08-21 解释口径修订。
5. 固化 Kimi、pi、Claude 及后续 agent 的延后处理纪律。

## 决策

### D-1：判定“0 次升级”为真实路由结果

证据：D1 1,369 个唯一 trace_id 全部在 gateway 中有 `primary|succeeded|omlx`，无任何 `purpose=escalation` 行；campaign 52/52 行升级字段完整。

理由：gateway `model_runs` 是升级事实 owner，完整 trace join 比客户端单侧标记更强。

### D-2：将问题定性为构念有效性缺陷，而非标注缺陷

证据：明显失败 23/23 未升级，MissedEscalationRate=100%；当前门控只检查四类协议信号。

理由：升级率没有覆盖“任务是否需要教师”的目标概念，单独使用会结构性易绿。

### D-3：D1-D7 不改线上门控

理由：D1 已起跑，中途改门控会改变处理变量、云成本、轨迹和进化输入，破坏跨日可比性。

允许：Oracle、Teacher Direct Solve、shadow-only 离线诊断。  
禁止：让新信号改变 D1-D7 路由或 evolution 输入。

### D-4：修改报告解释口径

“升级率”统一解释为“协议级升级率”，必须与 AutonomousSuccessRate、MissedEscalationRate、明显失败数联合呈现。

理由：避免把协议输出稳定性误写成任务自主性。

### D-5：正式门控改造 deferred 到 D 阶段收口后

触发条件：D1-D7/Oracle/shadow 数据齐备，且用户单独批准。正式立项必须预注册召回率、误报率、云成本和 DLP 约束。

理由：先保当前实验内部有效性，再用完整轨迹设计下一轮门控实验。

## 未完成事项

1. 教师反事实挽救率尚未计算。
2. task-level shadow signals 尚未离线回放。
3. 在线门控未修改，且按本次裁决不得在 D1-D7 期间修改。

## 验证

- campaign：52 个任务、1,369 个 trace 引用且全部唯一；
- gateway：1,369/1,369 primary 覆盖，全部 omlx succeeded；
- finish_reason：tool_calls 1,347 / stop 22 / length 0；
- escalation model run：0；
- addendum：AutonomousSuccess 22/52=42.3%，MissedEscalation 23/23=100%。

本次只改文档，未启动跑批，未运行工程测试。

Refer Spec：`doc/design/preview.html`；
`doc/design/2026-08-19-d-stage-addendum-v2-main-review-and-decisions.md`；
`doc/design/2026-08-19-9b-campaign-experiment-design.md`；
`doc/design/2026-08-21-d1-zero-cloud-escalation-diagnostic-report.md`
