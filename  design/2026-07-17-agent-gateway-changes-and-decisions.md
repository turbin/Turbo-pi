# Agent Gateway 实施变更与决策记录

**日期：** 2026-07-17
**分支：** `feature/agent-gateway-design`
**依据文档：** `2026-07-17-agent-gateway-implementation-plan.md`（实施计划）、`2026-07-14-agent-gateway-team-review.md`（P0 审阅合同）
**实施方式：** 6 个串行 agent（Day 2–5 实现 ×4、代码评审 ×1、major 修复 ×1），全程 TDD
**最终状态：** `packages/agent-gateway/` 全部新增，159 个测试全部通过（离线），未提交 git

---

## 1. 变更总览

在 pi（TypeScript monorepo，终端 AI 编码智能体）中**新增独立 Python 包** `packages/agent-gateway/`：一个 FastAPI 本地模型网关，对外暴露 OpenAI 兼容 API，请求经 `ChatCompletionEnvelopeV1` 校验、`RequestExecution` 状态机追踪后路由到本地 omlx；本地结果经可观测硬门控评估，失败时在满足出云授权、DLP、预算预留三个前置条件后升级到单一云 provider（仅一次）。

未改动任何既有 TS 包与根配置文件。`git status` 仅显示新增目录 `packages/agent-gateway/`。

技术栈：Python 3.12 + uv（`pyproject.toml` 独立管理，不影响 npm workspace —— `packages/*` glob 跳过无 `package.json` 的目录，biome/tsgo 不处理 `.py`）。依赖：fastapi、uvicorn、sqlalchemy[asyncio]、aiosqlite、alembic、pydantic v2、httpx；dev：pytest、pytest-asyncio。**未新增任何重型依赖**（如 jsonschema，见 §3.10）。

## 2. 文件级变更内容

### 2.1 包配置与入口

| 文件 | 内容 |
| --- | --- |
| `pyproject.toml` / `uv.lock` / `.venv/` | hatchling src-layout；`uv sync` 创建锁定环境 |
| `config.example.toml` | 计划 §5.5 全部小节（server/database/local_omlx/cloud.kimi/cloud.deepseek/routing/memory_index/security）+ `[[channels]]`（key、client_id/workspace_id/channel_id 三元组、allowed_models、cloud_egress_allowed、monthly_budget_micro_usd） |
| `src/agent_gateway/__main__.py` | 进程入口：`--config` 加载 TOML → `fcntl.flock` 获取 `single_worker_lock`（非阻塞，持有则报错退出）→ uvicorn 按 `server.host/port` 启动。运行方式：`uv run python -m agent_gateway --config config.toml` |
| `main.py` | `async create_app(config)` 工厂：engine、迁移到 head、lease 清扫、registry/trace store/provider/预算账本装配、`GatewayError` 统一异常处理、DB 文件 chmod 0600、lifespan 释放资源 |

### 2.2 配置、通道、错误

| 文件 | 内容 |
| --- | --- |
| `config.py` | stdlib `tomllib` + pydantic `extra="forbid"`，未知/缺失字段启动即报错；`local_omlx`（base_url/model/timeout_seconds/concurrency）、`cloud.reserve_micro_usd`（默认 100_000）、`[security]` DLP 正则、通道预算上限 |
| `channel.py` | API key → `ChannelContext`；`api_key_id` 为密钥 SHA-256 截断值，**原始密钥不落地** |
| `errors.py` | 审阅 §5.4 完整 HTTP↔code 表；稳定错误体 `{"error": {code, message, param?}}` |

### 2.3 请求合同

| 文件 | 内容 |
| --- | --- |
| `envelope.py` | `ChatCompletionEnvelopeV1`：判别联合消息（system/user/assistant/tool，tool 必须有 `tool_call_id`）、function tools、`tool_choice` none/auto/required/named、`n` 仅允许 1、`max_tokens`+`max_completion_tokens` 冲突 400、多模态/audio/logprobs/legacy functions/未知字段一律 400 `unsupported_parameter`（带 `param`）；消息序列校验（tool 消息必须紧跟携带对应 `tool_call_id` 的 assistant 消息，否则 400 `invalid_message_sequence`）；`stream`/`stream_options.include_usage`（Day 4 起支持） |
| `api/deps.py` | Bearer 认证（401 `invalid_api_key`）、`get_provider()`/`get_budget_ledger()` 注入缝、pydantic 错误 → §5.4 错误码映射 |

### 2.4 存储与状态机

| 文件 | 内容 |
| --- | --- |
| `store/engine.py` | 异步 engine；每连接设置 WAL、`foreign_keys=ON`、`busy_timeout=5000` |
| `store/models.py` | SQLAlchemy 2.0 类型化映射：`RequestExecution`、`ModelRun`、`BudgetReservation`、`TraceEvent`、`Verification`、`Feedback`（**无 Rule\* 表**） |
| `store/migrations/` | `0001_initial.py`（初始 schema）、`0002_idempotency_replay.py`（`RequestExecution` 增加 `response_status`/`response_body`，幂等索引改为唯一约束）；异步 `env.py` + `migrations_runner` 编程式升级 |
| `statemachine.py` | `RequestState` 十态枚举 + `ALLOWED_TRANSITIONS` 迁移表 |
| `store/trace_store.py` | `create_trace`（失败即 fail closed → 503）；`transition()` 以 `UPDATE ... WHERE version=?` 做 CAS 并与 `TraceEvent` 同一短事务提交；`record_model_run()`；幂等查询/响应存取；`recover_expired_leases()`（启动清扫）；`release_idempotency_key()`（见 §3.16）。**任何网络调用期间不持有 DB 事务** |
| `store/budget_ledger.py` | `reserve`（`BEGIN IMMEDIATE` + 按 (channel, period) 上限校验，并发不超卖）、`reconcile`（按实际用量计费、释放剩余）、`release`（provider 失败释放） |

### 2.5 Provider 层

| 文件 | 内容 |
| --- | --- |
| `providers/base.py` | `Provider` 协议、`ModelResult`（content/tool_calls/finish_reason/tokens）、共享的 OpenAI 请求构造/响应解析纯函数 |
| `providers/omlx.py` | 本地 omlx 适配：httpx 异步客户端 + `asyncio.Semaphore(concurrency)`（默认 1，仅包裹 HTTP 调用）；超时/连接失败 → 502 `upstream_unavailable`，响应畸形 → 502 `provider_invalid_response` |
| `providers/kimi.py` | 云适配：env 读取 base_url/api_key/model，与 omlx 共享解析与错误映射；配置驱动，`routing.selected_cloud_provider` 指向谁就是谁 |
| `providers/fake.py` | 可编排 FakeProvider（结果/异常队列 + 请求记录），回归测试用 |
| `providers/stub.py` | Day 2 遗留的确定性桩，已不被装配（待删除候选） |

### 2.6 路由、门控、安全

| 文件 | 内容 |
| --- | --- |
| `routing.py` | `select_provider()`（V1 每请求单一 provider）+ `select_escalation_provider()`（单一升级目标） |
| `quality.py` | 可观测硬门控（P0-02）：`invalid_tool_schema`（arguments 非 JSON / 不满足声明 schema 的必需属性与顶层类型）、`finish_reason_length`、`empty_output`、`forced_tool_missing` → accept 或 escalate(reason)。**无任何推测性信号参与决策** |
| `security/dlp.py` | 结构化 DLP：扫描消息文本与 tool arguments；默认模式（AWS AKID、PEM 私钥头、api_key 赋值样式）+ 配置 `dlp_patterns`（加载时校验正则合法性）；命中只记录 pattern 名 + 位置，**秘密本身不入库** |
| `security/redact.py` | 脱敏辅助 |

### 2.7 API 与流式

| 文件 | 内容 |
| --- | --- |
| `api/admin.py` | `GET /healthz`；`GET /v1/models` 按当前 key 的 `allowed_models` 过滤 |
| `api/chat.py` | `POST /v1/chat/completions` 全通路：envelope 校验 → 模型授权（403 `model_not_allowed`）→ 幂等检查 → 建 trace → `received→queued→leased→run_started→run_succeeded→response_started→response_closed` → 门控 → （满足出云授权+DLP+预算时）升级一次（ModelRun seq=2, purpose="escalation"）→ OpenAI 形态响应（`model` 保持逻辑模型名、`id`=trace_id）；畸形 JSON body → 400；`GET /internal/traces/{trace_id}` 强制 `api_key_id` 匹配，跨 key 返回 404（不泄露存在性） |
| `sse.py` | 延迟 SSE 回放：等完整本地结果后按 OpenAI chunk 格式回放（role → content → tool_calls delta 带 index/id/type/function → finish → 可选 usage chunk（`choices: []`）→ `[DONE]`）；等待期 SSE comment 心跳；**首字节前 provider 失败返回 JSON 稳定错误体而非半截流** |
| `cancellation.py` | 监听 ASGI `http.disconnect`：取消上游任务、释放 omlx 信号量、trace → `cancelled`、清 lease；内部记 499 `client_cancelled`，不向已断连客户端写响应 |

### 2.8 测试（`tests/unit/`，159 个）

| 文件 | 覆盖 |
| --- | --- |
| `test_config.py` (7) | 配置加载、未知/缺失字段 fail-fast |
| `test_envelope.py` (19) | DTO 合同、400 矩阵、消息序列、stream 参数 |
| `test_api.py` (14) | 认证/授权/models 过滤/畸形 JSON 400/trace 查询 |
| `test_trace_store.py` / `test_store_day5.py` (9) | 建 trace fail-closed、CAS 冲突、迁移、恢复辅助 |
| `test_migration.py` (2) | 迁移 up/down |
| `test_omlx_provider.py` (20) | 请求翻译、响应解析、7 种畸形响应、MockTransport 网络错误、并发信号量 max=1 |
| `test_fake_provider.py` (4) / `test_kimi_provider.py` (7) | provider 行为 |
| `test_chat_pipeline.py` (3) | 中文请求端到端、状态机事件序列、provider 失败 → trace failed |
| `test_sse_streaming.py` (12) | chunk 精确序列、usage chunk 次序、tool delta 字段、心跳先于内容、流式失败 → JSON 错误体、工具两轮 |
| `test_quality.py` (15) | 各门控触发/不触发 |
| `test_escalation.py` (14+1) | 门控升级、422/403/429 边界、ModelRun seq=2、**升级等待期心跳不中断** |
| `test_dlp.py` (7) | 命中阻断出云、秘密不出现在任何表行 |
| `test_budget_ledger.py` (8) | 并发不超卖（5 并发抢 3 额度）、429、reconcile/release |
| `test_idempotency.py` (7) | 同 key 同 digest 重放（仅 1 个 ModelRun）、异 digest 409、在途竞态 409 |
| `test_isolation.py` (1) | 双 key 交错请求、双向 404 |
| `test_cancellation.py` (2) | 断连 → cancelled + 信号量释放（后续请求可完成） |
| `test_lease_recovery.py` (2+2) | 过期 lease → abandoned；**received/queued 超时清扫并释放幂等键后可重试** |
| `test_entrypoint.py` (4) | flock 竞争/释放、缺配置退出码 2、host/port 接线 |

---

## 3. 关键变更决策

### 3.1 新增独立 Python 包，不改造既有 TS 包
客户端与服务端架构目标不同（计划 §1）。TS 包零改动，互不干扰；CI/工具链隔离。

### 3.2 砍掉计划目录树中的 `rules/`、`memory/` 模块
计划 §6 明确"V1 不实现规则抽取"（审阅 P0-07：规则学习退出核心路径），但 §2 目录树仍列出——二者矛盾，按计划自己的风险表执行，目录不建。`memory_index` 配置小节保留但惰性行为。

### 3.3 通道三元组放进 `[[channels]]` 配置
计划只说"API key → ChannelContext 映射（TOML）"，而 `client_id/workspace_id/channel_id` 必须有来源，硬编码无意义 → 逐 key 配置。

### 3.4 `api_key_id` = 密钥 SHA-256 截断
原始 API key 不写入任何存储/日志，隔离与审计用派生 id。

### 3.5 状态变更全部 version CAS，网络调用不持事务
P0-05 合同。CAS 冲突显式抛 `ConcurrencyConflict`；事件与状态同事务，保证 trace 可解释。

### 3.6 `stream` 由 400 改为支持（Day 4 合同更新）
Day 2 按计划"未知即拒"拒绝了 `stream`；Day 4 实现延迟 SSE 后更新合同与对应测试。属计划内演进。

### 3.7 SSE 采用"延迟回放"而非真流式
本地等完整结果再按 OpenAI delta 格式回放（计划 §4 Day 4）：门控需要完整结果才能评估，真流式无法在门控失败后撤回已发内容。等待期用心跳保活。

### 3.8 首字节前失败返回 JSON 错误体
review P0-03 要求稳定错误体；一旦发出 SSE 头就无法改状态码 → `DelayedEventStreamResponse` 先拉取首个事件再提交头。首字节后的失败则中断流（遗留 minor-5）。

### 3.9 心跳/取消测试用裸 ASGI 驱动
httpx `ASGITransport` 会缓冲整个响应体，导致"provider 等客户端观察到输出"的测试死锁 → 用约 30 行 receive/send harness 逐块观察，离线且确定性。

### 3.10 不引入 `jsonschema`，V1 做最小 schema 校验
环境中无此依赖；V1 仅校验必需属性与顶层属性类型（在 `quality.py` 中注明），嵌套/enum/format 不校验。这是功能与依赖安全（AGENTS.md 依赖审查规则）之间的取舍。

### 3.11 不单独实现 `deepseek.py`
`kimi.py` 为配置驱动的 OpenAI 兼容适配，`selected_cloud_provider` 指向 deepseek 时同一模块即可服务；单独文件只是改名。

### 3.12 V1 云调用成功按预留全额计费
无定价数据来源；`reconcile` 支持部分计费并有单测，后续接入定价即可改实际扣费。

### 3.13 幂等回放体仅存非流式请求
默认不持久化正文（P1-3）；仅当请求携带 `Idempotency-Key` 时存响应体用于重放。流式请求只保留在途/冲突保护，完成后重试返回 409（遗留 minor-6）。

### 3.14 幂等唯一键 = `(api_key_id, idempotency_key)`
审阅 §5.2 为 `(api_key_id, endpoint, key)`；V1 只有一个端点接受该头，endpoint 维度隐含省略。

### 3.15 lease 恢复放在 `create_app` 而非 FastAPI lifespan
httpx ASGITransport 不跑 lifespan，测试与生产路径会分叉；`create_app` 本就是 async，服务前完成清扫且**绝不重新发起 provider 调用**（有断言：恢复产生 0 个 ModelRun）。

### 3.16 评审 major 修复决策（第 6 个 agent，全部 TDD）

1. **入口缺失**（README 命令必崩）→ 新增 `__main__.py`；单 worker 用 `fcntl.flock` 非阻塞锁（SQLite 单写不变量依赖它）；默认仅 `./config.toml`，不回退 example（避免误用示例配置启动）。
2. **畸形 JSON → 500** → 捕获 `JSONDecodeError` 映射 400 `unsupported_parameter`（param="body"），保住稳定错误体合同。
3. **`received`/`queued` 僵尸 trace 永久锁死幂等键** → 恢复清扫扩展到"deadline 已过的 received/queued"；仅对这一类（确定未发生 provider 调用）用 `release_idempotency_key` 释放幂等键允许重试；leased/run_started 类保留键（可能已调用上游，防重复计费）。
4. **SSE 升级等待期心跳中断** → `escalate_to_cloud` 拆分为 begin/fail/finish 三段，SSE 路径把云任务同样包进 `heartbeats_until_done`；非流式路径行为不变（组合三段、签名保持）。

### 3.17 TDD 过程中实际捕获的 bug
- `asyncio.wait` 默认 `ALL_COMPLETED` 导致 SSE 断连检测要等满心跳周期 → 改 `FIRST_COMPLETED`。
- watcher 先取消 provider 任务再抛异常，原始 `CancelledError` 掩盖 `ClientDisconnected` 导致 trace 漏标 cancelled → watcher 改为只观察。

---

## 4. 评审结论与遗留清单

评审 agent 复核全部源码与测试并复跑套件，结论：**fix-first**（核心合同真实实现且有测试，4 个 major 需修）。4 个 major 已全部修复并复验（151 → 159 通过）。遗留未修项：

**Minor**
1. 首字节后 provider 失败 → SSE 静默截断（建议终止前发 `data: {"error": ...}` 事件）
2. keyed stream 请求永远无法重放，重试恒 409（建议"终态+无存储体"允许重执行）
3. 预算 `reconcile`/`release` 读改写无 CAS（双击概率低，影响有界）
4. `delivery_status` 只写不更新（断连后应写 `aborted`）
5. `deadline_at` 未用于主动超时、504 `deadline_exceeded` 未启用（当前仅作恢复清扫谓词）
6. 请求侧 400 `invalid_tool_schema` 未启用（坏 tool schema 走 `unsupported_parameter`）
7. （修复后部分缓解）lease 恢复原仅覆盖 leased/run_started

**Nit（摘）**：WAL/SHM 文件未 chmod 0600；DLP 未扫描消息 `name` 字段；`stream_options` 不带 `stream=true` 时静默忽略；命名 `tool_choice` 不校验是否在 `tools` 中声明；空 `messages` 未拒；`routing.cloud_egress_default`/`automatic_transport_retries` 配置解析后未读；API key 比较非常量时间（本机网关可接受）；取消 watcher 任务未 await；手动设置 `connection: keep-alive` 头。

**测试缺口**：并行多 tool call 的 SSE delta 回放（P0-03 点名）、云 provider 超时映射（共享代码，本地已测）。

## 5. 验收清单对照（计划 §7）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| V1-A01 LobsterAI 探针报告 | **blocked** | 环境无 LobsterAI 客户端 |
| V1-A02 omlx live baseline | **blocked** | omlx（127.0.0.1:8000）未运行 |
| V1-A03 LobsterAI 中文请求落地 omlx | **blocked** | 同上；已由 FakeProvider 端到端覆盖等价路径 |
| V1-A04 结构/tool 失败升级单云 | ✅ 单测覆盖 | fake cloud；live 未验 |
| V1-A05 SSE 心跳/回放/usage/[DONE] | ✅ 单测覆盖 | 含升级期心跳 |
| V1-A06 双 key 隔离、预算不超卖 | ✅ 单测覆盖 | 并发竞态实测 |
| V1-A07 幂等重放与 409 | ✅ 单测覆盖 | 含在途竞态、重启后重试 |
| V1-A08 断连取消与槽位释放 | ✅ 单测覆盖 | 双路径（流式/非流式） |
| V1-A09 重启 lease 恢复、不重复云调用 | ✅ 单测覆盖 | 恢复 0 ModelRun 有断言 |
| V1-A10 敏感内容不出云/不入库 | ✅ 单测覆盖 | DLP 阻断 + 全表扫描断言秘密不落盘；WAL/SHM 权限为 nit |
| V1-A11 脱敏 fixture | 部分 | 以 FakeProvider/单测替代 fixture 文件，`tests/fixtures/` 未建 |

## 6. 后续行动建议

1. 环境具备后补 Day 1：LobsterAI 探针 + omlx live baseline（解除 A01–A03 阻塞）。
2. 处理 §4 minor 1–4（SSE 错误事件、keyed stream 重放、预算关闭 CAS、delivery_status）。
3. 删除 `providers/stub.py`（Day 2 遗留桩，已无引用）。
4. 并行 tool call SSE 回放补测试。
5. 用户确认后提交：`feat(agent-gateway): ...`（遵循仓库 commit 规范，仅 stage `packages/agent-gateway/`）。
