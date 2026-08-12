# issues-snapshot 索引

状态图例：open（待修）/ fixed（已修待观察）/ closed（一个发布周期无复发）

| Issue | 标题 | 状态 | 报告 | 修复 | 回归测试 |
|---|---|---|---|---|---|
| [issue-001](issue-001-hit-rate-nan.md) | Web 页面命中率显示 NaN% | fixed | 2026-08-05 | 2026-08-05 | `packages/agent-server/test/regressions/issue-001-hit-rate-nan.test.ts` |
| [issue-002](issue-002-evolution-logprobs-json-truncation.md) | 进化管线 logprobs 大响应截断致 JSON 解析失败 | fixed（2026-08-09 补回归测试转正，待观察） | 2026-08-06 | 2026-08-06~07（三轮）+ 08-09 补测 | `packages/agent-server/python/tests/test_issue002_pipeline_resilience.py` |
| [issue-003](issue-003-gate-length-misescalation.md) | 门控 length 缺陷致 B 阶段两臂 84-87% 误升级 DeepSeek | open（代码修复已落地，方案 A/B/C 待用户拍板） | 2026-08-09 | 2026-08-09（P0 批次，见决策记录） | `test_escalation.py` 升级标记 pytest + `eval/gate_length_escalation.py` 升级率门控 |
| [issue-004](issue-004-x-gateway-marker-nonstream-break.md) | 非流式路径升级标记双层断裂（alfworld escalations 恒 0 假绿） | fixed（2026-08-09，待观察） | 2026-08-09（Kimi 审查） | 2026-08-09（body 内嵌 x_gateway + 非流式透传 + alfworld 改读 body + trace_id） | `test/regressions/issue-004-x-gateway-marker-nonstream.test.ts` + gateway/eval pytest |
| [issue-005](issue-005-gate-script-no-time-window.md) | 升级率门控脚本无时间窗（共享 DB 永远 FAIL，实测 0.298） | fixed（2026-08-09，待观察） | 2026-08-09（Kimi 审查） | 2026-08-09（`--since`/`--last-hours` JOIN request_executions 窗口过滤） | `test_campaign.py::test_gate_length_escalation_since_window/last_hours` |
| [issue-006](issue-006-snapshot-write-dedup-frozen-read.md) | 快照模式 getByContentHash 读冻结库（写侧去重漏重） | fixed（2026-08-09，待观察） | 2026-08-09（Kimi 审查） | 2026-08-09（写路径查询 getById/getByContentHash 改回 live 库） | `test/regressions/issue-006-snapshot-write-dedup.test.ts` |
| [issue-007](issue-007-alfworld-max-tokens-default.md) | alfworld --max-tokens 默认仍 200（缺陷原值） | fixed（2026-08-09，待观察） | 2026-08-09（Kimi 审查） | 2026-08-09（必传 required，哨兵测试防回退） | `test_alfworld_agent.py::test_max_tokens_is_required_argument` |
| [issue-008](issue-008-campaign-batch-killed-by-single-timeout.md) | campaign 批次被单请求超时杀死（无重试/无断点续跑，27B 慢回合 950s>客户端 300s） | fixed（2026-08-09，待观察） | 2026-08-09（D1 监视器告警） | 2026-08-09（timeout 1800s + 4 次退避重试 + completed_keys 续跑） | `eval/tests/test_campaign.py::test_run_agent_retries_transient_api_errors` 等 3 例 |
| [issue-009](issue-009-campaign-tool-timeout-kills-batch.md) | campaign 工具超时未捕获杀死批次（agent find 扫描 1T 盘撞 120s） | fixed（2026-08-10，待观察） | 2026-08-10（D2 监视器告警） | 2026-08-10（TimeoutExpired 转 toolResult 观察） | `test_campaign.py::test_run_agent_tool_timeout_returns_observation_not_crash` |
| [issue-010](issue-010-card-guided-execution-crowds-out-deliverable.md) | 照卡执行挤占交付本能——注入卡片致重复集分数连续下滑（0.567→0.404），蒸馏模板缺交付物维度+验证闸门盲区 | **open（代码修改延迟到 C 测试完成后，用户决定）** | 2026-08-12（D3 数据+个案分析） | 待定（修复项 4 条已预列） | 待定（届时补：无交付轨迹的闸门拦截测试） |
| [issue-011](issue-011-qcb-grader-script-crash-kills-batch.md) | QCB 内嵌评分脚本崩溃杀死批次（readme_content 未绑定，上游资产 bug） | fixed（2026-08-13，待观察） | 2026-08-13（D5 监视器告警） | 2026-08-13（safe_grade 降级为 grading_error 行） | `test_campaign.py::test_safe_grade_degrades_on_grader_crash` |
