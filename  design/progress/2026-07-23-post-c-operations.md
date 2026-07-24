# Post-C 运维化里程碑 — 进度与交接

状态：已收口（N2 于 2026-07-24 补完 metric>0 验证）
任务书：` design/2026-07-23-agent-server-post-c-tasks.md`
最近更新：2026-07-24T11:20+08:00 by kimi（N2 metric>0 验证通过 + N3 安装（TCC 阻塞待用户决策）+ DeepSeek teacher 切换）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| N1 FTS tokenizer 修正（拉丁整词 + CJK bigram + FTS 重建 CLI） | done | coder | 2026-07-23T16:50+08:00 | commit bdc10a5e；决策记录 ` design/2026-07-23-agent-server-n1-fts-tokenizer-changes-and-decisions.md`；21 文件 225 测试全绿 |
| N2 Docker 镜像首次构建验证（需 colima） | done | kimi | 2026-07-24T11:20+08:00 | **metric>0 验证通过**：容器内 DeepSeek teacher 进化 checkpoint ckpt-bd091b6a34c06a4f metric=11；修复 session 目录 env 不生效/缺 CA 证书/代理 MITM/超时 4 个问题；决策记录 ` design/2026-07-24-agent-server-n2-closeout-deepseek-teacher-changes-and-decisions.md` |
| N3 上线观察期启动（dry-run 审查 + 安装指令 + 观察 runbook） | done | coder | 2026-07-23T21:00+08:00 | commit 7bd6273f；决策记录 ` design/2026-07-23-agent-server-n3-go-live-changes-and-decisions.md`；观察 runbook ` design/2026-07-23-agent-server-observation-runbook.md`；agent 未执行 install（用户动作） |

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
- 2026-07-23 pm-agent（18:45，用户指示 + team-lead 协调）：**N2 回退为 in_progress**。metric=0 机制验证已完成（5b6d760d），但用户明确要求补做 gateway metric>0 完整验证（仍起 gateway 做真实进化）。等用户启动 gateway 后，coder 以 `AGENT_GATEWAY_KEY=lobster-local-key` 重跑 compose 双服务，确认 checkpoint metric>0，follow-up commit 更新 N2 决策记录。N3 暂挂（回退为 pending），待 N2 metric>0 完成后再认领。
- 2026-07-23 coder：N3 完成。dry-run 审查三命令（doctor/install/uninstall --dry-run）已执行并完整摘录进决策记录。重点审查项结论：(1) EXPERIENCE_STORE_PATH 无需设置（代码默认 ./var/experience.db，plist cwd 正确）；(2) AGENT_SERVER_BENCHMARK 缺失→skill_evolution 管线跳过，需用户在 plist 添加 EnvironmentVariables（指令已给出）；(3) PYTHONPATH 无需设置（pipeline.ts 程序化设置）；(4) Node PATH 潜在问题——LaunchAgent 环境 PATH 受限，裸 `npx tsx` 可能不可达，推荐方案 A（plist 命令改用 with-node25.sh）。安装/卸载/自查指令已交付（agent 未执行 install）。观察 runbook 含：每周 SQL 对照集（基线 §1/§3/§4/§5/§6）、触发评审动作表（C 方案 5 项决策）、客户端接线（Kimi Code type=openai_legacy → 8788）、周报模板。
- 2026-07-23 pm-agent（21:30，用户直接指示）：**N2 metric>0 验证转用户手工完成**。用户指示跳过 N2 剩余 agent 工作（gateway metric>0 完整验证），后续由用户手工执行。Agent 侧 N2 工作以 metric=0 机制验证（5b6d760d）为最终产出。**Post-C 里程碑 agent 侧全部完成：N1 done + N2 done（metric>0 用户手工）+ N3 done。**
- 2026-07-23 pm-agent（22:00，里程碑收口）：**Post-C 运维化里程碑已收口。** 最终状态：N1 done（bdc10a5e）· N2 skipped（agent 侧 build/smoke/compose/checkpoint 机制验证完成于 5b6d760d；metric>0 完整进化验证经用户决定转手工，于上线时自然完成——类比 N3 的 install 是用户动作）· N3 done（7bd6273f）。上线三件用户动作：(a) 启 gateway 后跑 metric>0 验证（`AGENT_GATEWAY_KEY=lobster-local-key` + compose 双服务，补全 N2）——见 ` design/2026-07-23-agent-server-n2-docker-build-changes-and-decisions.md`；(b) 按 N3 决策记录执行 install（plist 需加 `AGENT_SERVER_BENCHMARK`、命令建议走 `with-node25.sh`）——见 ` design/2026-07-23-agent-server-n3-go-live-changes-and-decisions.md` §3；(c) 按观察 runbook 开始每周观察——见 ` design/2026-07-23-agent-server-observation-runbook.md`。本文件收口后不再更新；长期 canonical 文档为各任务决策记录 + runbook。

## 3. 断点恢复指引

**本里程碑已收口（2026-07-23）。无 agent 待办。** 后续皆为用户上线动作：

1. **N2 补全 — metric>0 完整进化验证**（用户手工）：启动 gateway (8787)，以 `AGENT_GATEWAY_KEY=lobster-local-key` 跑 `docker compose up` 双服务，确认 checkpoint metric>0。参考：` design/2026-07-23-agent-server-n2-docker-build-changes-and-decisions.md`。
2. **N3 安装 — LaunchAgent 调度**（用户手工）：按决策记录 §3 执行 install（plist 需加 `AGENT_SERVER_BENCHMARK` 环境变量、命令建议走 `with-node25.sh`），首次手动触发进化验证。参考：` design/2026-07-23-agent-server-n3-go-live-changes-and-decisions.md`。
3. **观察期启动 — 每周对照基线**：按 runbook 执行每周 SQL 对照、触发评审动作表、周报。参考：` design/2026-07-23-agent-server-observation-runbook.md`。

本文件收口后不再更新。长期 canonical 文档为上述各决策记录 + runbook。
