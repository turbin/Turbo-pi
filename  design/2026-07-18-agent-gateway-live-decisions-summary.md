# Agent Gateway 长期记忆：设计决策与变更总结

**日期：** 2026-07-18
**分支：** `feature/agent-gateway-design`
**提交：** `9605374c`（feat(agent-gateway): complete V1-A01-A03 live verification with Kimi Code）
**目标：** 记录本工程截至目前的所有关键设计决策及其原因，作为后续迭代的长期记忆。

---

## 本次变更内容（2026-07-18）

1. **完成 V1-A01–V1-A03 现场验证**
   - 使用本地 Kimi Code CLI 配置自定义 `openai` provider 指向 gateway（`http://127.0.0.1:8787/v1`），逻辑模型 `agent-auto`。
   - 验证 `kimi doctor`、`kimi provider list` 通过。
   - 验证 `kimi -p "你好，请简短介绍一下自己" -m local/agent-auto` 经 gateway 路由到本地 omlx，返回中文回复，且 `model_runs.provider = "omlx"`。
   - 验证 omlx live baseline：直接 curl `/v1/models`、gateway 非流式中文请求、gateway SSE 流式中文请求均正常。

2. **修复 Kimi Code 兼容性问题：接受 `reasoning_effort`**
   - 修改 `packages/agent-gateway/src/agent_gateway/envelope.py`：在 `ChatCompletionEnvelopeV1` 中显式声明 `reasoning_effort: str | None = None`。
   - 修改 `packages/agent-gateway/src/agent_gateway/tests/unit/test_envelope.py`：新增单测 `test_reasoning_effort_accepted_but_not_forwarded`。
   - 全量测试：160/160 通过（原 159 + 新增 1）。

3. **更新设计文档**
   - `design/2026-07-17-agent-gateway-changes-and-decisions.md`：新增 §3.18 决策记录；更新 §5 验收清单 A01–A03 为完成；更新 §6 后续行动建议划掉已完成的 A01–A03 阻塞项。
   - `design/2026-07-18-agent-gateway-live-verification.md`：追加 Kimi Code 验证、决策记录、遗留项。

---

## 本次变更决策及原因

### D-2026-07-18-01：在 `ChatCompletionEnvelopeV1` 中显式接受 `reasoning_effort`，而非全局放宽 `extra="forbid"`

- **原因**：Kimi Code CLI 默认发送 `reasoning_effort`（来自其 `[thinking]` 配置）。原 `extra="forbid"` 导致网关返回 400 `unsupported_parameter: reasoning_effort`，阻断 A01–A03 验证。显式声明该字段可在不破坏严格合同的前提下兼容主流 OpenAI 客户端，同时继续拒绝真正的未知参数。

### D-2026-07-18-02：不将 `reasoning_effort` 转发到上游 omlx

- **原因**：上游本地 omlx 模型不支持 `reasoning_effort`；转发会导致上游失败。`providers/base.py` 的 `build_chat_request` 仅显式转发已知字段，因此新增 envelope 字段不会自动进入上游请求，行为一致。

### D-2026-07-18-03：Kimi Code 配置使用 `type = "openai"` 自定义 provider

- **原因**：Kimi Code CLI 支持 `openai` provider 类型，可配置任意 `base_url`、`api_key`、`model`。这是完成 V1-A01（客户端探针）的最小侵入方式，无需修改 Kimi Code 源码或打包应用。

### D-2026-07-18-04：保持 `config.toml` 在 `.gitignore` 中，不提交本地 omlx API key

- **原因**：`config.toml` 包含敏感本地配置（如 omlx API key `3675630`），不应进入仓库。现场验证仅依赖本地文件。

---

## 历史关键决策（来自 `2026-07-17-agent-gateway-changes-and-decisions.md`）

| 决策 | 原因 |
| --- | --- |
| 新增独立 Python 包 `packages/agent-gateway/`，不改造既有 TS 包 | 客户端与服务端架构目标不同；TS 包零改动，互不干扰；CI/工具链隔离。 |
| 砍掉 `rules/`、`memory/` 模块（V1） | 计划 §6 明确 V1 不实现规则抽取；目录树列出与实际要求矛盾，按风险表执行。 |
| 通道三元组放进 `[[channels]]` 配置 | `client_id/workspace_id/channel_id` 必须有来源，硬编码无意义。 |
| `api_key_id` = 密钥 SHA-256 截断 | 原始 API key 不写入任何存储/日志，隔离与审计用派生 id。 |
| 状态变更全部 version CAS，网络调用不持事务 | P0-05 合同；保证 trace 可解释并避免长事务阻塞。 |
| `stream` 由 400 改为支持 | Day 4 合同演进：实现延迟 SSE 后更新合同与测试。 |
| SSE 采用延迟回放而非真流式 | 门控需要完整结果才能评估，真流式无法在门控失败后撤回已发内容。 |
| 首字节前失败返回 JSON 错误体 | 一旦发出 SSE 头就无法改状态码；先拉取首个事件再提交头。 |
| 心跳/取消测试用裸 ASGI 驱动 | httpx ASGITransport 缓冲整个响应体，导致测试死锁。 |
| 不引入 `jsonschema`，V1 做最小 schema 校验 | 环境中无此依赖；AGENTS.md 依赖审查规则；V1 仅校验必需属性与顶层类型。 |
| 不单独实现 `deepseek.py` | `kimi.py` 为配置驱动的 OpenAI 兼容适配，selected_cloud_provider 指向谁即可服务谁。 |
| V1 云调用成功按预留全额计费 | 无定价数据来源；`reconcile` 支持部分计费，后续接入定价即可改。 |
| 幂等回放体仅存非流式请求 | 默认不持久化正文（P1-3）；仅当携带 `Idempotency-Key` 时存响应体。 |
| 幂等唯一键 = `(api_key_id, idempotency_key)` | V1 只有一个端点接受该头，endpoint 维度隐含省略。 |
| lease 恢复放在 `create_app` 而非 lifespan | httpx ASGITransport 不跑 lifespan，测试与生产路径会分叉；恢复绝不重新发起 provider 调用。 |
| 入口用 `fcntl.flock` 非阻塞单 worker 锁 | SQLite 单写不变量依赖它；避免多实例并发破坏。 |
| 畸形 JSON → 400 `unsupported_parameter`（param="body"） | 保住稳定错误体合同；避免 500。 |
| received/queued 僵尸 trace 释放幂等键 | 确定未发生 provider 调用，允许重试；leased/run_started 保留键防重复计费。 |
| SSE 升级等待期心跳不中断 | 把云任务包进 `heartbeats_until_done`，保持连接保活。 |

---

## 验收状态（截至 2026-07-18）

| 项 | 状态 |
| --- | --- |
| V1-A01 Kimi Code 探针报告 | ✅ 完成 |
| V1-A02 omlx live baseline | ✅ 完成 |
| V1-A03 Kimi Code 中文请求落地 omlx | ✅ 完成 |
| V1-A04 结构/tool 失败升级单云 | ✅ 单测覆盖；live 未验 |
| V1-A05 SSE 心跳/回放/usage/[DONE] | ✅ 单测覆盖 |
| V1-A06 双 key 隔离、预算不超卖 | ✅ 单测覆盖 |
| V1-A07 幂等重放与 409 | ✅ 单测覆盖 |
| V1-A08 断连取消与槽位释放 | ✅ 单测覆盖 |
| V1-A09 重启 lease 恢复、不重复云调用 | ✅ 单测覆盖 |
| V1-A10 敏感内容不出云/不入库 | ✅ 单测覆盖 |
| V1-A11 脱敏 fixture | 部分 |

---

## 待完成任务（TODO）

1. 用 Kimi Code 客户端复验 tool 调用与超长响应 live（gateway 路径已用直接 HTTP 验证）。
2. 处理 §4 minor 1–4：SSE 首字节后错误事件、keyed stream 幂等重放、预算 reconcile/release CAS、`delivery_status` 更新。
3. 删除 `providers/stub.py`。
4. 添加并行多 tool call SSE delta 回放测试。
5. 环境具备后完成 V1-A04 及以后 live 云升级验证。

---

## 参考 Spec

- `design/2026-07-17-agent-gateway-implementation-plan.md`
- `design/2026-07-14-local-agent-model-gateway-design.md`
- `design/2026-07-14-agent-gateway-team-review.md`
- `design/2026-07-17-agent-gateway-changes-and-decisions.md`
- `design/2026-07-18-agent-gateway-live-verification.md`
