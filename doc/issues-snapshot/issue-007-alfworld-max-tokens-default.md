# issue-007: alfworld_agent --max-tokens 默认值仍为 200（issue-003 缺陷原值，忘传参即复发）

- 状态：fixed（2026-08-09 修复，commit 899745d6）
- 报告：2026-08-09（P0 批次修复校验 diff 复查发现）
- 修复：2026-08-09——`--max-tokens` 改为必传（required=True，无默认值），哨兵测试防默认值被改回；pilot 定值后按校准值传参
- 影响面：`packages/agent-server/eval/alfworld_agent.py`（`--max-tokens` 参数默认值）

## 现象

P0 批次把 max_tokens 参数化为 `--max-tokens`，但默认值保留了 200——即 issue-003 的根因值。pilot 校准（800/1024）完成前，任何忘传参的运行静默复发门控 length 误升级。

## 根因

参数化时有意保留原默认（help 文本注明"pilot 校准 800/1024 前"），属过渡状态；需防止过渡期内误用。

## 修复

二选一：

1. pilot 定值后立即把默认值改为校准值（800 或 1024），并在 AGENTS.md 更新口径。
2. 或取消默认值改为必传参数（`required=True`），从机制上消除"忘传参"。

详见 `doc/design/2026-08-09-adversarial-review-experiment-validity.md` §6 V4。

## 回归测试

已落地（2026-08-09）：`test_alfworld_agent.py::test_max_tokens_is_required_argument`——缺 `--max-tokens` 时 parse_args SystemExit，显式传参正常；`build_parser()` 提取为模块级函数供测试。
