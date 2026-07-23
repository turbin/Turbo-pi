# Post-C 运维化里程碑 — 进度与交接

状态：进行中
任务书：` design/2026-07-23-agent-server-post-c-tasks.md`
最近更新：2026-07-23T15:40+08:00 by kimi（立项初始化）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| N1 FTS tokenizer 修正（拉丁整词 + CJK bigram + FTS 重建 CLI） | pending | | | |
| N2 Docker 镜像首次构建验证（需 colima） | pending | | | |
| N3 上线观察期启动（dry-run 审查 + 安装指令 + 观察 runbook） | pending | | | |

依赖关系：N1 独立；N2 独立（前置：colima 运行，属工程外，需用户配合）；N3 的"实际安装"步骤是用户动作，agent 只交付 dry-run 审查与指令。三者可并行，建议顺序 N1 → N2 → N3。

## 2. 交接信息（跨 agent 共享事实）

- 2026-07-23 kimi：测试基线 20 文件 / 213 测试全绿（`scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run`，从 `packages/agent-server` 执行）。Node 必须走 `scripts/with-node25.sh`（25.9.0）。
- 2026-07-23 kimi：omlx 在 127.0.0.1:8000（模型 gemma-4-12B-it-4bit，要 api_key）；gateway 8787（channel key `lobster-local-key`）；agent-server 8788。omlx 不可动（通用约束）。
- 2026-07-23 kimi：经验库 `packages/agent-server/var/experience.db`（gitignored）。C3 follow-up 后库存：ABILITY 3（2 手动 + 1 自然 Method）、EVIDENCE 25、SKILL 1，active 共 29；dormant 0；checkpoint 2 个。运行前备份：`var/experience.db.c3-followup-backup`。
- 2026-07-23 kimi：FTS 问题实证——`tokenizeForFts`（`src/experience-store.ts:69-83`）把非 CJK 也逐字拆开，`search_text` 列对拉丁正文词查询永不命中；`title` 列因 INSERT 时从 experiences 原样 SELECT 未拆字，词查询实际只命中 title。实证：`MATCH 'jitter'`（仅正文）0 命中，`MATCH 'flaky'`（title 内）命中。FTS INSERT 无触发器，手动同步（`experience-store.ts:147-153`）。
- 2026-07-23 kimi：调度 CLI 已存在（B3）：`npx tsx src/offline/schedule.ts <install|uninstall|doctor> [--dry-run]`；红线：测试沙箱外禁止无 --dry-run 跑 install/uninstall（`schedule.ts:14-18`）。实际安装是用户动作。
- 2026-07-23 kimi：容器资产已存在未构建：`packages/agent-server/Dockerfile`（基础镜像 `node:25.9.0-bookworm-slim`）、`docker-compose.yml`（含 `agent-server-evolution` sidecar，`--loop` 模式，`AGENT_SERVER_EVOLUTION_INTERVAL_HOURS` 默认 24h，首次启动立即跑一轮）。
- 2026-07-23 kimi：`var/sessions/` 现有 5 个 session（4 真实 + 1 构造的 retry/backoff 会话 `1784792682394-*.jsonl`）。进化 CLI：`EXPERIENCE_STORE_PATH=./var/experience.db AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json PYTHONPATH=python ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts`（从 `packages/agent-server` 执行）。

## 3. 断点恢复指引

如果从零接手：

1. 读本目录 `README.md`（更新纪律）→ 任务书 ` design/2026-07-23-agent-server-post-c-tasks.md` → 本文件状态表。
2. 当前无一子任务被认领。按 N1 → N2 → N3 顺序认领（认领即把状态改 `in_progress` 并署名）。
3. 每完成一个子任务：填状态表 + 交接信息 + 刷新本节"下一步"。
