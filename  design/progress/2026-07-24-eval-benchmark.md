# E 评估里程碑 — 进度与交接

状态：进行中
任务书：` design/2026-07-24-agent-server-eval-benchmark-tasks.md`
最近更新：2026-07-24T17:15+08:00 by kimi（E1 验收通过，附修正）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| E0 评估实例 + 接线冒烟（含 harness 选型决策点） | done | kimi | 2026-07-24T15:35+08:00 | 决策记录 ` design/2026-07-24-agent-server-e0-eval-instance-changes-and-decisions.md`；修复非流式丢 tool_calls 阻塞性 bug（vitest 238 全绿）；mini-swe-agent 经 8789 全链路通；选型：mini-swe-agent（不用 Kimi/pi 做被测 agent） |
| E1 A/B 对照 harness 脚手架 | done | claude（kimi 验收） | 2026-07-24T16:53+08:00 | 决策记录 ` design/2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md`；`eval/harness.py` + `eval/tasks/tasks-5.yaml`；smoke-02 两臂各 5/5 通过。**验收（kimi 07-24）：通过**，修正 2 处（token delta 归因、日期）；遗留：commit 缺 conventional 前缀；归档混入 E0 session |
| E2 Terminal-Bench A/B（89 任务） | pending | | | | 任务书：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（2026-07-24 kimi 编写，含 E2.0 三项探针/R1-R5 风险对策） |
| E3 SWE-bench A/B（Lite 10 → 300 待定） | pending | | | |
| E4 飞轮实验 + 总评估报告 | pending | | | |

依赖：E0 → E1 → {E2, E3 可并行} → E4。

## 2. 交接信息（跨 agent 共享事实）

- 2026-07-24 kimi：测试基线 22 文件 / 236 vitest + 29 pytest 全绿。Node 走 `scripts/with-node25.sh`（25.9.0）。
- 2026-07-24 kimi：**生产环境在 Docker**（compose 三服务：server 8788 / evolution 24h / weekly-report 168h，DeepSeek teacher）。**评估环境独立**：host tsx 起第二个 agent-server，PORT=8789，`var/eval/` 独立 DB/sessions——benchmark 流量绝不进生产库。
- 2026-07-24 kimi：DeepSeek 配置在 `packages/agent-server/.env`（gitignored）：`LLM_BASE_URL=https://api.deepseek.com/v1`、`LLM_API_KEY`、flash/v4-pro。该账户只有 deepseek-v4-pro / deepseek-v4-flash。
- 2026-07-24 kimi：**GATEWAY_URL 指 DeepSeek 时不能带 /v1**（client 自己拼 /v1/chat/completions）：`GATEWAY_URL=https://api.deepseek.com` + `AGENT_GATEWAY_KEY=<deepseek key>`。
- 2026-07-24 kimi：宿主 PAC 代理 127.0.0.1:7897 会 MITM colima VM 流量；任务容器内 pip/apt 需 `HTTPS_PROXY=http://host.docker.internal:7897` + 镜像含 ca-certificates。
- 2026-07-24 kimi：SWE-bench 官方评分镜像 x86_64；colima 开 Rosetta 需重启 VM（影响在跑的生产容器，**需用户确认**）——E3 才碰。
- 2026-07-24 kimi：成功判据预定义（任务书）：①实验组≥对照组 ②第2轮>第1轮 ③成本与错误分布必须同报。
- 2026-07-24 kimi：第三方工具隔离装在 `packages/agent-server/eval/.venv`（uv venv），不进系统 Python。

## 3. 断点恢复指引

如果从零接手：读 ` design/progress/README.md` → 任务书 → 本状态表。E1 已完成，E2/E3 可并行认领。

## 4. E1 产出交接

- 2026-07-25 claude：E1 完成。harness 位于 `eval/harness.py`（openai 客户端直连，绕过 litellm bug）；任务定义 `eval/tasks/tasks-5.yaml`。
- 2026-07-25 claude：**litellm 1.93.0 在 eval/.venv 中有连接 bug**（`[Errno 8] nodename nor servname provided`），openai 直连正常。E2/E3 若用 mini-swe-agent，需解决此问题（升级 litellm 到预发布版或在 Docker 内运行）。
- 2026-07-25 claude：冒烟结果 smoke-02：两臂各 5/5 通过；实验臂 token +38%（注入开销，当前冷库注入为空）；session 归档机制验证通过。
- 启动命令同 E0（`PORT=8789 ... scripts/with-node25.sh npx tsx src/start.ts`）。运行 harness 前需 `unset HTTPS_PROXY HTTP_PROXY...`（避免 .env 的 docker 代理污染）。
