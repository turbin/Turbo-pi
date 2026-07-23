# Post-C 运维化里程碑 — 进度与交接

状态：进行中
任务书：` design/2026-07-23-agent-server-post-c-tasks.md`
最近更新：2026-07-23T18:25+08:00 by coder（N2 完成）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| N1 FTS tokenizer 修正（拉丁整词 + CJK bigram + FTS 重建 CLI） | done | coder | 2026-07-23T16:50+08:00 | 决策记录 ` design/2026-07-23-agent-server-n1-fts-tokenizer-changes-and-decisions.md`；21 文件 225 测试全绿 |
| N2 Docker 镜像首次构建验证（需 colima） | done | coder | 2026-07-23T18:25+08:00 | 决策记录 ` design/2026-07-23-agent-server-n2-docker-build-changes-and-decisions.md`；镜像 agent-server:local 145MB；Dockerfile 3 处修改 + server.ts HOST 参数化 |
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
- 2026-07-23 coder：N1 完成。`tokenizeForFts` 已重写为拉丁整词 + CJK char/bigram（对齐 retrieval.ts），并 export。新增 `src/offline/rebuild-fts.ts` CLI（DROP+CREATE 方案，因外部内容 FTS5 表 DELETE 报 `no such column: T.search_text`）。`var/experience.db` 已重建（29 行），备份在 `var/experience.db.n1-pre-rebuild-backup`。重建后 `MATCH '"jitter"'` 从 0→2 命中。测试基线更新：21 文件 / 225 测试。
- 2026-07-23 coder：N2 完成。Docker 镜像 `agent-server:local`（145MB）首次构建成功。Dockerfile 3 处修改：(1) 移除 `npm run build`（packages/ai 有 TS 编译错误，agent-server 全 `import type` 不需要）；(2) `npm ci` 不跳 scripts + 移除 `npm rebuild`；(3) 新增 `NPM_REGISTRY`/`NODE_DISTURL` ARG 和 `HOST=0.0.0.0` ENV。server.ts `startServer()` 的 listen host 改为 `process.env.HOST ?? "127.0.0.1"`。构建需 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com --build-arg NODE_DISTURL=https://cdn.npmmirror.com/binaries/node`（Docker Hub/nodejs.org 从 colima VM 不可达）。冒烟：单容器 status 端点 OK；compose 双服务 checkpoint `ckpt-e8759dab0837063c` 产生（metric=0，无 gateway 符合预期）。
- 2026-07-23 user-authorized, team-lead executed（17:04）：colima 已启动。macOS Virtualization.Framework, arch aarch64, runtime docker。docker context = "colima", socket unix:///Users/turbineyan/.colima/default/docker.sock。docker Client 29.4.1 / Server 29.2.1, `docker ps` OK。PRE-EXISTING containers: `portainer`（0.0.0.0:9443）和 `baa-agent`（0.0.0.0:5001）——与本任务无关，coder 须避免端口冲突、不可混淆为 agent-server 容器。Harmless boot warnings: colima boot scripts try `cd /Users/turbineyan/workspace/...`（repo 实际在 /Volumes/extern-1T-hardisk/...）——non-fatal；port 53 forward "address in use"——negligible。

## 3. 断点恢复指引

如果从零接手：

1. 读本目录 `README.md`（更新纪律）→ 任务书 ` design/2026-07-23-agent-server-post-c-tasks.md` → 本文件状态表。
2. N1 已完成（coder，bdc10a5e）。N2 已完成（coder）。下一步：认领 N3（dry-run 审查 + 安装指令 + 观察 runbook；实际安装是用户动作）。
3. 每完成一个子任务：填状态表 + 交接信息 + 刷新本节"下一步"。
