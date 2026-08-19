# 27B 经验库备份（2026-08-19）

## 口径

- **内容**：27B 时代终态经验库（`var/eval/experience.db`，89MB）+ 每日快照（snapshots/c-d2..d6.db）。
- **来源**：C campaign（D1-D7，27B 蒸馏模型 Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit）演进终态 + 2026-08-19 三次 pilot 的检索/归因记录（995 条 request_traces；其中前两次 pilot 实为 27B 服务——gateway 配置/进程错位事故，见 issue 决策记录；第三次为 9B）。
- **规模**：experiences 116,056 行（含 dormant/removed 全生命周期）；request_traces 995 行。
- **C campaign 全量数据**（run.jsonl/transcripts/卡片导出/日志）在 `backup/c-campaign-20260814/`，本备份只是库本体。

## 为什么备份后空库

2026-08-19 用户裁决：27B 经验不适用于 9B（不做存量重蒸，issue-010 注记），9B 全量跑批空库起跑。本备份是 27B 经验的唯一完整副本——T7 交叉臂冻结快照（D1 库）若需复用 27B 口径，从 snapshots/ 取。

## 已知缺陷（沿用 C 阶段口径）

- 27B 臂 B 阶段结论已撤回（issue-003：length 误升级 84-87%，纯 27B 从未被测）。
- 库中卡片为 issue-010 修复前蒸馏（缺 deliverables 维度，未重蒸）。
- request_traces 中 issue-013 修复前段落存在 requestId 碰撞（跨日合并）。
- 2026-08-19 pilot 段的 trace_ids 对账受 issue-015 影响（agent-server 覆写 body id，当日已修复）。
