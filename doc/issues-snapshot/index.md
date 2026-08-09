# issues-snapshot 索引

状态图例：open（待修）/ fixed（已修待观察）/ closed（一个发布周期无复发）

| Issue | 标题 | 状态 | 报告 | 修复 | 回归测试 |
|---|---|---|---|---|---|
| [issue-001](issue-001-hit-rate-nan.md) | Web 页面命中率显示 NaN% | fixed | 2026-08-05 | 2026-08-05 | `packages/agent-server/test/regressions/issue-001-hit-rate-nan.test.ts` |
| [issue-002](issue-002-evolution-logprobs-json-truncation.md) | 进化管线 logprobs 大响应截断致 JSON 解析失败 | fixed（2026-08-09 补回归测试转正，待观察） | 2026-08-06 | 2026-08-06~07（三轮）+ 08-09 补测 | `packages/agent-server/python/tests/test_issue002_pipeline_resilience.py` |
| [issue-003](issue-003-gate-length-misescalation.md) | 门控 length 缺陷致 B 阶段两臂 84-87% 误升级 DeepSeek | open（代码修复已落地，方案 A/B/C 待用户拍板） | 2026-08-09 | 2026-08-09（P0 批次，见决策记录） | `test_escalation.py` 升级标记 pytest + `eval/gate_length_escalation.py` 升级率门控 |
