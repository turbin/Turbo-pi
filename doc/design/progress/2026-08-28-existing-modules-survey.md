# Turbo-pi 自我进化工程 — 现有模块与接口调研

状态：进行中（调研快照，2026-08-28）
用途：为阶段 14 自我进化工程蓝图（`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md`）提供现有可复用模块/接口/限制的事实基线。
方法：只读源码梳理，未修改任何代码。行号为调研当日快照。

## 0. 总览：模块地图与数据流

```
┌────────────────────────── 在线侧 ──────────────────────────┐
│ packages/coding-agent  AgentSession（TUI/print/rpc 共用）  │
│   └─ packages/agent     Agent → agent-loop（双层 loop）      │
│         └─ harness/     AgentHarness（会话/钩子/compaction） │
│ ┌─ 可选出口：经 agent-server 代理（pi client → server）     │
│ │  agent-server: /api/stream + /v1/chat/completions         │
│ │    retrieval → injection → GatewayClient → agent-gateway  │
│ │                                      │ (FastAPI/omlx)     │
│ └──────────────────────────────────────┤ 质量门→云升级       │
└────────────────────────────────────────┘                    │
┌────────────────────────── 离线侧 ──────────────────────────┐ │
│ agent-server/offline（cron/--loop 触发，不入 server 启动）  │
│   ETL → runOfflinePipeline（spawn python 三管线）→ verifier  │
│   → dormant 复评 → TTL 清理 → checkpoint（SQLite 同库）      │
└─────────────────────────────────────────────────────────────┘
packages/orchestrator：多 pi 实例监督（RPC over stdio）——独立于 agent-server
```

| 层 | 包/目录 | 一句话职责 |
|---|---|---|
| L1 agent-loop | `packages/agent/src/agent-loop.ts` | 无状态双层 agent loop（内层 turn/工具，外层 steering/follow-up） |
| L2 harness | `packages/agent/src/harness/` | 有状态 AgentHarness：会话树持久化、钩子系统、compaction、分支摘要 |
| L3 AgentSession | `packages/coding-agent/src/core/agent-session.ts` | coding-agent 会话门面：扩展、自动 compaction/retry、bash、树导航 |
| L4 server 在线 | `packages/agent-server/src/`（非 offline） | 在线经验检索注入代理（OpenAI 兼容）、session/trace 落库 |
| L5 server 离线 | `packages/agent-server/src/offline/` | 每日进化：ETL→三管线→verifier→晋升→checkpoint |
| L6 Python 管线 | `packages/agent-server/python/` | 蒸馏/验证/SOP/技能进化（子进程，独立 LLM 抽象） |
| L7 orchestrator | `packages/orchestrator/` | 多 pi 实例进程监督 + RPC + 心跳（radius） |
| L8 gateway | `packages/agent-gateway/` | 本地模型质量门控 + 云升级 + DLP/预算（独立 Python 包） |

---

## 1. L1 — `packages/agent/src/agent-loop.ts`（+ `types.ts`）

### 职责摘要
无状态在线双层 agent loop：外层 while 循环处理 follow-up/steering 队列，内层循环处理"assistant 回复 → 工具调用 → 工具结果"直到无工具调用。所有 I/O 经 `AgentEvent` 事件流对外暴露。`types.ts` 定义全部钩子契约。

### 关键文件
- `packages/agent/src/agent-loop.ts`（792 行）：`agentLoop` / `agentLoopContinue` / `runAgentLoop` / `runAgentLoopContinue` / `runLoop` / `streamAssistantResponse` / `executeToolCalls{Sequential,Parallel}` / `prepareToolCall` / `finalizeExecutedToolCall`
- `packages/agent/src/types.ts`：`AgentLoopConfig`、`AgentEvent`、`AgentTool`、`AgentContext`、`AgentState`、钩子上下文类型
- `packages/agent/src/agent.ts`：`Agent` 类（有状态封装：队列、事件订阅、`continue()`、钩子属性）

### 对外暴露的接口/类型（`AgentLoopConfig` 钩子）
| 钩子 | 签名 | 语义/用途 |
|---|---|---|
| `transformContext` | `(messages, signal?) => AgentMessage[]` | 每次 LLM 调用前改写上下文（裁剪/注入外部上下文）——**最贴近在线经验注入的扩展点** |
| `convertToLlm` | `(messages) => Message[]` | AgentMessage→LLM 消息（harness 提供默认实现） |
| `getApiKey` | `(provider) => string?` | 动态鉴权（过期 token） |
| `shouldStopAfterTurn` | `(ctx) => boolean` | turn 后优雅停（上下文太满等） |
| `prepareNextTurn` | `(ctx) => AgentLoopTurnUpdate?` | turn 后替换下一轮 context/model/thinkingLevel——**harness 的轮间刷新入口** |
| `getSteeringMessages` / `getFollowUpMessages` | `() => AgentMessage[]` | 运行中注入 / 结束后追加消息队列 |
| `beforeToolCall` | `(ctx, signal?) => {block?, reason?}` | 工具执行前拦截（扩展 tool_call 钩子落地处） |
| `afterToolCall` | `(ctx, signal?) => {content?, details?, isError?, terminate?}` | 工具结果改写（扩展 tool_result 钩子落地处） |
| `toolExecution` | `"sequential" \| "parallel"` | 工具批执行模式；单工具可 `executionMode` 覆盖 |

事件流 `AgentEvent`：`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。`Agent` 类（`agent.ts`）把这些钩子变为公开可变属性 + `subscribe()` 事件订阅，`AgentState`（systemPrompt/model/thinkingLevel/tools/messages/isStreaming/pendingToolCalls）为公共状态面。

### 当前限制
- loop 本身无状态：上下文、模型、钩子全部外部注入；状态归属在 `Agent`/`AgentHarness` 层。
- `transformContext` 返回整个消息数组（非增量 diff），大上下文下每次全量复制。
- 无内置"外部知识检索"概念：注入只能靠 `transformContext` 或塞 `getSteeringMessages`。
- 工具结果改写（afterToolCall）是字段级覆盖，无深层 merge。

### 与自我进化最可能复用的点
- **注入通道**：`transformContext` 是学生模型上线路径上最干净的注入点（agent-server 目前不经过此层，走独立代理；若未来 harness 内建记忆注入，此钩子即挂载点）。
- **轮间刷新**：`prepareNextTurn` + `AgentLoopTurnUpdate` 已是"每轮可换上下文/模型/思考级别"机制——自我进化若需"分阶段换模型（学生→教师）"可复用。
- `beforeToolCall/afterToolCall` 与 `tool_execution_*` 事件：可用于记录行为轨迹（教训卡数据源）、拦截危险工具调用（Guard 落地）。

---

## 2. L2 — `packages/agent/src/harness/`

### 职责摘要
有状态的 agent harness：`AgentHarness` 类把 `Session`（会话树存储）、`Models`（LLM 池）、工具、系统提示、事件钩子、compaction/分支摘要整合成可编程运行体。事件系统为"订阅所有 + 按类型钩子（可返回改写结果）"双通道。

### 关键文件
- `agent-harness.ts`（1029 行）：`AgentHarness` 类（prompt/skill/promptFromTemplate/steer/followUp/nextTurn/compact/navigateTree/abort/setModel/setTools/…）
- `types.ts`（838 行）：`AgentHarnessEvent`、`AgentHarnessEventResultMap`、`AgentHarnessOptions`、`CompactionPreparation`、`TreePreparation`、`SessionStorage`、`SessionRepo`、`ExecutionEnv`（FileSystem+Shell）
- `session/`：`session.ts`（Session 类 + buildSessionContext）、`jsonl-storage.ts` / `jsonl-repo.ts` / `memory-*`（存储/仓库实现）、`repo-utils.ts`
- `compaction/`：`compaction.ts`（prepareCompaction/compact/estimateTokens/shouldCompact）、`branch-summarization.ts`
- `messages.ts`（convertToLlm 默认实现）、`skills.ts`、`prompt-templates.ts`、`system-prompt.ts`

### 对外暴露的接口/类型
**钩子事件（`on(type, handler)`，handler 可返回补丁）：**

| 事件类型 | 输入 | 可返回 | 含义 |
|---|---|---|---|
| `before_agent_start` | prompt/images/systemPrompt/resources | `{messages?, systemPrompt?}` | prompt 提交前注入附加消息/换 systemPrompt |
| `context` | messages | `{messages}` | **transformContext 的钩子化版本（每轮调用）** |
| `before_provider_request` | model/sessionId/streamOptions | `{streamOptions patch}` | 每请求流选项改写（多钩子链式 patch） |
| `before_provider_payload` | model/payload | `payload` | 请求体改写 |
| `after_provider_response` | status/headers | — | 观测 |
| `tool_call` / `tool_result` | 工具调用/结果 | `{block,reason}` / `{content,details,isError,terminate}` | 工具拦截/改写（对应 before/afterToolCall） |
| `session_before_compact` | CompactionPreparation | `{cancel?, compaction?}` | **compaction 可由扩展代做/取消** |
| `session_before_tree` | TreePreparation | `{cancel?, summary?, customInstructions?}` | 分支摘要扩展 |
| `model_update` / `thinking_level_update` / `tools_update` / `resources_update` | 新旧值 | — | 状态变更观测 |

另有 `subscribe(*, handler)` 观察全部 `AgentEvent` + 自有事件（`queue_update`/`save_point`/`abort`/`settled` 等）。

**Session 树条目**：`message` / `compaction` / `branch_summary` / `custom` / `custom_message` / `label` / `model_change` / `thinking_level_change` / `active_tools_change` / `session_info` / `leaf` —— 全部可持久化，`PendingSessionWrite` 机制在运行中缓冲、turn 间 flush。

### 当前限制
- harness 面向"单个有状态交互会话"，无并发多会话编排（orchestrator 层才做多实例）。
- 事件钩子是进程内同步调用链，无跨进程/持久化事件总线。
- compaction 是"摘要替换"语义，无"经验回填"概念；`custom` 条目可承载但无官方读取 API。
- `AgentHarnessStreamOptions` 无检索/记忆相关字段（agent-server 的注入在代理层，不经 harness）。

### 与自我进化最可能复用的点
- **事件/钩子双通道**是"在线行为记录 + 策略干预"的现成机制：`custom_message`/`custom` 条目可承载经验注入审计记录；`session_before_compact` 可挂"进化摘要"。
- `Session` 树 + JSONL 存储与 agent-server ETL 读取格式**完全同构**（server 的 SessionWriter 就是为兼容 jsonl-storage 写的，版本 3）——自我进化若需要 pi 原生会话数据直接可用。
- `prepareNextTurn` 的"每轮重buildContext"刷新语义（flush pending writes → 重新读 session → 换上下文）是可复用的"轮间状态一致性"范式。

---

## 3. L3 — `packages/coding-agent/src/core/agent-session.ts`（+ session-manager.ts）

### 职责摘要
coding-agent（TUI/print/rpc 三模式共用）的会话门面：包装 `Agent`，挂接扩展系统（ExtensionRunner）、会话持久化（SessionManager）、自动 compaction（threshold/overflow 双触发）、自动 retry（指数退避）、bash 执行、树导航/fork、模型循环。**它是 pi 实际运行时的编排层。**

### 关键文件
- `agent-session.ts`（3283 行）：`AgentSession` 类 + `AgentSessionConfig`/`AgentSessionEvent`/`ExtensionBindings`/`PromptOptions`
- `session-manager.ts`（1623 行）：`SessionManager`（appendMessage/appendCompaction/appendCustomEntry/getBranch/buildSessionContext/fork/switchSession）
- `agent-session-runtime.ts` / `agent-session-services.ts`：运行时装配
- `extensions/`：扩展宿主（ExtensionRunner、事件类型定义）

### 对外暴露的接口/类型
**`AgentSessionEvent`（UI/扩展可见）：** `agent_settled`、`queue_update`、`compaction_start/end`（reason: manual/threshold/overflow；带 willRetry）、`auto_retry_start/end`、`entry_appended`、`session_info_changed`、`thinking_level_changed` 等 + 透传全部 `AgentEvent`。

**关键方法：** `prompt` / `steer` / `followUp` / `nextTurn` / `abort` / `waitForIdle` / `compact(customInstructions?)` / `navigateTree` / `fork`（经 sessionManager）/ `setModel` / `cycleModel` / `setThinkingLevel` / `setActiveToolsByName` / `executeBash` / `recordBashResult` / `subscribe` / `reload`。

**内部机制（对自我进化最相关）：**
- `_installAgentToolHooks()`：把 `agent.beforeToolCall/afterToolCall` 接到扩展 runner 的 `tool_call/tool_result` 处理器——**扩展可在不改核心代码的前提下拦截/改写全部工具调用**。
- `_installAgentNextTurnRefresh()`：包装 `prepareNextTurnWithContext`，每轮刷新 systemPrompt（基础提示 + 扩展追加）+ tools + model——**轮间系统提示刷新点**。
- `_checkCompaction`：overflow（LLM 报上下文溢出 → compact + 自动重试一次）与 threshold（超阈值 → compact 不重试）双路径；`_runAutoCompaction` 会先问扩展 `session_before_compact`（扩展可提供 compaction 结果）。
- `_prepareRetry`：可重试错误（overload/rate-limit/5xx）指数退避自动重试，溢出错误不重试。
- `_handleAgentEvent`：消息持久化（user/assistant/toolResult → SessionMessageEntry，custom → CustomMessageEntry）+ 扩展事件转发 + 重试计数重置。
- 扩展绑定 `bindExtensions()`：`setModel/setTools/steer/…` 全部向扩展暴露（`ctx.*`），扩展可 `ctx.newSession()/fork()/switchSession()/reload()`。

### 当前限制
- 单体大文件（3283 行），状态字段多，逻辑相互耦合（compaction/retry/队列交错在 `_handleAgentEvent`）。
- 扩展系统能力虽强，但钩子只覆盖"turn/消息/工具/compaction/树"，**无"每轮上下文注入外部记忆"的官方钩子**（需通过扩展事件 + `prepareNextTurnWithContext` 链路自行实现，或 hack transformContext）。
- 自动 compaction/retry 是编码会话专属语义（服务 LLM 错误恢复），与"经验蒸馏"无直接连接。
- 会话文件格式 v3 JSONL；多会话切换/并发由外部（session-manager + orchestrator）管理。

### 与自我进化最可能复用的点
- **扩展系统 = 自我进化的在线干预面**：skill/extension 机制已有 `reflect` 类工具先例（见 `plans/2026-08-11-self-improve-skill-plan.md`）；`tool_call/tool_result` 拦截可落地"Guard 卡在线执行"。
- **行为数据源头**：`_handleAgentEvent` 的持久化路径 + `recordBashResult`（bashExecution 消息）是离线 ETL 的学生行为输入。
- `compact()` 的"扩展可代做摘要"模式可推广为"扩展可代做经验抽取"（进化回路挂在 compaction 时机上）。
- `reload()`/`bindExtensions()` 的"扩展热替换"支持自我进化产出的扩展/技能动态加载（`extendResourcesFromExtensions`）。

---

## 4. L4 — agent-server 在线侧（`packages/agent-server/src/` 非 offline）

### 职责摘要
OpenAI 兼容代理服务器（Fastify）：接收 pi-ai 风格 `/api/stream` 与 OpenAI 风格 `/v1/chat/completions`，**在线经验检索注入**（retrieve → buildInjection → 转发 gateway），并把每次请求写成 pi-native session JSONL + `request_traces` 两阶段观测行。它是"记忆外挂"的当前在线实现载体。

### 关键文件
- `server.ts`（766 行）：`createServer`（`/api/stream`、`/v1/chat/completions` 流式/非流式、`/api/evolution/status`、`/api/stats/hit-rate`、`/dashboard`、`/api/status/chain`、`/api/logs`）
- `proxy-handler.ts`（325 行）：`handleStream`（检索→注入→转发→记录全流程）
- `retrieval.ts`（109 行）：FTS bm25 top-24 → 余弦×confidence 重排 top-8；`domain` 过滤
- `injection.ts`（118 行）：`buildInjection`（EVIDENCE 池 + Method/Guard top-5 拼接成合成 user 消息插入最后用户消息前；SKILL 目录进 systemPrompt；SOP schema 合并进工具列表）
- `experience-store.ts`（642 行）：`ExperienceStore`（experiences/checkpoints/request_traces 三表 + FTS5；快照读库模式）
- `session-writer.ts`（331 行）：`SessionWriter`（写 pi v3 JSONL：session 头 + message/custom 树条目）
- `openai-compat.ts`：`toOpenAIRequest`（pi-ai 上下文→OpenAI 请求体）；`gateway-client.ts`：`GatewayClient`（调 gateway `/v1/chat/completions`）
- `toolcall-validator.ts`：流式 toolCall 白名单校验（仅观测）；`skill-catalog.ts`/`sop-schema.ts`；`observability.ts`（logTrace 文件 sink）；`mock-benchmark.ts`

### 对外暴露的接口/类型
| 接口 | 说明 |
|---|---|
| `StreamRequest` | `{model, context, options, taskId?, domain?, arm?, condition?, canonicalRequestHash?}` |
| `ProxyStreamOptions` | `sessionId/authToken/stop/thinking/injection/arm/…`（`injection` 支持每请求开关——对照臂） |
| `Experience` | `{id, type: SKILL\|SOP\|ABILITY\|EVIDENCE, title, payload, quality, confidence, rescoreExcludedBatches, status, sourceSession, sourceEntryId, contentHash, createdAt}` |
| `InjectionPayload` | `{messages, systemPrompt?, tools?, injectedIds, injectedTokens}`（注入审计字段） |
| `RequestTraceInput` | 两阶段 trace 行（phase-1 检索 / phase-1.5 注入 / phase-2 完成，COALESCE 合并） |
| `Checkpoint` | `{id, kind, epoch, metric, snapshot, createdAt}`（checkpoints 表，kind="evolution"） |

**在线流水线（handleStream）：** lastUserText → `retrieve`(limit 8, domain 过滤) → trace phase-1 → `buildInjection`（evidence pool + Method top5 + Guard top5；SKILL 目录 ≤10；SOP schema ≤15）→ trace phase-1.5 → 写 session（context messages + `experience_injection` + `custom_message` 注入后实况 + `response_started` + `stream_event`* + `gateway_marker` + 重建 assistant message + `response_completed/error/aborted`）→ gateway 转发（SSE）→ trace phase-2。

### 当前限制
- 检索是**词法 FTS + 余弦重排**（无向量/无语义），候选池上限 24、注入上限 8；`quality DESC` 排序与 `confidence` 加权在重排层。
- 注入是"合成 user 消息"单形态（EVIDENCE 文本/方法/护栏拼接），无多形态记忆（如结构化步骤、代码片段渲染）。
- 无在线反馈闭环：`request_traces` 只记录（hit/injected/tokens），**未消费回经验库质量信号**（confidence 更新靠离线 eval/attribution.py 手工脚本）。
- 会话与 trace 分属两套存储（JSONL 文件 + SQLite），无统一查询。
- 无多租户/权限；单进程 SQLite 写锁。
- `/v1` 流式路径（`teeOpenAISSEWithSession`）与 `/api/stream` 路径有代码重复（检索/注入逻辑两份）。

### 与自我进化最可能复用的点
- **整个检索→注入→观测链路就是"在线记忆外挂"的现成参照实现**：`injectedIds/injectedTokens/hit` 已具备"注入归因"审计，是评估记忆增益（Q8 transfer、arm 等价性）的基础设施。
- `request_traces` 的 `taskId/arm/condition/canonicalRequestHash` 字段已为实验对照/审计预埋。
- **会话 JSONL 与 ETL/离线管线直接衔接**：server 写、offline 读，闭环已通（每日进化）。
- `gateway_marker`/`x-gateway` 透传：云升级可观测性先例（谁服务了本次请求）。

---

## 5. L5 — agent-server 离线侧（`packages/agent-server/src/offline/`）

### 职责摘要
每日进化闭环（SPEC §4.2/§5.2）：会话 JSONL → ETL（EVIDENCE 候选）→ 三管线蒸馏（Python 子进程）→ verifier 晋升闸 → dormant 复评 → TTL 清理 → checkpoint。触发外部化（cron/launchd/--loop），刻意不挂 server 启动。

### 关键文件与职责
| 文件 | 职责 |
|---|---|
| `scheduler.ts` | `runDailyEvolution`：六步编排（ETL→pipeline→promote→dormant rescore→TTL→checkpoint）；全步骤可注入测试 |
| `run-evolution.ts` | CLI（`--status`/`--loop`/`--resume <run_dir>`）；失败也写 checkpoint（三态语义）；退出码 0/1/2 |
| `etl.ts` | 会话 JSONL→dormant EVIDENCE（按句子切分、sha256 内容哈希、domain 打标、**半截 session 完整性隔离**） |
| `pipeline.ts` | `runOfflinePipeline`：spawn 三个 Python 模块（skill_evolution / sop_lifecycle / verification_selection），staged JSON 落 outputDir；`runDormantRescore` 复评入口 |
| `verifier.ts` | TS 侧晋升闸：`verifyAndCanonicalize`（≥0.5 晋升、Method/Guard→ABILITY、**交付物检查**、contentHash 去重、dormant 就位晋升）；`promoteStagedOutputs` |
| `canonicalize.ts` | 确定性去重：sha256(type,title,payload 规范化 JSON)；`dedupeCandidates` |
| `checkpoint.ts` | `writeCheckpoint`（确定性 id：sha256(kind:epoch:snapshot)）+ 读写 |
| `benchmark.ts` | 从会话推导 benchmark.json（规则式 concept 提取） |
| `schedule.ts` | cron/launchd 安装/卸载/doctor（有红线：不得无 --dry-run 执行） |
| `weekly-report.ts` | 每周观测报告（SQL 集合转 markdown） |
| `rebuild-fts.ts` | FTS 索引重建 CLI（手动迁移） |
| `task-domain.ts` | task_id→domain 注册表（与 Python `domains.py` 双副本镜像） |

### 对外暴露的接口/类型
- `runDailyEvolution(store, DailyEvolutionOptions)` → checkpoint id；选项：`inputDir/outputDir/benchmarkPath/pipelineOptions/runDir/rescoreLimit/dormantTtlDays/dormantCap/etlFn/pipelineFn/promoteFn/rescoreFn/now`
- `OfflinePipelineOptions`：`pythonBin/pythonDir/benchmarkPath/timeoutMs/spawnFn/runDir`
- `VerifyItem`：`{id?, type?, title?, quality, payload?, contentHash?, sourceSession?, sourceEntryId?}`
- `PipelineResult`：`{skills, sops, cards}`
- 常量：`PROMOTION_THRESHOLD=0.5`、`SOP_PREVETTED_QUALITY=1`（SOP 预验证标记）

### 当前限制
- **SKILL 暂缓入库**（F4/T5 红线修订）：skill evolution 的 utility 分无验证对象（benchmark 恒为空），`verifyAndCanonicalize` 过滤 SKILL——技能通道实际未闭环。
- ETL 是"句子切分"粗粒度证据提取；无段落/语义切分。
- 三管线为子进程黑盒（spawn python -m），LLM 调用在 Python 侧（LLM_BASE_URL 直连 DeepSeek 等），TS 侧无法细粒度编排/注入钩子。
- dormant 复评每批 200（oldest first），复评分数 <0.5 不淘汰只滞留，靠 TTL（30 天）/cap（1 万）兜底。
- 无"验证→触发重跑"的自动化（进化结果人工/定时检视）。
- checkpoint 是快照 JSON 文本，无结构化的逐卡历史。

### 与自我进化最可能复用的点
- **六步编排框架**（scheduler.ts 可注入依赖）是新增进化阶段（如 R3 harness 自进化）的挂载骨架。
- **晋升闸模式**：`verifyAndCanonicalize`（事务 + 去重 + 就位晋升）可直接复用为新经验类型（如 scaffold/教训卡）的入库通道。
- **checkpoint/断点模式**：`writeCheckpoint` + `runDir` 打分断点（`ScoreJournal`）已解决"进化中途崩溃重跑"问题——新管线沿用即可。
- **ETL 完整性校验**（半截 session 隔离）与"mining exactly once"幂等插入是数据质量基线。
- 失败 checkpoint 三态（never/failed/ok）语义可直接用于自我进化健康监控。

---

## 6. L6 — `packages/agent-server/python/`（verification_selection 等）

### 职责摘要
vendored Python 管线包（agent-server 子进程调用；另有独立 skill_evolution 五 agent 进化与 sop_lifecycle 生命周期包）。verification_selection 是**经验蒸馏+验证核心**：LLM-as-a-Verifier（PPT 锦标赛 / vs-reference 偏好）打分 → 五元组卡抽取 → canonicalize → SQLite 经验库（FTS5）。

### 关键文件（verification_selection，2766 行）
| 文件 | 职责 |
|---|---|
| `pipeline.py` | 端到端：`select_experiences` / `score_trajectories_with_checkpoint` / `_rescore_cli`；CLI `--input/--output/--run-dir/--rescore` |
| `verifier.py` | `Verifier` + `LetterScale`（A-T 字母刻度，logprob 期望化）+ Bradley-Terry + PPT 锦标赛（k=3）+ 两阶段打分（大模型 reasoning + 小模型评分） |
| `llm_client.py` | `LLMClient` 协议 / `OpenAICompatClient`（env: LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/TEACHER_MODEL）/ `MockLLM`；usage 台账（EVOLUTION_USAGE_LEDGER） |
| `experience.py` | `ExperienceCard` 五元组（trigger/procedure/evidence/boundary/role）+ deliverables + domain/task_pattern；schema 校验 |
| `deliverables.py` | 交付物产出检测（保守启发式正则，无交付→quality 封顶 0.49 <0.5） |
| `canonicalize.py` | TF-IDF blocking + 五 rubric 裁决（LLM） |
| `checkpoint.py` | `ScoreJournal`（打分断点，input_hash=prompt 指纹+轨迹内容；resume 跳过已完成组） |
| `library.py` | `ExperienceLibrary`（SQLite FTS5：cards/units/reasoning cache） |
| `restill.py` | 存量卡重蒸（按新模板重打分+重蒸馏，带交付检查） |
| `anchor.py` | Anchor oracle 诊断（curator 标签确定性 routing 对照上界） |
| `testing.py` | 确定性 Mock（关键词质量信号），离线测试/demo |
| `domains.py` | task_id→domain 注册表（与 TS task-domain.ts 镜像） |

**skill_evolution（2765 行）**：Analyzer/Retriever/Allocator/Proposer/Evolver 五 agent 技能进化；`skillfile.py`（skill 文件解析/改写）、`store.py`（SkillStore）、`sop.py`（SopLifecycle/SopConfig）。
**sop_lifecycle（117 行）**：构造→合并→重执行生命周期，工具注册表由轨迹工具名构造 echo callable（子进程内无法真重执行）。

### 对外暴露的接口/类型（子进程 CLI 契约）
```
python -m verification_selection.pipeline --input trajectories.json --output cards.json [--score-threshold 0.5] [--run-dir <dir>]
python -m verification_selection.pipeline --rescore --input candidates.json --output scores.json
python -m skill_evolution.pipeline --input trajectories.json --output skills.json [--benchmark b.json]
python -m sop_lifecycle --input trajectories.json --output sops.json
```
- 输入轨迹：`[{taskId, task, text, toolCalls?, domain}]`（agent-server `collectTrajectories` 产出）
- 输出卡：`[{taskId, quality, card:{name, trigger, procedure, deliverables, boundary, role, domain, task_pattern, evidence}}]`
- 配置：`LLM_BASE_URL + LLM_MODEL/TEACHER_MODEL` 走真实端点，否则确定性 MockLLM

### 当前限制
- **子进程黑盒**：TS 侧无法挂钩子/观测中间步骤（只拿到最终 JSON）；LLM 调用全部在 Python 侧，成本/日志经 usage 台账外置。
- 打分是**自评语义**（小模型评大模型轨迹 vs 参照），F2 引入的实战归因 confidence 是外部手工脚本（eval/attribution.py）写入，未内联。
- 交付检查是正则启发式，非文件型交付会误判（文档自述已知局限：C 语料 4/98 高分轨迹被保守拦截）。
- canonicalize 用 LLM 裁决，成本与确定性折衷（mock 路径确定性）。
- 三管线（skill/sop/card）各自独立，无统一经验 schema；SOP 预验证通道与主闸语义不同（quality=1 标记）。

### 与自我进化最可能复用的点
- **Verifier 打分框架**（字母刻度 logprob 期望化 + PPT/vs-reference + 断点复用）是"验证闸"的现成实现，自我进化的验证阶段（如扩产/改 scaffold 后的评估）可直接复用或扩展。
- `ScoreJournal`/`prompt_fingerprint`/`input_hash` 断点机制已解决昂贵打分的可恢复性。
- `ExperienceCard` 五元组 + deliverables + 情景标签 schema 是经验库的 canonical 形态（TS `payload` 与其镜像）。
- `testing.py` 的确定性 Mock 链让离线测试不依赖真实 LLM——自我进化管线测试可沿用。
- `AnchorOracleRouter`（oracle 对照）是"评估检索/路由质量"的诊断范式（上界对照）。

---

## 7. L7 — `packages/orchestrator/`

### 职责摘要
实验性多 pi 实例监督器：为每个实例 spawn 一个 `pi --mode rpc` 子进程，经 **stdio JSON-RPC 行协议** 收发命令/事件；持久化实例记录（instances.json）、半径心跳（radius）、事件转发给订阅者。**与 agent-server 的进化体系完全独立。**

### 关键文件
- `supervisor.ts`（354 行）：`OrchestratorSupervisor`（实例生命周期 start/stop/restart、状态机 starting/online/stopping/stopped/error、意外退出处理、命令路由）
- `rpc-process.ts`（201 行）：`RpcProcessInstance`（spawn/发送命令/响应-事件分发/UI 请求回传）
- `ipc/`：`protocol.ts`（`RpcCommand`/`RpcResponse`/事件线格式）、`server.ts`/`client.ts`（HTTP/SSE 控制面）
- `handler.ts` / `cli.ts` / `serve.ts` / `storage.ts` / `config.ts` / `radius.ts`（440 行，radius 协议：心跳注册/过期）
- `types.ts`：`InstanceRecord`、`MachineRecord`、`InstanceStatus`

### 对外暴露的接口/类型
- `RpcCommand`：来自 `@earendil-works/pi-coding-agent`（`prompt`/`steer`/`new_session`/`switch_session`/`fork`/`clone`/`set_session_name`/`get_state` 等）；部分命令（new_session/switch_session/fork/clone/set_session_name/prompt）后刷新持久化 session 元数据。
- `AgentSessionEvent` 透传：订阅者可收到子 pi 的全部会话事件。
- 进程退出/错误经 `onExit` 通知；`handleUnexpectedRpcExit` 自动重启（status≠stopping 时）。

### 当前限制
- 明确标注 experimental、API 不稳定。
- 无资源隔离/配额/调度策略（仅是进程监督 + 心跳）；无跨实例共享记忆/经验。
- RPC 行协议为 JSONL-over-stdio，无二进制/大 payload 优化。
- 实例记录存 JSON 文件（storage.ts），无 SQLite 化。

### 与自我进化最可能复用的点
- **多实例编排骨架**：若自我进化需要并行学生实例（多任务/多臂跑批）或"进化控制进程"监督多个 pi，supervisor + RPC + 心跳即现成底座。
- `SESSION_METADATA_COMMANDS`（哪些命令改 session 元数据）的判定模式可复用于"哪些操作后需要同步经验库"。
- 事件透传通道可做跨实例行为收集（但当前无该功能）。

---

## 8. L8 — `packages/agent-gateway/`（独立 Python 包，仅接口与调用关系）

### 职责摘要
独立 FastAPI 服务（非 npm workspace）：OpenAI 兼容 `/v1/chat/completions` + `/v1/models`，路由到本地 omlx（学生），**可观测质量门失败→同一信封升级到单个云教师（Kimi）**；云出口前强制 DLP 扫描 + 原子预算预留；请求状态机 + 幂等键 + Langfuse tracing。与 agent-server 的调用关系：agent-server `GatewayClient` → gateway `/v1/chat/completions`。

### 关键文件与接口
| 文件 | 职责/接口 |
|---|---|
| `quality.py` | `evaluate_quality(envelope, result) -> GateDecision(escalate, reason)`；四个可观测门：非法工具 schema / finish_reason=length / 空输出 / 强制工具未调用 |
| `routing.py` | `select_provider`（V1：全路由本地 omlx）+ `select_escalation_provider`（单一云教师）；`RouteDecision{provider_name, provider}` |
| `security/dlp.py` | `scan_envelope`（默认模式：AWS key/PEM/api_key 赋值/身份证号 + 配置扩充）；命中→403 `cloud_egress_forbidden` |
| `store/budget_ledger.py` | `reserve/reconcile/release`：BEGIN IMMEDIATE 原子预留，per-(channel, month) 上限，超限 429 `budget_exceeded` |
| `api/chat.py` | 状态机（received→queued→leased→run_started→run_succeeded→response_started→response_closed/cancelled/failed/abandoned）、幂等键回放、SSE 延迟回放 |
| `providers/` | `Provider` 协议（base.py）；omlx（本地）/ kimi（云）/ fake（测试） |
| `channel.py` / `config.py` / `envelope.py` | API key→ChannelContext；TOML 严格校验；`ChatCompletionEnvelopeV1` 请求契约 |
| `observability.py` | Langfuse 包装（generation 导出）、trace_id 上下文 |
| `statemachine.py` | `RequestState` + 允许转移表（CAS 版本控制，无跨网络事务） |

调用关系：`api/chat.py`（主/升级两条腿，升级腿 sequence=2 purpose="escalation" quality_signals 记录）→ `cancellation.await_provider`（客户端断开取消上游）→ `sse.DelayedEventStreamResponse`（流式延迟回放：先全量拿到本地结果再回放，配合升级决策）。

### 当前限制
- 质量门是**可观测信号门**（结构/长度/空输出），无内容质量/任务成功判定——文档明言 confidence/complexity/history 信号不在 V1 范围。
- 升级判定在**响应完成后**（延迟 SSE 回放），非流式先行决策。
- 单 worker 锁 + SQLite 单写者；无多副本。
- 预算按 channel×月，粒度粗（无每任务/每请求精细化预算）。
- 与 TS 侧无代码共享（刻意独立包）；DLP 模式是正则集，无语义检测。

### 与自我进化最可能复用的点
- **质量门→云升级决策范式**是"学生本地跑 + 教师兜底"的现成实现——自我进化蓝图（V3：scoped 模型门、严格 shadow）可直接在其上扩展门集合（如"低质量信号→重试/升级"）。
- **预算账本**（原子预留/对账/释放三态）是"云教师成本上限"的现成机制，进化跑批成本控制可复用。
- **请求状态机 + trace**（ModelRun sequence/purpose/quality_signals）已具备"谁服务、为何升级"的审计结构。
- DLP 出口扫描是"经验/代码出域"安全基线（进化产物上云前的检查先例）。

---

## 9. 跨层要点：与自我进化设计最相关的复用矩阵

| 进化需求（按蓝图/R 路线图） | 现有可复用件 | 位置 |
|---|---|---|
| 在线记忆注入 | `transformContext` 钩子 / `buildInjection` 流水线 / `injectedIds` 审计 | agent-loop.ts；agent-server injection.ts |
| 学生行为数据采集 | `AgentEvent` 流 / session JSONL v3 / `recordBashResult` / `request_traces` | harness；AgentSession；server |
| 经验验证闸 | Python Verifier（PPT/vs-reference）+ TS `verifyAndCanonicalize` + 交付检查 | python/verification_selection；offline/verifier.ts |
| 每日进化编排 | `runDailyEvolution` 六步 + checkpoint 三态 + `--resume` 断点 | offline/scheduler.ts + checkpoint.ts |
| 云教师升级与成本 | gateway 质量门 + `BudgetLedger` + x-gateway 标记 | agent-gateway/ |
| 多实例并行/监督 | orchestrator supervisor + RPC + radius 心跳 | orchestrator/ |
| 扩展/技能热加载 | `bindExtensions` / `reload` / `extendResourcesFromExtensions` | AgentSession |
| 实验对照与审计 | `arm/condition/canonicalRequestHash` trace 字段；`injection:false` 对照臂 | server.ts / types.ts |
| 离线测试确定性 | Python `testing.py` Mock 链 + TS 可注入依赖（scheduler/pipeline/verifier） | 两侧 |

## 10. 主要限制汇总（自我进化设计需绕开/补齐的坑）

1. **在线-离线断点**：在线只写（trace/会话），离线只读（ETL/晋升）；`confidence` 实战归因无在线回写通道（手工脚本）。
2. **无 harness 内建记忆**：在线注入只在 agent-server 代理层；pi 直连（不经 server）时无任何记忆。
3. **SKILL 通道未闭环**：utility 分无验证对象，SKILL 被晋升闸过滤。
4. **检索为词法级**：FTS+余弦，无向量/语义；跨域仅靠 domain 标签。
5. **子进程黑盒**：Python 管线不可插桩；LLM 调用两套抽象（TS pi-ai / Python urllib）。
6. **gateway 质量门弱**：仅可观测信号，无内容/成功判定。
7. **orchestrator 实验性**：无经验共享、无调度策略、JSON 存储。
8. **schema 演化中**：`Experience` 新列靠 PRAGMA+ALTER 迁移（SCHEMA_VERSION=2），`plans/2026-08-11-experience-schema-evolution-plan.md` 待评审。

---

*调研人：pi agent（只读调研，未改源码）。相关设计参照：`doc/design/plans/2026-07-31-agent-self-evolution-roadmap.md`、`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md`。*
