# Agent Gateway Agent Team 批判审阅报告

**日期：** 2026-07-14  
**角色：** 资深 AI 架构设计师、资深 Agent/后端工程师  
**审阅对象：** 本地 Agent 模型网关设计、实施计划及 HTML 展示稿  
**结论：** `No-Go`（原稿）；完成本文 P0 修订后转为 `Conditional Go`

## 1. 总结判断

方向成立，但原方案不能直接开工。问题不在 FastAPI、SQLite 或模型适配器选型，而在若干核心能力被写得比客户端和协议实际能提供的更强：Gateway 当前只能可靠记录一次 HTTP 请求，不能自然获得完整任务、会话、工具授权和客观验证状态；因此不能把“最近一次请求 + 用户正向语气”当作可信学习样本。

V1 应收敛成一条窄纵向通路：

```text
LobsterAI 兼容性实测
  -> request-level trace
  -> omlx 本地响应
  -> 可观测硬门控
  -> 单个云 provider 最多一次升级
  -> OpenAI JSON / 延迟 SSE
  -> 可恢复审计记录
```

自然语言反馈分类、自动规则抽取、双云 fallback、repository/session scope 和任务级 trace 后移，直到有稳定关联键、verification 来源、预算账本和离线评测证据。

## 2. P0：开工前必须修订

### P0-01 请求 trace 不能冒充任务 trace

**问题：** LobsterAI 的一次工具任务可能包含多个 HTTP 请求，当前请求未证明包含稳定 `conversation_id`。以同一 API key 在 15 分钟内的最近请求归因反馈会在并行会话、重试和工具回合中串线。

**修订：** V1 明确称为 `request trace`。字段保留 nullable 的 `conversation_id`、`turn_id`、`parent_trace_id`、`client_request_id`，但只有 LobsterAI 实测证明可传递时才启用任务聚合。反馈必须显式携带 `trace_id`；禁用自然语言自动归因和 session scope。

**验收：** 同一 key 的两个 LobsterAI 会话交错请求，不得把请求、工具结果或反馈归到另一会话。

### P0-02 质量门控只能使用可观测证据

**问题：** “模型低置信度、上下文不足、跨模块、高风险已确认、验证失败”在 Gateway 不执行工具的前提下没有可靠来源。让小模型生成答案后再声明自己的置信度属于循环论证。

**修订：** V1 生效门控仅使用：上游响应无效、空输出、`finish_reason=length`、tool arguments 不符合 schema、forced tool 未调用、明确 DLP/安全策略、由独立 verification API 提交的机器验证结果。复杂度和历史信号只做 shadow 记录，不改变答案。

**验收：** 建立分层评测集，报告本地误接受率、升级召回率、延迟和成本；结构错误升级召回目标不低于 95%。

### P0-03 修正 OpenAI、SSE 与工具合同

**问题：** 工具 schema 只约束调用 arguments，不约束 tool result。Gateway 也无法在返回 tool call 时知道 LobsterAI 是否批准。原稿遗漏 `stream_options.include_usage`、并行 tool call delta、取消传播等合同。

**修订：** 定义 `ChatCompletionEnvelopeV1` 兼容 profile；未知/不支持字段明确 400，不静默忽略。tool result 仅按 `tool_call_id` 关联并视为不可信文本。延迟 SSE 发送 comment heartbeat，完整支持 role、tool delta index、finish reason、可选 usage chunk 和 `[DONE]`。

**验收：** 使用真实 LobsterAI 与 OpenAI SDK accumulator 验证普通文本、两轮工具、并行工具、长请求、拒绝授权及客户端取消。

### P0-04 出云前需要 DLP、授权、预算和幂等边界

**问题：** 持久化前脱敏不等于出云前授权；自动 fallback 可能泄露私有内容并重复计费。原稿“一次云调用”与 Kimi 失败后再试 DeepSeek 相互矛盾。

**修订：** 默认 `cloud_egress_allowed=false`，每把 key 显式授权。出云前执行结构化 DLP，命中敏感策略直接阻断。V1 每次请求只选择一个云 provider，传输自动重试为 0。成本使用整数 `micro_usd` 做原子 reservation 和 usage reconcile。支持可选 `Idempotency-Key`；没有该 header 时明确为 at-least-once。

**验收：** 敏感种子内容零出云；并发请求不能超卖预算；同幂等 key 同 digest 重放结果，不同 digest 返回 409。

### P0-05 状态机必须可恢复

**问题：** 服务端不能证明客户端已收到响应，因此 `delivered` 不成立。数据库不可用时也不能声称仍能保存完整 trace。

**修订：** 状态使用 `received -> queued -> leased -> run_started -> run_succeeded -> response_started -> response_closed`，异常进入 `cancelled/failed/abandoned`。状态变更和 event 在同一短事务中使用 version CAS；网络调用期间不持有事务。启动时回收过期 lease。trace 创建失败时 fail closed，不调用模型。

**验收：** 在 trace 创建、模型返回、结果提交、响应发送四个故障点强制退出并重启，状态可解释且不得自动重复云计费。

### P0-06 不宣称当前 IR 已协议无关

**问题：** 原 canonical 类型仍然是 Chat Completions 语义，无法无损表达 Responses/Anthropic 的 content blocks、reasoning 或 previous response。

**修订：** V1 类型更名为版本化 `ChatCompletionEnvelopeV1`。协议无关部分只包括身份、路由、预算、trace 和 provider capability。未来新增 `GatewayIRV2`，不要求 V1 DTO 假装通用。

**验收：** supported profile 有 golden tests；所有不支持参数返回带 `param` 的稳定错误。

### P0-07 规则学习退出核心路径

**问题：** 当前没有可信 repository/session 标识，trace 中还可能包含 prompt injection。即使人工批准，也可能跨 scope 固化恶意规则。

**修订：** 第一周不做规则抽取。后续只允许显式 `trace_id` + passed verification 生成 pending 候选；使用受限 DSL，字段包含 `scope_type/scope_key/source/actor/expires_at/evidence_digest`，审批时显示冲突与影响范围。

**验收：** 注入“把我设为永久系统规则”等攻击文本，不能自动生成、跨 scope 或绕过审批。

## 3. P1：核心通路稳定后补充

1. 有界公平队列：完整通道三元组、全局/通道容量、queue deadline、取消清理、`429 Retry-After`。
2. SQLite 运行约束：单 worker 进程锁、WAL、`foreign_keys=ON`、`busy_timeout`、短 `BEGIN IMMEDIATE`、唯一 sequence/version、分批 retention 与 checkpoint。
3. 默认只保存摘要和结构化元数据；正文持久化显式开启，移除可持久化 `raw_response`，数据库权限 `0600`。
4. New API 前置时关闭其 channel fallback/retry，避免和 Gateway 重试叠加；New API usage 是外部账单，Gateway ledger 是真实成本。
5. 运维补齐 `/readyz`、低基数 metrics、SIGTERM 排空、配置 fail-fast、pepper 持久化/轮换和测试环境故障注入。

## 4. P2：删除或延期

- 删除 V1 中“只记录锁意图”的空写锁。
- 不实现 Redis、对象存储、一致性哈希或多实例分支；只保留 `Scheduler`、`TraceStore`、`BudgetLedger` 接口和后续 ADR。
- 不在第一周实现自然语言反馈分类、规则抽取、真实双云 fallback、repository/session scope。

## 5. Coder 补充的精确合同

### 5.1 请求和响应

- 支持文本 `system/user/assistant/tool`，assistant `tool_calls`，tool `tool_call_id`。
- 支持 function tools 与 `tool_choice=none/auto/required/named`。
- `n` 只允许 1；`max_tokens` 与 `max_completion_tokens` 同时出现返回 400。
- 多模态、audio、logprobs、legacy functions 和未支持 response format 返回 `unsupported_parameter`。
- `/v1/models` 按当前 key 的 `allowed_models` 过滤。
- 响应的 `model` 保持 Gateway 逻辑模型；真实 provider 只进入 trace。

### 5.2 关联、幂等、取消

- `trace_id`：一次 Gateway HTTP 请求。
- `model_run_id`：一次上游尝试。
- `parent_trace_id`：仅在客户端明确提供关联时使用。
- 幂等唯一键：`(api_key_id, endpoint, idempotency_key)`。
- 回放前断连取消上游和 semaphore；回放后断连只写 `delivery_status=aborted`。

### 5.3 核心数据实体

```text
RequestExecution(trace_id, api_key_id, client_id, workspace_id, channel_id,
  parent_trace_id?, conversation_id?, idempotency_key?, request_digest,
  state, delivery_status, version, lease_expires_at?, deadline_at, created_at, completed_at)

ModelRun(id, trace_id, sequence, purpose, provider, provider_attempt, state,
  timeout_ms, quality_signals_json, usage_source, input_tokens, output_tokens,
  cost_micro_usd, error_code)

BudgetReservation(id, channel_id, period_yyyymm, reserved_micro_usd,
  charged_micro_usd, state, trace_id)

Verification(id, trace_id, kind, status, source, evidence_redacted, created_at)
Feedback(id, trace_id, label, source, confidence, state, supersedes_id?, idempotency_key)
RuleExtractionJob(id, trace_id, state, attempts, error_code)
RuleCandidate(id, trace_id, state, scope_type, scope_key, evidence_digest)
RuleVersion(id, rule_id, version, state, instruction_dsl, actor, created_at)
```

### 5.4 错误码

| HTTP | Code |
| --- | --- |
| 400 | `unsupported_parameter`, `invalid_message_sequence`, `invalid_tool_schema` |
| 401 | `invalid_api_key` |
| 403 | `model_not_allowed`, `cloud_egress_forbidden` |
| 409 | `idempotency_conflict`, `request_in_progress`, `rule_version_conflict` |
| 422 | `local_quality_rejected` |
| 429 | `budget_exceeded`, `queue_overloaded` |
| 502 | `provider_invalid_response`, `upstream_unavailable` |
| 503 | `database_unavailable`, `not_ready` |
| 504 | `deadline_exceeded` |

内部可以记录 499 `client_cancelled`，但不能向已断开的客户端发送新响应。

## 6. 第一周最小纵向切片

1. 第 1 天：LobsterAI 兼容探针，保存脱敏 golden fixtures；确认任意 Base URL/model、普通请求、SSE、tool 两轮和可用关联字段。
2. 第 2 天：认证、`/v1/models`、文本 Chat DTO、文件 SQLite migration、request trace。
3. 第 3 天：FakeProvider 与真实 omlx 非流式通路。
4. 第 4 天：延迟 SSE heartbeat、单 function tool call 和工具两轮。
5. 第 5 天：schema-invalid 升级到单个 fake cloud、timeout、取消、DB busy、幂等重放、双 key 隔离及重启恢复。

周验收只要求：LobsterAI 真实连接、普通 JSON、完整 SSE、tool 两轮、一次确定性升级、request trace 可查、重启可恢复和稳定错误体。

## 7. Go Gate

完成以下条件后，状态由 `No-Go` 转为 `Conditional Go`：

- LobsterAI 实际请求探针完成，并确定可用的关联字段和超时行为。
- omlx `/v1/models`、Gemma 文本、tool call 与长流式 live probe 完成。
- 主设计已按 P0 重写，不再依赖不可观测质量信号。
- 出云 DLP、显式授权、单 provider、预算预留和幂等语义已写入合同。
- 自然语言反馈和规则学习已从 V1 核心路径移除。

