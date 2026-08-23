# issue-019: 请求级门控看不到任务级失败——0% 云升级结构性易绿

- 状态：**deferred（2026-08-21 用户裁决：D1-D7 保持线上门控不变；正式改造延后到 D 阶段收口后）**
- 报告：2026-08-21（D1 0% 云升级诊断）
- 影响面：`packages/agent-gateway/src/agent_gateway/quality.py`、D 阶段判据①②、自进化云教师轨迹供给

## 现象

D1 52 个任务、1,369 个唯一请求的 gateway 真值均显示云升级为 0；同时预注册口径存在 23 个明显失败任务，23 个全部未升级：

```text
AutonomousSuccessRate = 22/52 = 42.3%
MissedEscalationRate = 23/23 = 100%
```

## 根因

gateway 只按单请求可观察协议信号升级：非法工具 schema、length、空输出、强制工具缺失。格式合法但任务级错误的 bash tool call 不触发升级。D1 1,347/1,369 请求以 `tool_calls` 结束，因此门控自然全放行。

## 风险

- 升级率 0% 被误解释为无需教师或自主性达标；
- 明显失败不产生云教师修复轨迹；
- 云成本 0 与模型独立性混淆；
- 不同模型的输出形态差异污染升级率比较。

## 延后裁决

D1-D7 中途不得修改线上门控。只允许 Oracle/Teacher Direct Solve 与 shadow-only 离线诊断；结果不得影响路由或 evolution。正式改造在 D 阶段收口后另行立项并经用户批准。

## 候选修法（后续立项参考）

1. 任务级无进展/循环检测；
2. 工具连续失败检测；
3. 接近 MAX_TURNS 的升级或教师计划介入；
4. deliverable 缺失检测；
5. 先 shadow 回放，预注册召回率、误报率、成本和 DLP 风险，再启用路由。

## 回归测试

正式立项时补：合成“每轮 tool call schema 合法但任务持续无进展”的轨迹，断言 shadow detector 命中；线上启用前另补误报保护。D1-D7 期间不补会改变路由的生产测试。

详见：`doc/design/2026-08-21-d1-zero-cloud-escalation-diagnostic-report.md`
