# issue-008: campaign 批次被单请求超时杀死（无重试/无断点续跑）

- 状态：fixed
- 报告：2026-08-09 22:46（D1 监视器告警，监控发现）
- 修复：2026-08-09（commit 见 git log）
- 影响面：packages/agent-server eval — `campaign.py`（C 阶段 runner）

## 现象

C campaign D1 运行 1.25h、完成 3 个任务后整批崩溃：
`openai.APITimeoutError: Request timed out.`

## 根因

1. **27B 慢回合远超客户端超时**：agent-server 日志实测单请求 latency 706-949s（33,933 输入 / 9,567 输出 token），campaign.py 的 OpenAI 客户端 timeout=300s 必然截断。
2. **run_agent 无重试**：任何瞬时 API 错误直接炸毁整批（alfworld_agent.py 早有 6 次重试，campaign.py 移植时遗漏）。
3. **无断点续跑**：批次崩溃后已完成任务的进度无法恢复（同日重跑会重复执行+重复打分，污染结果与成本）。

## 修复

- 客户端 timeout 300s → 1800s（大于实测最慢回合）
- `run_agent` 增加 4 次指数退避重试（`RETRY_BASE_SECONDS` 可注入，测试置 0）
- 新增 `completed_keys()` 断点续跑：按 (day, arm, task_id) 跳过 run.jsonl 已有行

## 回归测试

`packages/agent-server/eval/tests/test_campaign.py`（red-first，全绿）：

1. `test_run_agent_retries_transient_api_errors`——连续 2 次 APITimeout 后第 3 次成功，批次继续
2. `test_run_agent_gives_up_after_max_retries`——持续故障在重试耗尽后抛错
3. `test_completed_keys_for_resume`——续跑集合正确（含缺文件返回空集）
