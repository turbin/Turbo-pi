# C campaign（D1-D7）数据归档 — 2026-08-14

口径说明：

- **harness**：host 侧最小 bash agent（非 OpenClaw 容器 harness）——任务原假设 cron/容器路径，分数系统性偏低的口径声明
- **模型**：学生 Qwen3.5-27B-Distilled-4bit（omlx），judge deepseek-v4-pro，蒸馏 deepseek-v4-flash
- **库**：实验臂每日冻结快照（store/c-d{2..7}.db），对照臂 injection off
- **已知缺陷**：issue-010（卡片缺交付物维度，D3-D4 下探的机制根源）；grading_error 0 行
- **结果**：判据①②双达标；归因增益 +10.3pp（抗劣化形态）；详见 doc/design/2026-08-14-agent-server-c-campaign-final-report.md

目录：
- results/：run.jsonl（267 任务执行）+ transcripts/day{1..7}/（逐任务轨迹）
- store/：experience-c-final.db（终态经验库）+ c-d{2..7}.db（每日快照）
- cards/：active-cards.json（920 条 active 卡全字段导出）
- logs/：campaign-d*.log + evolution-c-*.log
