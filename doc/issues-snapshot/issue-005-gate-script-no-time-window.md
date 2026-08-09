# issue-005: 升级率门控脚本无时间窗（共享 DB 上永远 FAIL，pilot→全量流程不可用）

- 状态：fixed（2026-08-09 修复，commit 待补）
- 报告：2026-08-09（P0 批次修复校验发现，实测复现）
- 修复：2026-08-09——新增 `--since <ISO>` / `--last-hours N`（JOIN request_executions.created_at 窗口过滤），共享 DB 历史脏数据不再钉死门控
- 影响面：`packages/agent-server/eval/gate_length_escalation.py`（issue-003 回归门控）

## 现象

`gate_length_escalation.py` 按 model_runs **全历史口径**统计 length 升级率。在含 B 阶段历史数据的共享 gateway DB 上实测：`requests=34557 length_escalated=10303 rate=0.298 >= 0.05 → FAIL exit 1`。门控逻辑本身正确（该拦的拦住了），但"冷库 pilot 5 局 → 过门控 → 开全量"的既定流程在共享 DB 上**永远过不了**——历史脏数据把 rate 钉死在 5% 以上。

## 根因

`length_escalation_stats()` 的 SQL 无任何时间过滤（`gate_length_escalation.py:51-60`），统计自库创建以来全部 primary/escalation run。B 阶段分析本身用时间窗（冷库窗口 08-04 21:00~08-06 14:45 等），门控未沿用该口径。

## 修复

二选一（或都做）：

1. 加 `--since` 参数（ISO 时间戳或 `--last-hours N`），按 model_runs/trace 的创建时间过滤，pilot 后只统计 pilot 窗口——推荐，语义最贴近"pilot 后开全量"。
2. 或在跑批 runbook 中规定：pilot 前归档轮换 gateway DB（`var/agent_gateway.db` 移走重开），门控维持全历史口径。

详见 `doc/design/2026-08-09-adversarial-review-experiment-validity.md` §6 V2。

## 回归测试

已落地（red-first，2026-08-09）：`test_campaign.py` 新增 `test_gate_length_escalation_since_window`（--since 窗口过滤，全历史 FAIL / 窗口 PASS）与 `test_gate_length_escalation_last_hours`（相对 now 倒推）；既有全历史口径测试保留。
