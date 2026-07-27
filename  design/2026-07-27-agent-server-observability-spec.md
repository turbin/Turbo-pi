# Agent-Server O：经验命中率可观测 + 请求级 trace —— SPEC

日期：2026-07-27
状态：**已立项（2026-07-27 用户指示，按保守方式实现）**
上游：观察期需要量化"本地经验库到底有没有被用上"——这是 replay 机制评估（` design/2026-07-25-agent-server-eval-report-design.md` L3 层）的数据基础。

---

## 0. 术语约定（先对齐，防歧义）

| 术语 | 本 SPEC 定义 |
|---|---|
| **本地** | 本地经验库（experience.db 中的 ABILITY/EVIDENCE/SKILL/SOP 注入内容）。当前架构**没有**本地 LLM（omlx 已退出数据面） |
| **远程大模型** | 上游 LLM 端点（当前 DeepSeek，经 GATEWAY_URL） |
| **命中（hit）** | 一次请求的经验检索 `retrieve()` 返回 ≥1 条并被注入（`experience_injection.retrieved` 非空） |
| **命中率** | 命中请求数 / 总请求数（可按时间窗、按经验 type/role 细分） |
| **request id** | 单次 `/v1/chat/completions` 请求的唯一标识，贯穿日志、session、trace 记录 |

## 1. 需求

### R1 可观测点（命中率统计）

每请求落一条 trace（**观测点 ① 检索后**、**观测点 ② 完成时**），字段：

```
request_traces(
  request_id TEXT PRIMARY KEY,   -- 请求 id
  ts TEXT NOT NULL,              -- ISO 时间
  model TEXT NOT NULL,           -- 客户端声明的模型
  stream INTEGER NOT NULL,       -- 0/1
  retrieved_count INTEGER NOT NULL,
  retrieved_ids TEXT NOT NULL,   -- JSON string[]：本地经验 id
  retrieved_kinds TEXT NOT NULL, -- JSON string[]："TYPE:role" 形如 "ABILITY:Method"
  hit INTEGER NOT NULL,          -- retrieved_count > 0
  finish_reason TEXT,            -- stop/tool_calls/length/error
  prompt_tokens INTEGER, completion_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT
)
```

存储：**复用 experience.db**（`initSchema` 增 `CREATE TABLE IF NOT EXISTS`，向后兼容老库），不新建文件、不加依赖。

### R2 Web 页面

- `GET /api/stats/hit-rate?window_hours=N`（默认 24）→ JSON：
  `{ window_hours, total, hits, hit_rate, by_kind: [{kind, cnt}], daily: [{day, total, hits}], recent: [{request_id, ts, model, hit, retrieved_count, latency_ms} ×20] }`
- `GET /stats` → **无框架静态 HTML**（内联 JS fetch 上述 API，表格 + 文本条形图；零构建零依赖，conservative）；命中行下方显示该请求注入的经验 id 列表（follow-up 增强）。

### R3 请求级 trace 日志

stdout 结构化日志行（容器 `docker compose logs` 直接可读），格式：

```
[agent-server] req=<id> phase=retrieval hit=1 retrieved=8 kinds=证据×1,方法×7 injected="<前 3 条经验标题> 等N条" query_len=42
[agent-server] req=<id> phase=forward model=deepseek-v4-pro stream=1
[agent-server] req=<id> phase=done finish=tool_calls tokens=812/132 latency_ms=3410
[agent-server] req=<id> phase=error message="..."
```

- `kinds=`：中文类别汇总（映射：`ABILITY:Method`→方法、`ABILITY:Guard`→护栏、`EVIDENCE:null`→证据、`EVIDENCE:Workflow`→工作流、`SKILL:null`→技能、`SOP:null`→SOP；未知 kind 原样输出）；
- `injected=`：本地经验库实际注入条目的标题（前 3 条 + 等 N 条），使命中行可读地呈现"本地返回了什么"；
- 中文标签与 injected 字段为 2026-07-27 用户反馈后的 follow-up 增强（决策记录 §6）。

**本地/远程区分规则**：`phase=retrieval` 行（kinds/injected）即"本地经验库返回的内容"；`phase=done` 的响应内容一律来自"远程大模型生成"。session JSONL 中已有 `experience_injection` / `custom_message`（注入上下文）与 assistant message（远程生成）的区分，request id 把三者串起来：
- session header `metadata.requestId` 写入；
- 响应头 `x-request-id` 返回给客户端。

### R4 request id 生成

复用 Fastify 内建 `request.id`（默认单调递增 req-1, req-2…；容器内唯一够用）。**不引入 uuid 依赖**（保守）；跨重启唯一性由 trace 表的 ts 列兜底。

## 2. 实现方案（保守：~150 行 + 测试）

| 文件 | 变更 |
|---|---|
| `src/experience-store.ts` | 增 `request_traces` 建表；`recordRequestTrace()`（①② 两阶段 upsert）；`getHitRateStats(windowHours)`（聚合 SQL） |
| `src/server.ts` | 两条路径（stream/非 stream）接观测点 ①② + R3 日志行；新增 `/api/stats/hit-rate`、`/stats` 路由；响应头 `x-request-id`；session header 写 requestId |
| `src/stats-page.ts` | 静态 HTML 字符串常量（无框架） |
| `test/` | experience-store trace 方法单测；server 端点 + request id + 命中/未命中两路径测试 |

**明确不做（本期）**：鉴权（与既有端点一致，本地信任边界）、图表库、trace 保留策略（量小，周报观察够用时再议）、pi 侧改动（客户端零改动，响应头可选消费）。

## 3. TDD 用例表

| # | 用例 | 断言 |
|---|---|---|
| 1 | recordRequestTrace 两阶段 upsert | ① 后 hit/retrieved 正确；② 后 finish/tokens/latency 合并到同一行 |
| 2 | getHitRateStats 窗口过滤 | 窗口外老行不计；hit_rate 计算正确（3 中 2 = 0.667） |
| 3 | by_kind 细分 | "ABILITY:Method" 与 "EVIDENCE:null" 分别计数 |
| 4 | `POST /v1/chat/completions`（mock gateway，retrieved>0） | 响应头有 `x-request-id`；trace 行 hit=1；日志行含 req=<同一 id> |
| 5 | 同上（retrieved=0） | trace 行 hit=0；hit_rate 统计正确 |
| 6 | `GET /api/stats/hit-rate`（种子 3 行） | JSON 形状符合 R2；daily 聚合正确 |
| 7 | `GET /stats` | 200 + text/html + 含 API 路径 |
| 8 | 上游 error 路径 | trace 行 error 字段非空、finish_reason=error |

## 4. 验收

- 用例表 8 条全过；包级 vitest 全绿；根 `npm run check` 干净。
- live 验证：向 8788 发 1 条命中请求 + 1 条不命中请求，`/stats` 页面可见两行且命中率 0.5；`docker compose logs` 可见 req= 关联的 3 行日志。

Refer Spec：本文件；` design/2026-07-25-agent-server-eval-report-design.md`（L3 指标来源）
