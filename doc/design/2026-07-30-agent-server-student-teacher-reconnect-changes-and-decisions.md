# Agent-Server：学生-老师链路接回（agent-server → agent-gateway → omlx + DeepSeek 升级）——变更与决策记录

日期：2026-07-30
SPEC：`doc/design/2026-07-14-local-agent-model-gateway-design.md`（学生-老师架构唯一规范源）
上游：`doc/design/2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md`（E 改道）
状态：**已立项（用户 07-30 拍板选 B），执行中**

---

## 1. 背景与决策

E2' ALFWorld A/B 运行中发现：omlx 学生模型（127.0.0.1:8000，自 07-22 在线）**零负荷**——8788/8789 均经 `.env`/启动 env 把 `GATEWAY_URL` 直连 DeepSeek（N2 收尾上线决策），agent-gateway(8787) 未运行。用户拍板：**选 B——接回学生链路，恢复 v1"学生优先 + 老师升级"架构**。

| # | 决策 | 理由 |
|---|---|---|
| R-D1 | 接回链路以**配置为主**：gateway config.toml 开 DeepSeek 云 + channel 出云；agent-server 仅改启动 env | 代码默认本就是 `GATEWAY_URL=127.0.0.1:8787`（server.ts:38）；DeepSeek 作升级 target 是纯配置（providers/kimi.py 通用 adapter）；当初弃用 gateway 只因离线 logprobs（离线管线走 LLM_BASE_URL 直连，不受影响），链路本身 07-22/23 两次 live 验证 PASS |
| R-D2 | **三腿对照实验设计**（修改变量混淆） | 若控制臂直连 DeepSeek、实验臂走学生管线，会混淆"模型管线 × 经验注入"两变量。正解：L1=直连 DeepSeek（teacher 参考，ALFWorld control-full 已在跑）；**L2=8787→omlx(+升级)（新控制臂）**；**L3=8789(注入)→8787→omlx(+升级)（实验臂）**。L2 vs L3 测注入（判据①），L1 为天花板参考，飞轮（E5）走 L3 |
| R-D3 | gateway envelope 显式接受 `thinking` 字段：本地路径丢弃、升级云时透传 | ALFWorld 客户端必发 `thinking:{type:"disabled"}`（v4-flash reasoning 模式 content 为空，07-30 已实证）；envelope `extra="forbid"` 会 400。按 R04 精神：显式声明字段并文档化行为，非静默丢弃 |
| R-D4 | omlx 双探针先行，全部通过 | key 有效（config.toml:18）；`stop:["\n"]` 正确截断（content='1'，finish=stop）——ReAct 协议保真度在学生侧成立 |
| R-D5 | 学生模型暂维持 `gemma-4-12B-it-4bit`；备选 `Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit` 记录不动 | omlx /v1/models 实查三模型在线。若 L2 SR 趋零致无区分度，再立项换型（判据按相对差解读） |
| R-D6 | 生产 8788 接回**推迟**（S7 可选项） | 先在评估环境验证学生管线质量，再动生产；生产接回需 gateway `host=0.0.0.0`（容器→宿主 127.0.0.1 不通，E2 D2 已证） |

## 2. 改造清单

### agent-gateway（packages/agent-gateway）

| 项 | 文件 | 改动 |
|---|---|---|
| 配置 | `config.toml`（gitignored） | `[cloud.deepseek] enabled=true` + base_url/api_key/model env 名；`routing.selected_cloud_provider="deepseek"`；`lobster-local-key` channel `cloud_egress_allowed=true`、`allowed_models` 补 `deepseek-v4-flash` |
| 代码（R-D3） | `src/agent_gateway/envelope.py`、`providers/base.py`、`api/chat.py` | envelope 加 `thinking` 字段；本地构建请求时丢弃；升级云时透传 |
| 测试 | `src/agent_gateway/tests/unit/` | thinking：envelope 接受、本地不转发、云透传，3 用例 |
| 启动 | — | `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 DEEPSEEK_API_KEY=<key> DEEPSEEK_MODEL=deepseek-v4-flash uv run python -m agent_gateway` |

### agent-server（零代码）

- 8789 重启：`GATEWAY_URL=http://127.0.0.1:8787 AGENT_GATEWAY_KEY=lobster-local-key`（其余 env 不变）

### ALFWorld 运行调整

- 停止 chained 任务中旧语义的 experiment-full（直连腿作废）；control-full（=L1）继续/续跑
- L1 完成后依次跑 L2（8787）、L3（8789）；L3 session 归档纪律不变

## 3. 验证记录

- 2026-07-30 S2 探针：omlx `/v1/models` 三模型（gemma-4-12B-it-4bit / Qwen3.5-27B-…-Distilled / Qwen3-ASR）；`stop` 探针 content='1' finish=stop 通过
- 2026-07-30 S3 gateway：thinking 三用例 + **169 pytest 全绿**；config.toml 开 DeepSeek 云（enabled + env 名）+ routing 选 deepseek + lobster channel 出云/模型名放行；启动后三验证全过——①healthz OK ②本地应答（gemma 中文 1+1）③**升级链路实证**：max_tokens=1 强制 finish_reason=length → model_runs sequence=1 omlx（门控 `finish_reason_length`）→ sequence=2 purpose=escalation provider=deepseek succeeded；另实测 gemma 能正确发起 forced tool call（未触发升级，学生合格）
- 2026-07-30 S4 8789 重启（GATEWAY_URL=127.0.0.1:8787 + lobster-local-key）：全链路 curl `stop=["\n"]+thinking=disabled` → content='1' finish=stop 通过；session 落盘正常

## 4. 已知限制

1. gateway stream 为延迟回放（上游非流式拿全量后回放）——评估客户端非流式为主，无影响
2. 升级响应丢 `reasoning_content`——客户端已 thinking=disabled，无 reasoning 产生
3. DLP 命中密钥样例会 403（by design）
4. 离线进化管线**不走 gateway**（需 logprobs，走 LLM_BASE_URL 直连 DeepSeek，不变）

Refer Spec：`doc/design/2026-07-14-local-agent-model-gateway-design.md`；`doc/design/2026-07-24-agent-server-n2-closeout-deepseek-teacher-changes-and-decisions.md`（改直连的原始决策，本记录部分修正）；`doc/design/2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md`
