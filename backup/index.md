# backup/ — 实验数据备份索引

用途：存放各阶段实验的完整数据备份（跑批结果、轨迹、SQLite 库快照、报告配套数据）。
数据文件不进 git（本目录除 index.md 外全部 gitignored），索引永存。

## 目录规范

每轮实验一个子目录：`<阶段>-<日期>/`，内含：
- `results/`——跑批 JSONL 与逐任务 transcript
- `store/`——经验库 SQLite 全量备份 + 每日快照（snapshots/）
- `cards/`——库中 active 卡片导出（JSON/CSV，含 Method/Guard/EVIDENCE 全字段）
- `logs/`——跑批与进化日志
- `README.md`——该轮数据的口径说明（harness/模型/库版本/已知缺陷）

## 备份登记

| 日期 | 目录 | 内容 | 状态 |
|---|---|---|---|
| （待 C 轮结束后执行） | `c-campaign-2026XXXX/` | C campaign D1-D7 全部数据 + 经验库 + 卡片导出 + 日志 | **待办** |
