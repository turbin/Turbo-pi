# Agent-Server O：命中率可观测 + 请求级 trace——变更与决策记录

日期：2026-07-27
SPEC：`doc/design/2026-07-27-agent-server-observability-spec.md`
状态：**已完成（SPEC §4 验收全过）**

---

## 1. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | trace 存 `experience.db` 的 `request_traces` 表（`CREATE TABLE IF NOT EXISTS`，老库兼容） | 单一存储、零新文件；与命中率页面同一数据源 |
| 2 | request id 用 Fastify 内建 `request.id`（req-1/req-2…） | 零依赖；跨重启唯一性由 ts 列兜底（SPEC R4） |
| 3 | 页面为零框架静态 HTML（`stats-page.ts` 字符串常量） | 无构建无依赖，与"保守方式"要求一致 |
| 4 | 两阶段 upsert（检索后 INSERT、完成时 ON CONFLICT UPDATE 只补完成字段） | 非流式路径检索在 proxy-handler、完成信息在 server.ts，分散写同一行 |
| 5 | 日志走 stdout 结构化行（`req=<id> phase=...`） | 容器 `docker compose logs` 直接可读，不加日志框架 |
| 6 | `/api/stream` 内部路由不接入 trace | SPEC 范围锁定 `/v1/chat/completions`；误应用一次后回退（见 §3 过程记录） |
| 7 | "本地/远程"归因规则：phase=retrieval 的 retrieved_ids=本地经验库内容；phase=done 内容=远程 LLM 生成 | 当前架构无本地 LLM，术语在 SPEC §0 已对齐 |

## 2. 实现清单

| 文件 | 变更 |
|---|---|
| `src/experience-store.ts` | `request_traces` 建表 + `recordRequestTrace()` 两阶段 upsert + `getHitRateStats(windowHours)` 聚合 |
| `src/observability.ts` | `kindsOf()`（"TYPE:role" 细分）、`logTrace()` 结构化日志 |
| `src/stats-page.ts` | `/stats` 静态页（时间窗选择/按类型/按天/最近 20 条） |
| `src/server.ts` | `/api/stats/hit-rate` + `/stats` 路由；`x-request-id` 响应头；session header `metadata.requestId`；两条路径的观测点 ①② + 日志；流式 `traceStreamCompletion` 包装器 |
| `src/proxy-handler.ts` | opts 增 `requestId`；观测点 ①（检索后）|
| `test/request-trace.test.ts` | +4 用例（两阶段 upsert/窗口过滤/byKind/daily/错误路径） |
| `test/server.test.ts` | +4 用例（命中 trace + x-request-id/未命中/API+页面/上游错误）；1 条既有断言更新（session header metadata 增 requestId，预期内变化） |

## 3. 过程记录（返工点）

- 首个 catch 块编辑误应用到 `/api/stream` 路由（两条路由 catch 文本相同，StrReplace 命中第一条）→ 回退，改正应用到 `/v1/chat/completions` 的 catch；教训已记录。
- 既有断言 `metadata toEqual` 因新增 requestId 失败 → 按仓库规则更新断言并在此说明（预期内变化，非逻辑回归）。

## 4. 验证

- **TDD**：spec §3 用例表 8 条全覆盖（store 4 + server 4）；包级 vitest 23 文件 / **246 测试**全绿；根 `npm run check` 干净。
- **live 验证（生产容器，镜像已重建部署）**：
  - 命中请求（retry/backoff 主题）：`req=req-1 phase=retrieval hit=1 retrieved=8 kinds=EVIDENCE:null:1,ABILITY:Method:7` → `phase=done finish=length tokens=644/20 latency_ms=1128`
  - 未命中请求（无意义字符串）：`req=req-2 phase=retrieval hit=0` → `phase=done`
  - `/api/stats/hit-rate?window_hours=1`：total 2 / hits 1 / hitRate 0.5，byKind `ABILITY:Method:7 + EVIDENCE:null:1`；`/stats` 页面正常渲染；`x-request-id: req-1` 响应头存在。

## 5. 已知限制

1. `stream` 列当前恒为 1：非流式请求内部也走流式管线（handleStream），phase-1 记录时无法区分客户端语义；后续需要时把 `body.stream` 透传进 proxy-handler。
2. request id 为进程内单调（req-N），重启后从 req-1 重新计数；查询时请配合 ts 列。
3. 页面无鉴权（与既有端点一致，本地信任边界）。

## 6. Follow-up（2026-07-27 晚，用户反馈）：日志可读性增强

**反馈**：`kinds=EVIDENCE:null:1,ABILITY:Method:7` 是代码符号，人读不出“本地经验库返回了什么”。

**修改**（同日完成，252 测试全绿，已部署）：
1. 日志 kinds 改中文标签：`方法/护栏/证据/工作流/技能/SOP`（`observability.ts` 的 `KIND_LABELS` + `summarizeKinds`）；
2. retrieval 日志行新增 `injected="<前 3 条经验标题> 等N条"`（`titlesOf`）——直接看到本地经验库注入了哪些内容；
3. `/stats` 页面命中行显示注入的经验 id 列表（`request_traces.recent` 补 `retrieved_ids` 列查询，无 schema 变更）。

实测日志：`req=req-1 phase=retrieval hit=1 retrieved=8 kinds=证据×1,方法×7 injected="Since the call is idempotent, ...; Exponential Backoff with Jitter...; Idempotent API Retry... 等8条"`。

Refer Spec：`doc/design/2026-07-27-agent-server-observability-spec.md`；`doc/design/2026-07-25-agent-server-eval-report-design.md`（L3 指标来源）
