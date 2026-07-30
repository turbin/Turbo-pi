# Agent Server 经验重放工程规格（方案 C）

**日期：** 2026-07-18
**分支：** `feature/agent-gateway-design`
**来源：** `doc/design/HANDOFF.md`、`doc/design/SPEC.md`（原 v1.0 方案）、用户决策（方案 C）
**目标：** 在现有 Python agent-gateway（模型路由层）之上，新增 TypeScript agent-server（经验代理层），实现"小模型 + 外挂知识库 + 大模型经验"的在线重放与离线进化闭环。

---

## 1. 方案决策

采用 **方案 C：混合方案（TS server + Python gateway 分层）**。

- **TypeScript agent-server**（新增包 `packages/agent-server`）：经验代理层，对外提供 `/api/stream`（对齐 SPEC 协议），负责检索注入、轨迹落盘、离线进化调度。
- **Python agent-gateway**（现有包 `packages/agent-gateway`）：模型路由层，负责 omlx/DeepSeek 调用、质量门控、DLP、预算、幂等、SSE 回放。
- **client**：pi-coding-agent 或任意 OpenAI 兼容客户端，通过 `streamFn` 或直接 HTTP 连接 TS agent-server。

分层理由：
- 经验与模型路由解耦，各自独立演进。
- 保留 Python gateway 已验证的 167 个测试与全部 V1 功能。
- TS server 严格对齐 SPEC 协议，为未来多 client 提供统一入口。

---

## 2. 系统架构

```
agent client (pi/任意)
      │ POST /api/stream
      ▼
┌──────────────────────────────┐
│  TypeScript agent-server     │  ← 经验代理层
│  - /api/stream               │
│  - 检索 + 注入                │
│  - session JSONL 落盘         │
│  - 离线 cron 调度             │
└────────────┬─────────────────┘
             │ internal call
             ▼
┌──────────────────────────────┐
│  Python agent-gateway        │  ← 模型路由层
│  - /v1/chat/completions      │
│  - omlx / DeepSeek provider  │
│  - 质量门控 / DLP / 预算 / 幂等 │
│  - SSE 回放 / 状态机          │
└────────────┬─────────────────┘
             │ OpenAI 兼容
             ▼
       omlx (local) / DeepSeek (cloud)
             ▲
             │ offline extraction
       ┌─────┴─────────────────┐
       │ 大模型 (teacher)       │
       │ 经验抽取 / 验证 / 规范化 │
       └───────────────────────┘
```

---

## 3. 模块划分

### 3.1 TypeScript agent-server（新增 `packages/agent-server`）

| 模块 | 功能 | 对应 SPEC |
|---|---|---|
| `src/server.ts` | HTTP server，暴露 `/api/stream` | §5.1 |
| `src/proxy-handler.ts` | 请求处理管线：检索 → 注入 → 转发 → toolCall 校验 → 落盘 | §5.2 |
| `src/experience-store.ts` | SQLite + FTS5：experiences/edges/sop_reviews/canonical_units/reasoning_cache/checkpoints | §3.2 |
| `src/retrieval.ts` | FTS bm25 + 词袋余弦重排（中文简易分词） | §3.3 |
| `src/injection.ts` | 三段式 prompt、skill catalog、SOP schema、Guard 校验 | §4.1/4.2/5.2 |
| `src/etl.ts` | session JSONL → EVIDENCE 候选入库 | §3.4 |
| `src/session-writer.ts` | 自定义 JSONL 事件落盘（P0）；pi 格式对齐在 P1 | §3.4/§5.2 |
| `src/openai-compat.ts` | OpenAI 兼容消息映射（复用 `packages/ai`） | §5.3 |
| `src/gateway-client.ts` | 调用 Python gateway `/v1/chat/completions` 的客户端 | 内部接口 |
| `src/offline/` | 离线进化：EvolutionRunner、SopLifecycle、select_experiences、canonicalize | §4/§6 |
| `src/config.ts` | TOML 配置：server、experience_store、gateway、teacher_model 等 | 工程需求 |

### 3.2 Python agent-gateway（现有 `packages/agent-gateway`）

保持现状，不新增业务功能。可选增强：
- `GET /internal/traces/{trace_id}` 已存在，供 TS server 查询轨迹。
- 如需共享幂等键或 trace 状态，可增加一个轻量内部接口。

---

## 4. 接口协议

### 4.1 对外：`POST /api/stream`

对齐 `packages/agent/src/proxy.ts` 协议：

**Request:**
```json
{
  "model": { "id": "gemma-4-12B-it-4bit", "api": "openai-completions", "provider": "local", "baseUrl": "http://127.0.0.1:8367/v1" },
  "context": {
    "systemPrompt": "You are helpful.",
    "messages": [ { "role": "user", "content": "..." } ],
    "tools": [ ... ]
  },
  "options": { "temperature": 0.2, "maxTokens": 128, "sessionId": "..." }
}
```

**Response:** `text/event-stream`，事件序列：
`start → (text|thinking|toolcall)_(start|delta|end)* → done | error`

`done` 携带 `reason ∈ {stop, length, toolUse}` + `usage`；`error` 携带 `reason ∈ {aborted, error}` + `errorMessage`。

### 4.2 对内：TS server → Python gateway

TS server 将注入后的 context 转换为 OpenAI 兼容请求，POST 到 Python gateway 的 `/v1/chat/completions`（stream 或非 stream）。

### 4.3 离线：TS server → 大模型（teacher）

通过 `TEACHER_MODEL` 环境变量配置，使用 OpenAI 兼容端点。TS server 的离线模块复用 handoff 中三个 impl 包的代码逻辑（`skill_evolution`、`evidence_replay`、`verification_selection`）。

---

## 5. 数据流

### 5.1 在线重放（每请求）

1. client 发送 `/api/stream` 请求。
2. TS server 解析 `context.messages`，取最后一条 user 消息为 query。
3. 检索 Experience Store：FTS bm25 top-24 → 余弦重排 top-8；命中 ABILITY/EVIDENCE。
4. 组装注入：
   - SKILL catalog → `systemPrompt` 追加 `<available_skills>`。
   - SOP schema → `tools` 数组平铺（≤15）。
   - 证据池/Method/Guard → 新 user 消息，插在最后一条真实 user 之前。
5. 转发给 Python gateway（或直连 omlx/DeepSeek）。
6. 流式事件透传回 client。
7. 流末 toolCall 出站校验：length 整批拒绝、schema 校验、Guard 钩子。
8. 全量落盘 session JSONL（请求 + 事件流 + 注入记录）。

> **格式说明：** P0 落盘为自定义 JSONL 事件流（`{type: request|response_started|event|response_completed|error|aborted, data: {...}}`），便于 agent-server 内部 ETL 与离线进化消费。如需与 pi 原生 session 格式互操作（pi session-manager 回放），P1 应添加格式对齐或 adapter。

### 5.2 离线进化（cron）

每日一次或手动触发：
1. ETL：session JSONL → EVIDENCE 候选（dormant）。
2. 三管线抽取（teacher 大模型）：MetaSkill-Evolve、EvoSOP、ExperienceCard。
3. verifier 筛选：quality ≥ 0.5 才 active。
4. canonicalize：TF-IDF blocking + 五 rubric 裁决。
5. 入库：active 集更新、checkpoint 写入。

---

## 6. Experience Store Schema（SQLite）

复用 SPEC §3.2 的 7 表 DDL：
- `experiences`（id, type, title, payload, quality, status, branch_path, times_selected, source_session, source_entry_id, content_hash, created_at）
- `experiences_fts`（FTS5）
- `edges`（src_id, dst_id, kind）
- `sop_reviews`
- `canonical_units` / `unit_members`
- `reasoning_cache`
- `checkpoints`

---

## 7. 测试策略

- **单元测试（vitest）**：每个 TS 模块独立测试，不依赖外部模型。
- **集成测试**：TS server → Python gateway 的端到端请求（用 FakeProvider 或 mock gateway）。
- **live 验证**：Kimi Code / curl 经 TS server 到 omlx/DeepSeek，检查注入记录与落盘 JSONL。
- **离线测试**：用 mock teacher 验证三管线抽取与 canonicalize。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| TS-Python 状态同步复杂 | 最小化共享状态；trace 通过 trace_id 关联；幂等键由 Python gateway 管理 |
| 两套测试体系维护 | 分层测试：TS 单元测试 + Python 单元测试 + 少量端到端 |
| 注入膨胀 | 硬上限：SOP ≤15、证据池 max_pool_chars、skill catalog 渐进披露 |
| 小模型 uptake 差异 | benchmark 诊断表定位 encoding/routing/uptake；按 role 差异化注入 |

---

## 9. 后续 V1.1 范围（与 V1.2 分开）

V1.1 先实现 **P0：streamFn 代理 + 证据重放**（SPEC §8 P0）：
- TS server `/api/stream` 基础管线
- EVIDENCE 检索注入（TF-IDF）
- session JSONL 落盘
- toolCall 出站校验
- mock benchmark 验证

V1.2 再实现 P1–P3：skill 进化、verifier 筛选、meta-skill slow loop。

---

## 10. 参考 Spec

- `doc/design/HANDOFF.md`
- `doc/design/SPEC.md`（原 v1.0）
- `doc/design/2026-07-17-agent-gateway-implementation-plan.md`
- `doc/design/2026-07-17-agent-gateway-changes-and-decisions.md`

---

## 附录：Live E2E 验证记录（2026-07-19）

### 验证目标

验证 Kimi Code CLI 经 agent-server 到 Python gateway 再到 omlx/DeepSeek 的完整链路，包括检索注入与 session 落盘。

### 验证方法

1. 启动 agent-server（端口 8788）：`npx tsx src/start.ts`。
2. 配置 Kimi Code 使用 `local:agent-server` provider（`base_url=http://127.0.0.1:8788/v1`）。
3. 发送测试请求：
   - `kimi -p "你好" -m local/agent-auto-server`（基础链路）
   - `kimi -p "量子计算是什么" -m local/agent-auto-server`（EVIDENCE 注入）
   - `kimi -p "如何写好测试" -m local/agent-auto-server`（Method 注入）
   - `kimi -p "密钥怎么保存" -m local/agent-auto-server`（Guard 注入）
4. 检查 agent-server 日志与 session JSONL 中的 `retrieved` 字段。

### 验证结果

| 请求 | retrieved | 注入内容 | 结果 |
|---|---|---|---|
| 你好 | `[]` | 无 | ✅ 正常响应 |
| 量子计算是什么 | `[exp-quantum-1, exp-quantum-2]` | EVIDENCE 量子计算基础/特性 | ✅ 响应包含量子计算解释 |
| 如何写好测试 | `[exp-method-1, exp-quantum-2]` | Method 先写测试 | ✅ 响应包含 TDD 相关内容 |
| 密钥怎么保存 | `[exp-guard-1]` | Guard 密钥安全 | ✅ 响应包含密钥管理建议 |

### 发现的问题与修复

1. **Kimi Code 消息格式**：Kimi Code 发送的 messages 中，user content 可能是数组格式（text 块），system 消息可能被遗漏，tools 是 OpenAI 格式。修复：在 `/v1/chat/completions` 端点中统一归一化 content 和 tools。
2. **system-reminder 干扰**：Kimi Code 会在 user 消息中插入 `<system-reminder>` 插件提示，导致检索 query 错误。修复：在 query 提取时过滤以 `<system-reminder>` 开头的消息。
3. **stream 响应格式**：Kimi Code 期望 OpenAI SSE 格式，而 agent-server 内部使用 pi-ai 事件格式。修复：stream=true 时直接透传 gateway 的 OpenAI SSE，不经过 pi-ai 转换。
4. **CJK FTS 召回**：FTS5 unicode61 不分割 CJK，导致中文检索召回差。修复：索引时将 CJK 文本分割为单字和 bigram。

### 后续 TODO

- P1：skill catalog / SOP schema 注入、离线进化、verifier 筛选。
- 对齐 session JSONL 与 pi 原生格式。
- 处理 review 发现的 minor 问题（cancel-path unhandled rejection、request-body validation）。
