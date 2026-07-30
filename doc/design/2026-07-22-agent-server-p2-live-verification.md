# Agent-Server P2 现场验证记录（流式 session 落盘 + custom_message + dormant 闭环 + benchmark 接线）

**日期：** 2026-07-22
**目标：** P2 Task 8 — live E2E 验证 P2 四项功能改动（Task 3/4/5/6）与两项清理（Task 1 debug dump 开关、gateway-client dump 开关）
**环境：** macOS arm64，Node v25.9.0（Homebrew）；omlx 运行中（127.0.0.1:8000，api_key 受控，模型 gemma-4-12B-it-4bit）；agent-gateway（127.0.0.1:8787，本次新建 config.toml：local_omlx 指向 8000，cloud 全部 disabled，channel key `lobster-local-key`）；agent-server（127.0.0.1:8788）；Kimi Code CLI 新增 provider `local`（type `openai_legacy`）→ `http://127.0.0.1:8788/v1`

---

## 检查项总览

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 非流式请求 200，最终 provider 为 omlx | PASS |
| 2 | debug dump 默认关闭：`/tmp/agent-server-request.json` 不写、`/tmp/gateway-request.json` 不更新 | PASS |
| 3 | 非流式 session JSONL：`custom_message` 含注入后上下文（Extra Info 证据块 + systemPrompt 内 skill catalog + get_time SOP tool） | PASS |
| 4 | Kimi Code 流式端到端（`kimi -p "帮我 review 代码" -m local/agent-auto-server`） | PASS |
| 5 | 流式 session JSONL 完整落盘：header/messages/experience_injection/custom_message/stream_event/重建 assistant message/response_completed，parentId 链完整 | PASS |
| 6 | pi 原生 `JsonlSessionStorage` 读回流式 session 文件 | PASS（PI_READ_OK） |
| 7 | 离线 evolution（AGENT_SERVER_BENCHMARK 接入）：ETL 17 条 → pipeline skills:1（benchmark 生效，不再空转）→ dormant rescore 17 条全部评分 → 晋升 17 → checkpoint 统计完整 | PASS |
| 8 | gateway 侧 model_runs 全部 omlx/succeeded | PASS |

---

## 1. 环境搭建（与 P1 的差异）

- P1 的 omlx 在 8367 且无鉴权；本机当前 omlx 托管实例在 8000 且要求 api_key（`~/.omlx/settings.json`），模型目录 `/Volumes/extern-1t-x5/models` 含 `gemma-4-12B-it-4bit`。
- `packages/agent-gateway/config.toml` 由 config.example.toml 生成（gitignored runtime 配置）：local_omlx → 8000 + api_key，`cloud.kimi`/`cloud.deepseek` disabled（本次只验证本地路由），channel key 改为 `lobster-local-key`（GatewayClient 默认 key）。
- Kimi CLI provider type 必须是 `openai_legacy`（`openai` 不是合法枚举值，首次尝试被 pydantic 拒绝）。

## 2. 在线路径验证

非流式 curl（量子计算问答）返回 200 + 中文回复；session JSONL 12 个条目，`custom_message` 记录 2 条消息（合成证据块消息 + 原 user 消息）、systemPrompt 含 `<available_skills>`、tools 含 `get_time`。

Kimi 流式请求返回正常中文回复；对应 session 文件 `var/sessions/1784707649581-….jsonl`：

```text
session ×1 / message ×3（system+user+assistant）/ experience_injection ×1（retrieved: skill-code-review）
custom_message ×1（skill catalog 在 systemPrompt，tools 17 个 = Kimi 16 + get_time）
stream_event ×3 / response_started ×1 / response_completed ×1
assistant message content 与模型实际回复一致；parentId 链完整
```

pi 读回：`JsonlSessionStorage.open` + `getPathToRoot(leaf)` 成功解析全部条目，输出 PI_READ_OK。

## 3. 离线 evolution 验证（MockLLM）

`AGENT_SERVER_BENCHMARK=benchmark/benchmark.example.json` 跑一次 `runDailyEvolution`（一次性 tsx 脚本，已删）：

```text
checkpoint: ckpt-f7c1fa476539eb98  metric: 21
snapshot: {"etlInserted":17,"pipeline":{"skills":1,"sops":0,"cards":3},
           "promoted":4,"rescored":17,"promotedFromDormant":17,"removedDormant":0}
```

- `etlInserted:17` — 流式落盘的 session（含 Kimi 会话）被 ETL 正常消费，关闭 P1 遗留"流式路径无训练数据"缺口。
- `pipeline.skills:1` — benchmark 透传生效，skill 管线不再恒输出 `[]`（example benchmark，2 samples / 3 iterations，MockLLM）。
- `rescored:17 / promotedFromDormant:17` — dormant 重评分闭环跑通（MockLLM 打分普遍过阈值属预期，证明链路而非评分质量）；metric 21 = promoted 4 + promotedFromDormant 17，口径与 Task 6 决策一致。
- `removedDormant:0` — 清理 stage 正常运行（行均新建，未达 TTL）。

## 4. 决策记录

1. **cloud provider 全部 disabled**：本次验证目标是本地链路与 P2 功能，避免任何云端 egress 与成本；配置为 runtime 文件不入库。
2. **Kimi provider type 用 `openai_legacy`**：agent-server 说 chat completions 协议；`openai_responses` 是 Responses API，不适用。
3. **seed 采用重置后重 seed**（同 P1 决策）：var/experience.db 是 gitignored runtime 数据。
4. **验证用一次性脚本落 /tmp 用后删除**（仓库规约）。
5. **config.toml / var/ 不入库**：均为 runtime 产物；验证完成后本次启动的 agent-server 与 gateway 进程已关闭。

## 5. 遗留

- 真实 LLM 打分路径（OpenAICompatClient）未 live 验证（无 LLM_BASE_URL 环境）；Task 7 已修复其构造参数 bug，路径由代码审查与单测覆盖。
- TTL/cap 清理未 live 触发（无超龄 dormant 行），行为由单测覆盖。
- `~/.kimi/config.toml` 新增的 `local` provider 与 `local/agent-auto-server` model 留在用户配置中，便于后续复用。
