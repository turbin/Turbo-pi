# E 评估里程碑 — 进度与交接

状态：进行中
任务书：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`
最近更新：2026-08-09T15:10+08:00 by kimi（对抗性审查交付：issue-003 登记 + 39 项发现报告；B 阶段重跑方案与 P0-P2 修复分批均待用户拍板）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| E0 评估实例 + 接线冒烟（含 harness 选型决策点） | done | kimi | 2026-07-24T15:35+08:00 | 决策记录 `doc/design/2026-07-24-agent-server-e0-eval-instance-changes-and-decisions.md`；修复非流式丢 tool_calls 阻塞性 bug（vitest 238 全绿）；mini-swe-agent 经 8789 全链路通；选型：mini-swe-agent（不用 Kimi/pi 做被测 agent） |
| E1 A/B 对照 harness 脚手架 | done | claude（kimi 验收） | 2026-07-24T16:53+08:00 | 决策记录 `doc/design/2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md`；`eval/harness.py` + `eval/tasks/tasks-5.yaml`；smoke-02 两臂各 5/5 通过。**验收（kimi 07-24）：通过**，修正 2 处（token delta 归因、日期）；遗留：commit 缺 conventional 前缀；归档混入 E0 session |
| ~~E2 Terminal-Bench A/B~~【废 07-30】 | E2.0/E2.1/E2.2 done；E2.3 全量中止（控制臂 8 trial/2 resolved 归档 `eval/results/tb-full-20260729/`） | claude（kimi 验收） | 2026-07-30T15:30+08:00 | **复验（kimi 07-28）：通过**。原始 results.json 证实控制臂 1/3 resolved（assign-seats）、实验臂 2/3 resolved（assign-seats + blind-maze），126 sessions（含真实 token usage）落盘；252 vitest 全绿。保留项：控制臂 blind-maze 实为安装失败（pip IncompleteRead，agent 未跑）；analyze-access-logs 无 trial 产物。详见验收报告复验节；**E2.3 小规模（kimi 07-29）：控制臂 4/5 = 实验臂 4/5**（唯一失败 ancient-puzzle 双臂 agent 真实运行未解出，有效对照）；六类环境失败全部机制性解决（wheelhouse/中继/测试注入/colima 代理/顺序执行/NO_PROXY），全量 infra 就绪，见 `doc/design/2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md` §7-8 |
| ~~E3 SWE-bench A/B~~【废 07-30】 | cancelled | | | |
| E2' ALFWorld 三腿 A/B | **done** | kimi | 2026-07-31T15:00+08:00 | **链路接回**（决策记录 `doc/design/2026-07-30-agent-server-student-teacher-reconnect-changes-and-decisions.md`）：8789→8787→omlx+DeepSeek 升级全通；学生测速 3.2min/局、升级率 ~30%；L1=直连 DeepSeek（9/134）；L2=8787 学生基线；L3=8789 注入（session 已归档清空） |
| E3' QwenClawBench A/B（100×2） | pending | | | |
| E5 飞轮实验（冷库 L3 轨迹→进化→热库重跑） | **done** | kimi | 2026-08-03T21:45+08:00 | R2 热库 SR 11/134=8.2% > R1 冷库 10/134=7.5%（判据②方向成立，+1 局在噪声内）；**次级强信号：升级率 72.6%→54.4%（-18.2pp）、云端 token -18%**；检索命中 6231/6231=100%；决策记录 `doc/design/2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md`；建议进化 2-3 轮复测看复利效应 | 坑：6372 per-request session 喂进化会超时/SIGKILL → 合成 134 局干净 session（`var/eval/sessions-r1/`，从 L3 JSONL 轨迹+任务行前缀匹配回構）；进化 metric=238（active EVIDENCE 238 条，均 quality 0.547）；热库轮 request_traces 命中 40/40（检索真正工作） |
| E4' Claw-Eval 文本子集 A/B（199×2） | pending | | | |
| E5 飞轮实验 + 总评估报告（原 E4） | pending | | | |

依赖：E0 → E1 → {E2, E3 可并行} → E4。

## 2. 交接信息（跨 agent 共享事实）

- 2026-08-09 kimi：**对抗性审查交付（第二轮 08-09）**——issue-003 登记（门控 length 缺陷，`doc/issues-snapshot/issue-003-gate-length-misescalation.md`，open）；全链路对抗审查报告 `doc/design/2026-08-09-adversarial-review-experiment-validity.md`：39 项发现（4 critical/21 major/14 minor），全部代码行级验证。**critical 四项**：C1 campaign.py run_agent 缺 injection 参数（committed 代码从未跑通）；C2 判据结构性永绿（escalated 硬编码 False，标注脚本不存在）；C3 alfworld 134 硬编码→`alfworld-20260730` 控制臂 17/134 局为重放（A/B 错位 12.7%，历史结论引用需注明口径）；C4 升级结果不过闸 + max_tokens 原样上云。**方案 A 修正**：agent-local 绕门控不成立（routing.py:31 忽略 model 名）；max_tokens 需 5 局 pilot 校准 + 验收门槛 length 升级率 <5%。**修复分 P0/P1/P2 待用户拍板，与重跑方案 A/B/C 一并决策**。

- 2026-08-09 kimi：**B 阶段收官+重大修正**（`doc/design/2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md`）。冷/热均 21/134（Δ=0）。**门控 length 缺陷：两臂 84-87% 请求被升级到 DeepSeek（max_tokens=200 × 27B 叙述截断误杀，quality.py:90），纯 27B 从未被测过**；“27B 升级率 0%/本地独立/云端归零”结论已撤回。重跑方案 A（双臂 max_tokens=800，~4 天）/B（混合口径）/C（仅冷库，~2 天）**待用户拍板，跑批暂停**。进化管线修复已入库（llm_client 重试+打分形态）；issue-002 草案待 C 完成后提醒。

- 2026-08-06 kimi：**issue-002 草案（到期提醒）**——进化管线 logprobs 大响应截断 JSON 解析失败，已修（llm_client 双副本 JSONDecodeError 重试），**用户决定：先作草案存放，待 B 热库轮报告 + C campaign 报告全部交付后，提醒用户决定转正/降级/关闭**。详见 `doc/issues-snapshot/issue-002-evolution-logprobs-json-truncation.md`。

- 2026-08-05 kimi：**C 阶段脚手架并行交付**（用户批准与 B 并行）。QwenClawBench v1.1 语料已 vendor 到 `eval/qcb/tasks-v1.1/`（99 任务，gitignored）；`campaign_plan.py`（分层划分 seed=42：重复集 20 + 新任务 79 七日切片）+ `campaign_metrics.py`（判据核算）+ `campaign.py`（runner，--dry-run/--metrics）+ `tests/test_campaign.py` 9 pytest 全绿。判据预注册设计文档 `doc/design/2026-08-05-agent-server-c-campaign-design.md`。**开跑前待办 4 项见该文档 §5**（escalated 标注/judge 冒烟/harness 口径/omlx 互斥）。

- 2026-08-05 kimi：**Web 监控面板落地**（决策记录 `doc/design/2026-08-05-agent-server-web-monitor-changes-and-decisions.md`）：`8789/dashboard` 单页（链路/命中率/日志，5s 自刷）；`/api/status/chain`、`/api/logs?lines=N`；`AGENT_SERVER_WEB=off` 可关（默认 on）。日志文件 `var/log/agent-server.log`。vitest 262 全绿。**教训：pkill -f "tsx src/start.ts" 会误杀 8789——杀实例用精确 PID**。

- 2026-08-05 kimi：**注入开关 + preflight 门禁落地**（决策记录 `doc/design/2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md`）。①`AGENT_SERVER_INJECTION=off` / 请求级 `injection:true|false`（`/v1` body 或 `/api/stream` options）；关闭=跳过检索+注入（含 skill catalog/SOP schema）但 session/trace 照录，`experience_injection.disabled=true` 可区分。②**控制臂新跑法**：`alfworld_agent.py --base-url http://127.0.0.1:8789/v1 --injection off`——不再物理旁路，基线轨迹进学习回路（27B 冷库 v2 是最后一代旁路基线，对比时注明口径）。③所有跑批入口启动前自动过 `eval/preflight.py`（按端口推导依赖链，8789/8787/8899 down 自动 nohup 拉起，omlx 只探活）。vitest 256 全绿、npm run check 干净。

- 2026-07-28 kimi：**E2.3 前置条件完成**——①离线 wheelhouse：`eval/wheelhouse/`（96 wheel/178MB，gitignored），adapter `perform_task` 复制进容器 `/wheelhouse`，安装脚本离线优先。②宿主中继 `eval/deepseek_relay.mjs`（0.0.0.0:8899 → api.deepseek.com）：**环境事实变更——7897 代理已失效、VM→DeepSeek 直连间歇性断流**，控制臂 LLM 流量必须走中继（`OPENAI_BASE_URL=http://host.docker.internal:8899/v1`）。验证：blind-maze 控制臂 mini 真实 32 步 0 连接错误。详见 `doc/design/2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md`。
- 2026-07-31 kimi：三腿报告 `doc/design/2026-07-31-agent-server-alfworld-three-leg-report.md`。关键事实：①L3 期间评估库经验=0（6373 请求 0 命中，注入为空块）——L3≈L2+空注入，有益性证明只能来自 E5 热库轮；②L3 的 client 侧 usage=0（gateway 路径 usage 未透传回 client，follow-up）；③腿间差 1-2 局在噪声内，报告按 Harness-Bench 纪律以 model×harness 配置呈现。
- 2026-07-30 kimi：**agent-server 生产修复**——`stop`/`thinking` 参数透传（types/proxy-handler/gateway-client/server + 2 TDD 用例，254 全绿，commit 32a46959 + 后续）；8789 已重启加载修复。ALFWorld 双臂跑法：`eval/alfworld_agent.py --base-url <8899中继|8789> --output ...`（控制臂 8899、实验臂 8789，KEY 从 ../.env 用 grep 提取，`source` 方式不可靠）。
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
- 2026-08-09 pi：**P0 修复批次落地（issue-003 + 对抗审查）**，详见 `doc/design/2026-08-09-p0-fixes-changes-and-decisions.md`。全部测试绿：gateway 178 / agent-server vitest 267 / eval pytest 42 / python 32；`npm run check` 0。新增工具：`eval/gate_length_escalation.py`（跑批前 length 升级率 <5% 门控）、`eval/snapshot_store.py`（经验库快照）、`eval/tests/test_preflight.py`、`test_alfworld_agent.py`、`python/tests/test_issue002_pipeline_resilience.py`。**待用户拍板**：①issue-003 重跑方案 A/B/C + pilot 校准 max_tokens（800/1024）②issue-002 断点持久化立项/降级 ③P1 批次（M4/M6/M7/M12/M13/M17/M19/M20/M21 等）。
