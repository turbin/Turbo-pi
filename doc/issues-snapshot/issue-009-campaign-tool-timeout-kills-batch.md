# issue-009: campaign 工具调用超时未捕获杀死批次

- 状态：fixed
- 报告：2026-08-10 23:32（D2 监视器告警，监控发现）
- 修复：2026-08-10（commit 见 git log）
- 影响面：packages/agent-server eval — `campaign.py` bash 工具执行

## 现象

D2 完成 21/32 任务后整批崩溃：
`subprocess.TimeoutExpired: Command '['bash', '-c', 'find /Volumes/extern-1T-hardisk/workspace ...']' timed out after 120 seconds`
——agent 对外置 1T 硬盘发起大范围 find，撞 120s 工具超时。

## 根因

`run_agent` 的工具执行未捕获 `subprocess.TimeoutExpired`：agent 侧的一条"坏命令"（扫描巨型目录树）直接升级为批次级致命异常。工具层的局部失败不应穿透到批次层——agent 本应收到超时观察并自行收窄命令范围。

## 修复

- `subprocess.TimeoutExpired` / `OSError` 捕获后转为 toolResult 观察（`[command timed out after Ns — narrow the command scope]`）
- `TOOL_TIMEOUT_SECONDS` 抽为模块常量（测试可注入）

## 回归测试

`eval/tests/test_campaign.py::test_run_agent_tool_timeout_returns_observation_not_crash`
——慢命令超时后批次继续、transcript 含超时 toolResult。
