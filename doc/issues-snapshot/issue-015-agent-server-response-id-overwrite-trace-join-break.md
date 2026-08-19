# issue-015: M1/F0 回归——agent-server 覆写响应 body id，trace_ids↔model_runs 对账静默断裂

- 状态：**fixed（2026-08-19，9B pilot 暴露当日修复，待观察）**
- 报告：2026-08-19（9B pilot 校准批：finish_reason 分布查询全空 → 双侧复核定位）
- 修复：2026-08-19（campaign.py run_agent 对账键改取 marker.trace_id）
- 影响面：`packages/agent-server/eval/campaign.py` run.jsonl.trace_ids、`campaign_metrics.annotate_escalation` C2 回填、pilot_9b finish_reason 分布

## 现象

9B pilot 首批两任务：`model_runs` 查询按 run_agent 返回的 trace_ids 全部 miss（finish_reason 分布为空）。探针复现：经 8789 的响应 body `id` = `chatcmpl-7f3f036a-e5cd-447f-...`（UUID 带横线），而 body `x_gateway.trace_id` = `chatcmpl-37c8ace2...`（无横线，model_runs 真实键）——两者已不是一个值。

## 根因

M1/F0（issue-013 修复，2026-08-14）把 agent-server requestId 改 randomUUID 后，agent-server 把**响应 body 的 id 覆写为自己的请求 id**；C 阶段赖以 join 的"resp.id == gateway trace_id"等式失效。该断裂静默：campaign 照常写 run.jsonl，只是 trace_ids 列变成 agent-server 请求 id，离线回填（annotate_escalation）与 pilot 的 finish_reason 核算全部查空。C 阶段数据不受影响（M1 之前 resp.id 未被覆写）。

附带发现（同一探针）：`_gateway_marker()` 读 `resp.headers` 对 openai SDK v2 恒为空（SDK 响应对象无 .headers），run.jsonl 的 escalated 列一直依赖离线回填，本次一并改读 body 内嵌标记（issue-004 的本意路径）。

## 修复

campaign.py：新增 `_body_marker()`（读 body x_gateway，issue-004 内嵌路径）+ `_response_marker()`（body 优先 header 回落）+ `_response_trace_id()`（marker.trace_id 优先，body id 最后回落）；run_agent 的 trace_ids/escalated 两列改走新口径。

## 回归测试

`eval/tests/test_issue015_trace_join.py`（5 例）：body 标记优先取 trace_id、escalated 读 body 标记、header 回落、body id 兜底、全空返回 ""。先红（修复前 4 红）后绿，永久保留。
