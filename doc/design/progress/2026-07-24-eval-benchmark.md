# E 评估里程碑 — 进度与交接

状态：进行中
任务书：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`
最近更新：2026-07-30T15:30+08:00 by kimi（**改道**：TB/SWE-bench 弃用，E2'=ALFWorld、E3'=QwenClawBench、E4'=Claw-Eval；P1 ALFWorld 环境安装中）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| E0 评估实例 + 接线冒烟（含 harness 选型决策点） | done | kimi | 2026-07-24T15:35+08:00 | 决策记录 `doc/design/2026-07-24-agent-server-e0-eval-instance-changes-and-decisions.md`；修复非流式丢 tool_calls 阻塞性 bug（vitest 238 全绿）；mini-swe-agent 经 8789 全链路通；选型：mini-swe-agent（不用 Kimi/pi 做被测 agent） |
| E1 A/B 对照 harness 脚手架 | done | claude（kimi 验收） | 2026-07-24T16:53+08:00 | 决策记录 `doc/design/2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md`；`eval/harness.py` + `eval/tasks/tasks-5.yaml`；smoke-02 两臂各 5/5 通过。**验收（kimi 07-24）：通过**，修正 2 处（token delta 归因、日期）；遗留：commit 缺 conventional 前缀；归档混入 E0 session |
| ~~E2 Terminal-Bench A/B~~【废 07-30】 | E2.0/E2.1/E2.2 done；E2.3 全量中止（控制臂 8 trial/2 resolved 归档 `eval/results/tb-full-20260729/`） | claude（kimi 验收） | 2026-07-30T15:30+08:00 | **复验（kimi 07-28）：通过**。原始 results.json 证实控制臂 1/3 resolved（assign-seats）、实验臂 2/3 resolved（assign-seats + blind-maze），126 sessions（含真实 token usage）落盘；252 vitest 全绿。保留项：控制臂 blind-maze 实为安装失败（pip IncompleteRead，agent 未跑）；analyze-access-logs 无 trial 产物。详见验收报告复验节；**E2.3 小规模（kimi 07-29）：控制臂 4/5 = 实验臂 4/5**（唯一失败 ancient-puzzle 双臂 agent 真实运行未解出，有效对照）；六类环境失败全部机制性解决（wheelhouse/中继/测试注入/colima 代理/顺序执行/NO_PROXY），全量 infra 就绪，见 `doc/design/2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md` §7-8 |
| ~~E3 SWE-bench A/B~~【废 07-30】 | cancelled | | | |
| E2' ALFWorld A/B（134×2） | in_progress | kimi | 2026-07-30T15:30+08:00 | 环境安装中；方案见 `doc/design/2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md` |
| E3' QwenClawBench A/B（100×2） | pending | | | |
| E4' Claw-Eval 文本子集 A/B（199×2） | pending | | | |
| E5 飞轮实验 + 总评估报告（原 E4） | pending | | | |

依赖：E0 → E1 → {E2, E3 可并行} → E4。

## 2. 交接信息（跨 agent 共享事实）

- 2026-07-28 kimi：**E2.3 前置条件完成**——①离线 wheelhouse：`eval/wheelhouse/`（96 wheel/178MB，gitignored），adapter `perform_task` 复制进容器 `/wheelhouse`，安装脚本离线优先。②宿主中继 `eval/deepseek_relay.mjs`（0.0.0.0:8899 → api.deepseek.com）：**环境事实变更——7897 代理已失效、VM→DeepSeek 直连间歇性断流**，控制臂 LLM 流量必须走中继（`OPENAI_BASE_URL=http://host.docker.internal:8899/v1`）。验证：blind-maze 控制臂 mini 真实 32 步 0 连接错误。详见 `doc/design/2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md`。
- 2026-07-28 kimi：E2.3 全量启动方式（v2，以此为准）——前置三进程：中继 `node eval/deepseek_relay.mjs`（8899）、正向代理 `node eval/host_forward_proxy.mjs`（8898）、8789 评估实例（`HOST=0.0.0.0`）。tb 进程导出 `HTTP(S)_PROXY=http://host.docker.internal:8898`（build/install 用），控制臂 `OPENAI_BASE_URL=http://host.docker.internal:8899/v1`，实验臂 `...:8789/v1`。**双臂必须顺序执行**（部分任务硬编码宿主端口，如 ancient-puzzle 8090）。测试期网络：`eval/inject-proxy-into-tests.sh`（已注入 5 任务，全量前需跑全部任务）。colima daemon 代理已配为 192.168.5.2:8898（07-28 重启）；Docker Hub 拉取走 daocloud 镜像 + retag。
- 2026-07-28 kimi：首轮小规模失败教训——①双臂并行端口冲突；②实验臂撞 colima 重启窗口整轮作废；③TB run-tests.sh 自身要外网（apt+uv+pytest），需注入代理+镜像；④oracle 型错误：deb.debian.org 直连 15kB/s，清华镜像必需。

- 2026-07-24 kimi：测试基线 22 文件 / 236 vitest + 29 pytest 全绿。Node 走 `scripts/with-node25.sh`（25.9.0）。
- 2026-07-24 kimi：**生产环境在 Docker**（compose 三服务：server 8788 / evolution 24h / weekly-report 168h，DeepSeek teacher）。**评估环境独立**：host tsx 起第二个 agent-server，PORT=8789，`var/eval/` 独立 DB/sessions——benchmark 流量绝不进生产库。
- 2026-07-24 kimi：DeepSeek 配置在 `packages/agent-server/.env`（gitignored）：`LLM_BASE_URL=https://api.deepseek.com/v1`、`LLM_API_KEY`、flash/v4-pro。该账户只有 deepseek-v4-pro / deepseek-v4-flash。
- 2026-07-24 kimi：**GATEWAY_URL 指 DeepSeek 时不能带 /v1**（client 自己拼 /v1/chat/completions）：`GATEWAY_URL=https://api.deepseek.com` + `AGENT_GATEWAY_KEY=<deepseek key>`。
- 2026-07-24 kimi：宿主 PAC 代理 127.0.0.1:7897 会 MITM colima VM 流量；任务容器内 pip/apt 需 `HTTPS_PROXY=http://host.docker.internal:7897` + 镜像含 ca-certificates。
- 2026-07-24 kimi：SWE-bench 官方评分镜像 x86_64；colima 开 Rosetta 需重启 VM（影响在跑的生产容器，**需用户确认**）——E3 才碰。
- 2026-07-24 kimi：成功判据预定义（任务书）：①实验组≥对照组 ②第2轮>第1轮 ③成本与错误分布必须同报。
- 2026-07-24 kimi：第三方工具隔离装在 `packages/agent-server/eval/.venv`（uv venv），不进系统 Python。

## 3. 断点恢复指引

如果从零接手：读 `doc/design/progress/README.md` → 任务书 → 本状态表。E1 已完成，E2/E3 可并行认领。

## 4. E1 产出交接

- 2026-07-25 claude：E1 完成。harness 位于 `eval/harness.py`（openai 客户端直连，绕过 litellm bug）；任务定义 `eval/tasks/tasks-5.yaml`。
- 2026-07-25 claude：**litellm 1.93.0 在 eval/.venv 中有连接 bug**（`[Errno 8] nodename nor servname provided`），openai 直连正常。E2/E3 若用 mini-swe-agent，需解决此问题（升级 litellm 到预发布版或在 Docker 内运行）。
- 2026-07-25 claude：冒烟结果 smoke-02：两臂各 5/5 通过；实验臂 token +38%（注入开销，当前冷库注入为空）；session 归档机制验证通过。
- 启动命令同 E0（`PORT=8789 HOST=0.0.0.0 ... scripts/with-node25.sh npx tsx src/start.ts`，注意 HOST=0.0.0.0——Docker 容器需此配置）。运行 harness 前需 `unset HTTPS_PROXY HTTP_PROXY... && NO_PROXY='*'`（避免 macOS PAC 代理污染）。
- 2026-07-25 claude：E2 可达性验证通过。主结论——litellm Linux 容器内正常（E1 bug 仅限 macOS host）；容器经代理链可达 Docker Hub（需 colima 配代理）与 8789（需 HOST=0.0.0.0）。E2.3 全量未展开（pip 安装经代理链太慢，约 2-4min/容器）。
- 2026-07-25 claude：E2.3 前置条件——(a) 预构建含 mini-swe-agent 的 Docker 镜像，或 (b) 用户关闭 macOS PAC 代理，或 (c) 用 E1 openai 直连替代 mini-swe-agent 写 BaseAgent。
