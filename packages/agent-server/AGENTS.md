# AGENTS.md — packages/agent-server

本文件的增量约束覆盖根 AGENTS.md。决策史与设计文档在 `doc/design/`（INDEX.md 是入口）。

## 服务拓扑与启动（评估/学生-老师链路）

| 服务 | 端口 | 启动 | 说明 |
|---|---|---|---|
| omlx 学生模型 | 8000 | oMLX 应用（不可动） | OpenAI 兼容；key 在 `packages/agent-gateway/config.toml`（gitignored） |
| agent-gateway | 8787 | `cd packages/agent-gateway && DEEPSEEK_BASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-v4-flash nohup uv run python -m agent_gateway &` | 质量门控路由：omlx primary → DeepSeek escalation |
| agent-server 评估实例 | 8789 | `PORT=8789 HOST=0.0.0.0 EXPERIENCE_STORE_PATH=./var/eval/experience.db AGENT_SERVER_SESSION_DIR=./var/eval/sessions GATEWAY_URL=http://127.0.0.1:8787 AGENT_GATEWAY_KEY=lobster-local-key nohup ../../scripts/with-node25.sh npx tsx src/start.ts &` | 经验注入；HOST 必须 0.0.0.0（容器访问） |
| DeepSeek 中继 | 8899 | `nohup node eval/deepseek_relay.mjs &` | 控制臂直连等价物（VM→DeepSeek 间歇断流的绕法） |
| 正向代理 | 8898 | `nohup node eval/host_forward_proxy.mjs &` | 容器外网全走宿主；`host.docker.internal`→127.0.0.1 已内置映射 |

- `GATEWAY_URL` 语义：**裸 base 不带 /v1**；`AGENT_GATEWAY_KEY` 对 gateway 是 channel key、对 DeepSeek 直连是 API key（同一变量两种语义）。
- 生产 compose 栈（8788 server + evolution + weekly-report sidecar）`restart: unless-stopped`，colima 重启自动恢复。
- **注入开关**（08-05）：`AGENT_SERVER_INJECTION=off` 关服务级默认；请求级 `injection: true/false`（`/v1/chat/completions` body 或 `/api/stream` 的 `options.injection`）覆盖。关闭时跳过检索+注入但 **session/trace 照常记录**——控制臂必须走 8789 + `injection:false`，不再物理旁路（学习回路要吃全量 trace）。session 里 `experience_injection.disabled=true` 区分“关”与“未命中”。
- **preflight 门禁**（08-05，指纹校验 08-09 M11）：`eval/preflight.py`，所有跑批入口（alfworld_agent/harness/d3_discriminate）启动前必过——按 base-url 端口推导依赖链（8789→8787→8000；8790 同链但强制 AGENT_SERVER_INJECTION=off；8899→relay），探活+nohup 自动拉起自有服务；**存活≠通过**：omlx /v1/models 必须列出模型（`AGENT_EVAL_EXPECTED_OMLX_MODEL` 可精确校验）、agent-server /api/status/chain 必须 self/gateway/omlx 全 ok 且 injection 标志与预期匹配，存疑即 fail。手动体检：`eval/.venv/bin/python eval/preflight.py <base-url>`。
- **Web 监控**（08-05）：`GET /dashboard` 单页面板（链路状态/命中率/日志 tail，5s 自刷）；JSON 接口 `/api/status/chain`（self/gateway/omlx/evolution checkpoint）、`/api/logs?lines=N`（≤1000）。开关：`AGENT_SERVER_WEB=off`（默认 on）关三端点（404），数据 API（hit-rate、evolution/status）常开。日志文件 sink：`AGENT_SERVER_LOG_PATH`（默认 `./var/log/agent-server.log`），stdout 不变。**pkill 批量杀 tsx 会误杀 8789**——杀临时实例用精确 PID（08-05 事故）。

## 长任务/服务进程纪律（血泪教训）

1. **受管后台任务有两个死亡方式**：CLI 会话结束（SIGTERM 全杀）+ 24h 上限。**长跑批（>30min 的 benchmark/进化）和常驻服务一律 nohup**，只把轻量监视器放受管任务。
2. 监视器被杀不影响 nohup 主进程；重启会话后先看 `ps` 再决定是否补跑。
3. **跑批前确认机器不休眠**：`nohup caffeinate -sim &`（08-07 事故：Mac mini 夜间休眠冻结了启动链，进化起跑延迟 7h 且计时漂移）。机器重启后需重挂。
4. Shell 工具启动 nohup 的命令会被 60s 工具超时误报"killed"——实际子进程可能存活也可能被组杀，启动后必须 `ps` 复核（08-05/08-07 两次实例）。

## eval/ 评估环境要点

- 第三方工具全部在 `eval/.venv`（uv），不进系统 Python；大数据/二进制（`alfworld_data/`、`wheelhouse/`、`results/`、`tb_tasks/`）均 gitignored。
- **宿主跑评估前先 `unset HTTPS_PROXY HTTP_PROXY ...`**（PAC 污染环境）；容器内走 8898 代理。
- `.env` 的 key 用 `grep '^DEEPSEEK_API_KEY=' .env | cut -d= -f2 | tr -d '"' | tr -d '\r'` 提取；`set -a; source .env` 对部分条目不可靠。
- colima daemon 代理已配 `192.168.5.2:8898`（重启 colima 需用户确认）；Docker Hub 拉取走 daocloud 镜像 + retag。

## ALFWorld harness（eval/alfworld_agent.py）

- 协议：ReAct 论文 2-shot、49 步、temperature=0；`stop=["\n"]` + `thinking:{type:"disabled"}` 依赖 agent-server 透传（07-30 修复，改动须保持）。
- **蒸馏/reasoning 模型会输出叙述文本而非命令**——`extract_command()` 从叙述中提取动作（行锚定+词边界+最后非 think 优先，08-09 M16 重写）；逐局记录 `extract_failed_steps` 与 `escalations`（x-gateway 标记）；`--max-tokens` 参数化（默认 200——issue-003 根因值，pilot 校准 800/1024）。
- 确定性：游戏顺序 sorted 固定，双臂/多轮逐局对齐；**池上界 = `len(env.game_files)`**——`--games` 超池或 `--expect-pool-size` 不符即硬失败（08-09 C3：shuffled_cycle 回绕重放曾致 20260730 控制臂 17 局 A/B 错位）；`--start N` 用 `env.skip(N)` 推进迭代器（M14）；输出 JSONL append + 按 game_idx 去重（M15）；每条记录带 `pool_size`/`pool_hash`/`init_prompt`。
- 双臂跑法（08-05 起）：基线臂 `--base-url http://127.0.0.1:8789/v1 --injection off`，实验臂同地址 `--injection on`（或省略）——两臂同路径过 agent-server，trace 全落库。
- **跑批前门控（issue-003 回归测试 2）**：`eval/gate_length_escalation.py`——model_runs 全量口径 length 升级率 <5% 才可开全量；pilot 校准先跑冷库 5 局。
- **经验库快照（M10）**：长跑批前 `eval/snapshot_store.py <live.db> <snapshot.db>`，以 `AGENT_SERVER_STORE_SNAPSHOT=<snapshot.db>` 启动/重启评估实例——检索读冻结快照，写入仍走 live 库。

## 进化管线（offline/）

- 输入必须是**任务级轨迹**（一任务一轨迹）。在线 session 是"一请求一文件"，直接喂会爆炸（6372 轨迹 × 25-40 LLM 调用 → 超时/SIGKILL）。正确做法：按局合成干净 session（参考 E5 决策记录 §5 方法）。
- 超时：`AGENT_SERVER_PIPELINE_TIMEOUT_MS`（默认 300s）；报错文本恒附配置值，**不代表真实死因**（外部 SIGKILL 也会显示 timeout）。
- 评估库防泄漏：每轮跑完归档 `var/eval/sessions/` 并清空；进化前重置为干净备份。

## 模型与 prompt 的已知坑

- **chat 微调小模型（gemma-4-12B-it-4bit）对 ReAct 裸 `>` 转录吐 EOS/空输出**（机制与判别实验见根因报告 §4）；agentic 训练模型（Qwen3.5 系列）免疫。
- reasoning 模型（v4-flash 等）默认输出落在 `reasoning_content`——客户端要么传 `thinking:disabled`，要么读 reasoning_content；max_tokens 太小会得到空 content。
- omlx 支持 `stop` 截断（已实证）；多模型换载正常。

## issue 登记

- 用户报告的问题登记 `doc/issues-snapshot/`（流程见根 AGENTS.md「Issue Snapshot」），回归测试放 `test/regressions/issue-NNN-*.test.ts`，推送前随 `./test.sh` 全量验证。首个登记：issue-001（stats/dashboard 命中率 NaN%，snake_case↔camelCase 契约失配）。

## 文档纪律

- 完成任务 → 决策记录（`doc/design/<date>-<topic>-changes-and-decisions.md`）+ INDEX 同步 + progress 更新 + commit（COMPLETED/TODO/Refer Spec 格式，conventional 前缀）。
- 验收不采信文档数字，直查原始数据（JSONL/DB/panes）。
