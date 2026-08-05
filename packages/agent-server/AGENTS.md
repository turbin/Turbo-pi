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

## 长任务/服务进程纪律（血泪教训）

1. **受管后台任务有两个死亡方式**：CLI 会话结束（SIGTERM 全杀）+ 24h 上限。**长跑批（>30min 的 benchmark/进化）和常驻服务一律 nohup**，只把轻量监视器放受管任务。
2. 监视器被杀不影响 nohup 主进程；重启会话后先看 `ps` 再决定是否补跑。

## eval/ 评估环境要点

- 第三方工具全部在 `eval/.venv`（uv），不进系统 Python；大数据/二进制（`alfworld_data/`、`wheelhouse/`、`results/`、`tb_tasks/`）均 gitignored。
- **宿主跑评估前先 `unset HTTPS_PROXY HTTP_PROXY ...`**（PAC 污染环境）；容器内走 8898 代理。
- `.env` 的 key 用 `grep '^DEEPSEEK_API_KEY=' .env | cut -d= -f2 | tr -d '"' | tr -d '\r'` 提取；`set -a; source .env` 对部分条目不可靠。
- colima daemon 代理已配 `192.168.5.2:8898`（重启 colima 需用户确认）；Docker Hub 拉取走 daocloud 镜像 + retag。

## ALFWorld harness（eval/alfworld_agent.py）

- 协议：ReAct 论文 2-shot、49 步、temperature=0；`stop=["\n"]` + `thinking:{type:"disabled"}` 依赖 agent-server 透传（07-30 修复，改动须保持）。
- **蒸馏/reasoning 模型会输出叙述文本而非命令**——`extract_command()` 负责从叙述中提取动作（去 stop 参数、max_tokens=200、`>` 剥离）；改 agent 时保持该函数与 `process_ob` 同时存在（07-04 事故：误删 process_ob 导致 NameError）。
- 确定性：游戏顺序 sorted 固定，双臂/多轮逐局对齐；输出 JSONL append，支持 `--start N` 续跑。

## 进化管线（offline/）

- 输入必须是**任务级轨迹**（一任务一轨迹）。在线 session 是"一请求一文件"，直接喂会爆炸（6372 轨迹 × 25-40 LLM 调用 → 超时/SIGKILL）。正确做法：按局合成干净 session（参考 E5 决策记录 §5 方法）。
- 超时：`AGENT_SERVER_PIPELINE_TIMEOUT_MS`（默认 300s）；报错文本恒附配置值，**不代表真实死因**（外部 SIGKILL 也会显示 timeout）。
- 评估库防泄漏：每轮跑完归档 `var/eval/sessions/` 并清空；进化前重置为干净备份。

## 模型与 prompt 的已知坑

- **chat 微调小模型（gemma-4-12B-it-4bit）对 ReAct 裸 `>` 转录吐 EOS/空输出**（机制与判别实验见根因报告 §4）；agentic 训练模型（Qwen3.5 系列）免疫。
- reasoning 模型（v4-flash 等）默认输出落在 `reasoning_content`——客户端要么传 `thinking:disabled`，要么读 reasoning_content；max_tokens 太小会得到空 content。
- omlx 支持 `stop` 截断（已实证）；多模型换载正常。

## 文档纪律

- 完成任务 → 决策记录（`doc/design/<date>-<topic>-changes-and-decisions.md`）+ INDEX 同步 + progress 更新 + commit（COMPLETED/TODO/Refer Spec 格式，conventional 前缀）。
- 验收不采信文档数字，直查原始数据（JSONL/DB/panes）。
