# Agent Gateway 改造工程方案

**日期：** 2026-07-17  
**分支：** `feature/agent-gateway-design`  
**目标：** 基于 `2026-07-14-local-agent-model-gateway-design.md` 和团队审阅意见，评估在当前 `pi` monorepo 中实现本地 Agent 模型网关的可行性，并给出具体改造方案。

---

## 1. 可行性判断

当前 `pi` 工程是一个 **终端 AI 编码智能体（Agent Client）**，不是模型网关服务端。两者架构目标不同：

| 维度 | 当前 pi 工程 | Agent Gateway 需求 |
| --- | --- | --- |
| 角色 | 客户端 | 服务端 |
| 协议 | 调用上游 OpenAI/Anthropic 等 API | 对外暴露 OpenAI 兼容 API |
| 会话存储 | JSONL 文件 | SQLite + SQLAlchemy + Alembic |
| 路由决策 | 无 | 本地模型优先，可观测硬门控升级云端 |
| 多租户隔离 | 单用户 | 多 API key / 通道三元组 |
| 状态机 | 客户端 agent loop | 服务端 request-level trace 状态机 |

**结论：可以改造，但不能直接复用现有包。** 改造方式是**新增一个独立网关包**，与现有 `coding-agent`、`ai`、`agent` 等包共存，而不是把现有客户端包改成网关。

---

## 2. 改造方案总览

在当前 monorepo 中新建：

```text
packages/agent-gateway/
  pyproject.toml              # Python 包配置
  README.md
  config.example.toml
  src/agent_gateway/
    __init__.py
    main.py                    # FastAPI 应用入口
    config.py                  # TOML 配置加载
    envelope.py                # ChatCompletionEnvelopeV1
    channel.py                 # API key -> ChannelContext 映射
    routing.py                 # 路由与质量门控
    quality.py                 # 可观测硬门控
    sse.py                     # 延迟 SSE 回放
    cancellation.py            # 客户端断连取消
    providers/
      base.py                  # Provider 抽象
      omlx.py                  # 本地 omlx 适配
      kimi.py                  # 云适配
      deepseek.py
    store/
      engine.py                # SQLAlchemy engine/session
      migrations/              # Alembic
      models.py                # ORM：RequestExecution、ModelRun、TraceEvent、BudgetReservation、Feedback、RuleCandidate、RuleVersion
      trace_store.py
      budget_ledger.py
    memory/
      adapter.py               # MemoryIndexAdapter 协议
      local.py                 # SQLite/FTS5 本地实现
      mem0.py                  # mem0 adapter
      unsupported.py           # gbrain unsupported
    rules/
      extraction.py            # LearningPacket -> RuleCandidate
      lint.py                  # 规则 lint
      approval.py              # 审批/回滚
      injection.py             # system context 注入
    security/
      dlp.py                   # 结构化 DLP
      redact.py                # 脱敏
    api/
      admin.py                 # /healthz, /v1/models, internal endpoints
      chat.py                  # /v1/chat/completions
    tests/
      fixtures/                # 脱敏 fake fixtures
      e2e/                     # LobsterAI / omlx live probe
      unit/                    # 门控、路由、状态机、幂等测试
```

---

## 3. 复用与不复用

### 3.1 不复用（必须重写）

| 组件 | 原因 |
| --- | --- |
| `coding-agent` 的 TUI | 网关是无头服务，没有交互界面 |
| `agent` 包的 JSONL session 存储 | 网关需要关系型 trace 状态机 |
| `ai` 包的客户端 provider 调用 | 网关是服务端 adapter，需要 lease/version/取消/预算 |
| 当前 `orchestrator` 包 | 实验性、职责不同（进程编排 vs 模型路由） |

### 3.2 可借鉴思想

| 来源 | 可借鉴内容 |
| --- | --- |
| `packages/ai` | provider adapter 设计、模型清单、错误处理 |
| `packages/agent` | 会话状态机、消息循环、反馈概念 |
| `packages/coding-agent` | 扩展/规则/skills 机制（V1.1 规则学习时参考） |

---

## 4. 实施步骤（按第一周切片）

### 第 1 天：LobsterAI 兼容探针

- 目标：确认 LobsterAI 能否配置任意 Base URL、逻辑模型名、SSE、tool 两轮、稳定关联字段。
- 输出：探针报告，记录 observed capability。
- 代码：
  - 临时 Python 脚本 `probes/lobsterai_probe.py`
  - 脱敏 golden fixtures 保存到 `tests/fixtures/lobsterai/`

### 第 2 天：认证、模型清单、Chat DTO、SQLite 初始化

- 实现：
  - `ChannelContext` 与 API key 映射（内存配置，硬编码或 TOML）
  - `GET /v1/models` 按 `allowed_models` 过滤
  - `POST /v1/chat/completions` 接收 OpenAI 请求，转换为 `ChatCompletionEnvelopeV1`
  - 初始 SQLite schema + Alembic migration
  - `RequestExecution` 状态机：`received -> queued -> leased -> ...`
- 验证：普通非流式请求返回 mock 响应，request trace 可查。

### 第 3 天：本地 omlx 非流式通路 + FakeProvider

- 实现：
  - `OmlxProvider` 调用 `http://127.0.0.1:8000/v1/chat/completions`
  - `FakeProvider` 用于脱敏回归测试
  - 模型结果解析：content、tool_calls、finish_reason、usage
- 验证：普通中文请求通过 `agent-auto` 最终 provider 为 omlx。

### 第 4 天：延迟 SSE + 单 function tool + 工具两轮

- 实现：
  - 延迟 SSE：先等完整本地结果，再按 OpenAI delta 格式回放
  - SSE comment heartbeat 保活
  - `stream_options.include_usage` 支持
  - 单 function tool call 解析与验证
- 验证：客户端收到完整 SSE，`[DONE]` 结束，usage chunk 正确。

### 第 5 天：升级、取消、幂等、隔离、恢复

- 实现：
  - 可观测硬门控：schema invalid、空输出、finish_reason=length、forced tool 未调用
  - 升级至单一云 provider（Kimi 或 DeepSeek）
  - 客户端断连取消排队/上游
  - `Idempotency-Key` 幂等重放
  - 双 API key 隔离
  - 重启后过期 lease 恢复为 abandoned
- 验证：
  - 结构失败升级云端
  - 同幂等 key 同 digest 重放，不同 digest 返回 409
  - 两把 key 不互相读取 trace
  - DB 故障 fail closed

---

## 5. 关键设计落地

### 5.1 请求状态机

```python
class RequestState(str, Enum):
    received = "received"
    queued = "queued"
    leased = "leased"
    run_started = "run_started"
    run_succeeded = "run_succeeded"
    response_started = "response_started"
    response_closed = "response_closed"
    cancelled = "cancelled"
    failed = "failed"
    abandoned = "abandoned"
```

状态变更使用 `version` CAS，网络调用不持有事务。

### 5.2 质量门控

```python
class QualityGate:
    def evaluate(self, result: ModelResult, envelope: ChatCompletionEnvelopeV1) -> GateDecision:
        # 硬门：直接拒绝本地结果
        if result.tool_calls and not validate_tool_arguments(result.tool_calls, envelope.tools):
            return Escalate(reason="invalid_tool_schema")
        if result.finish_reason == "length":
            return Escalate(reason="finish_reason_length")
        if result.content is None and not result.tool_calls:
            return Escalate(reason="empty_output")
        # ...
        return Accept()
```

### 5.3 云 provider adapter

```python
class CloudProvider(Protocol):
    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult: ...
    async def stream(self, envelope: ChatCompletionEnvelopeV1) -> AsyncIterable[StreamChunk]: ...
```

V1 每个请求只选一个 provider，不实现双云 fallback。

### 5.4 预算原子预留

```python
class BudgetLedger:
    async def reserve(self, channel_id: str, period: str, micro_usd: int) -> BudgetReservation:
        ...

    async def reconcile(self, reservation_id: UUID, used_micro_usd: int) -> None:
        ...
```

使用 SQLite 事务和唯一约束防止超卖。

### 5.5 配置示例

```toml
[server]
host = "127.0.0.1"
port = 8787
admin_key_env = "AGW_ADMIN_KEY"
single_worker_lock = "./var/agent-gateway.lock"

[database]
url = "sqlite+aiosqlite:///./var/agent_gateway.db"

[local_omlx]
base_url = "http://127.0.0.1:8000/v1"
model = "gemma-4-12b-it-4bit"
timeout_seconds = 120
concurrency = 1

[cloud.kimi]
enabled = true
base_url_env = "KIMI_BASE_URL"
api_key_env = "KIMI_API_KEY"
model_env = "KIMI_MODEL"

[cloud.deepseek]
enabled = false

[routing]
cloud_egress_default = false
selected_cloud_provider = "kimi"
automatic_transport_retries = 0

[memory_index]
provider = "local"  # disabled | local | mem0 | gbrain
enabled = true
write_async = true
read_timeout_ms = 300
max_hits = 5
```

---

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Python 网关与现有 TS monorepo 工具链不一致 | 使用 `pyproject.toml` + `uv`/pip 独立管理；CI 单独 step |
| LobsterAI 探针失败 | 停止实现，先确定兼容的预置 provider 配置 |
| omlx 并发为 1 导致排队延迟 | 可配置并发槽位，默认 1；先验证正确性再优化 |
| 敏感数据泄露 | 出云前 DLP、DB 权限 0600、默认不持久化正文 |
| 规则学习被 prompt injection 污染 | V1 不实现规则抽取；V1.1 必须 verification + 审批 + 受限 DSL |

---

## 7. 验收检查清单

- [ ] `V1-A01`：LobsterAI 探针报告完成
- [ ] `V1-A02`：omlx `/v1/models`、文本、tool、长响应 live baseline
- [ ] `V1-A03`：LobsterAI 普通中文请求最终 provider 为 omlx
- [ ] `V1-A04`：结构/tool 失败升级单一云 provider
- [ ] `V1-A05`：SSE heartbeat、完整回放、usage chunk、`[DONE]`
- [ ] `V1-A06`：双 key 隔离，预算不超卖
- [ ] `V1-A07`：幂等重放与冲突 409
- [ ] `V1-A08`：断连取消与槽位释放
- [ ] `V1-A09`：重启后 lease 恢复，不重复云调用
- [ ] `V1-A10`：敏感内容不出云、不进 DB/WAL/log
- [ ] `V1-A11`：schema invalid、SSE heartbeat、DLP、budget race、幂等冲突、lease 恢复、跨通道隔离均有脱敏 fixture

---

## 8. 下一步行动

1. 在当前分支 `feature/agent-gateway-design` 下创建 `packages/agent-gateway/` 目录。
2. 初始化 Python 包：`pyproject.toml`、FastAPI 入口、Alembic、初始 schema。
3. 实现 `probes/lobsterai_probe.py` 完成 `V1-R01` 探针。
4. 按第一周切片逐天推进，每完成一天提交一次。

