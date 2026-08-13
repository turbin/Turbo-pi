# 对抗式审查报告 A：实现一致性 / 代码对照

审查对象：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`（经验学习系统概要设计 v2）
审查人视角：实现一致性 / 代码对照
审查方法：先读 v2 全文与 `doc/design/2026-08-13-agent-server-system-design-and-issue-inventory.md`，再逐条对照 `packages/agent-server/src/**` 与 `packages/agent-gateway/src/agent_gateway/**` 现役源码。仅报告亲自核实过的问题；未核实的方面不列。

---

## Finding 1 — agent-server 端口口径：文档写 :8789，代码默认 8788

- **严重级**：minor
- **文档位置**：§2.1（"L2 经验层 agent-server :8789"）、§2.4 调用图（"agent-server :8789（TypeScript / Fastify）"）
- **文档断言**：agent-server 端口为 8789。
- **代码事实**：
  - `packages/agent-server/src/server.ts:593`：`export async function startServer(port = 8788)`
  - `packages/agent-server/src/start.ts:3`：`startServer(Number(process.env.PORT ?? 8788))`
  - 8789 只是评估实例的部署约定：`packages/agent-server/AGENTS.md:11` 与 `eval/campaign.py:37`/`eval/preflight.py:48` 显式以 `PORT=8789` 环境变量覆盖启动。
- **为什么构成问题**：文档把 8789 表述为 agent-server 的固定端口（图层/调用图标注为系统常量），但代码默认端口是 8788；8789 是评估实例通过 `PORT` 环境变量覆写出来的部署态，生产容器实际用 8788（`docs/container-deployment.md:24`、`docs/experience-injection.md:80`）。对照 gateway 侧端口在 `config.toml` 里是确定的 8787，agent-server 侧口径不对称，容易误导"8789 是代码级固定端口"。（注：gateway :8787 与代码一致，`packages/agent-gateway/config.toml:6`。）

---

## Finding 2 — 类名 `CloudProvider` 不存在（应为 `KimiProvider`）

- **严重级**：minor
- **文档位置**：§2.2 时序图（"G->>T: CloudProvider.complete()"）、§2.4 调用图（"CP["CloudProvider.complete() providers/kimi.py"]"）
- **文档断言**：云端教师适配器为 `CloudProvider`，方法 `complete()`，位于 `providers/kimi.py`。
- **代码事实**：
  - `packages/agent-gateway/src/agent_gateway/providers/kimi.py:26`：`class KimiProvider:`，方法 `complete()` 在 `:63`。
  - 全仓 `grep -rn "CloudProvider"` 仅命中 `config.py:46` 的 `class CloudProviderConfig`（配置模型，非 provider）。无任何 `CloudProvider` 类。
  - §2.4 模块职责表（v2 第 243 行）本身写的是"DeepSeek 复用 KimiProvider"——与调用图自相矛盾。
- **为什么构成问题**：文档给出的类名在代码中不存在，属于事实性错误；且与同文档模块表、与 system-design 文档（4.2 节"KimiProvider.complete()"）不一致。

---

## Finding 3 — EVIDENCE 上限"5 条"不实（仅 Method/Guard 有 5 上限）

- **严重级**：minor
- **文档位置**：§3.4（"EVIDENCE 与 Method/Guard（各上限 5 条）合成用户消息"）
- **文档断言**：EVIDENCE 与 Method/Guard 各上限 5 条。
- **代码事实**：`packages/agent-server/src/injection.ts`
  - `:11-12`：`const METHOD_LIMIT = 5; const GUARD_LIMIT = 5;`（仅 Method/Guard 各截断 5）
  - `:41`：EVIDENCE 直接 `evidence.push(payload.text)`，无计数上限
  - `:56/:60`：仅 methods/guards 各 `.slice(0, METHOD_LIMIT/GUARD_LIMIT)`
  - `:64`：`if (evidence.length) blocks.push(<Extra Info>…全部 evidence…)`，不截断
- **为什么构成问题**：EVIDENCE 没有任何 5 条上限，其数量只受检索阶段"全部类型合计 top-8"约束。文档把 EVIDENCE 与 Method/Guard 并列宣称"各上限 5 条"，与代码不符，也与姊妹文档 system-design §5.2（"EVIDENCE=检索 top-8；Method/Guard=quality 前 5"）矛盾。

---

## Finding 4 — "rescore 降级（active→dormant）"机制未实现

- **严重级**：major
- **文档位置**：§2.3 数据流（"RES["rescore 降级 + TTL 清理"]"）、§3.3（"rescore 降级为惩罚"）、§3.6 表（"经验卡 | 晋升、留观、降级、淘汰"）
- **文档断言**：active 卡在 rescore 质量下滑时会降级回 dormant（"降级为惩罚"），生命周期有"降级"这一出口。
- **代码事实**：
  - `packages/agent-server/src/offline/scheduler.ts:106`：`runDormantRescore` 只对 `store.listDormant("EVIDENCE", rescoreLimit)` 的 **dormant** 行重打分，从不触碰 active 行。
  - `packages/agent-server/src/experience-store.ts` 中唯一的状态迁移：`promoteToActive`（`:253-254`，dormant→active）、`removeDormantBefore`（`:288` 起，dormant→removed）、以及 `verifier.ts` 新卡插入（active）与 `etl.ts` 候选入库（dormant）。
  - 全仓（src + python）搜索无任何 `UPDATE experiences SET status='dormant'` 或 active→dormant 降级路径（已搜索 experience-store.ts / verifier.ts / scheduler.ts / pipeline.ts / python/verification_selection）。
- **为什么构成问题**：文档把"降级"列为现役生命周期机制（§3.3 明确写"rescore 降级为惩罚"），但代码中 active 卡一旦晋升就永不被降级（TTL/容量淘汰也只作用于 dormant）。system-design §5.2 生命周期图"active → rescore 下滑 → 降回 dormant"同样无代码支撑。这是对现役机制的事实性误述。

---

## Finding 5 — 实战归因奖惩与 quality/confidence 二元组未实现

- **严重级**：major
- **文档位置**：§2.3 归因流（ATTR：trace retrievedIds × 任务分数 → 卡片奖惩 → quality/confidence 更新）、§3.6（"实战归因依托 request_traces.retrievedIds 与任务分数关联"、"元数据层为 quality/confidence 二元组"、表"实战归因/元数据"行）、§4（"归因：…卡片奖惩、质量分更新…"）
- **文档断言**：现役存在"实战归因奖惩"（高分任务注入卡加分、连续失败降权）与"quality/confidence 二元组，置信度随实战证据累积调整"。
- **代码事实**：
  - `packages/agent-server/src/types.ts:35`：`Experience` 仅有 `quality: number`，无 `confidence` 字段；`experience-store.ts` 的 `experiences` 表 schema（`:156-168`）也无 `confidence` 列。
  - 全仓搜索无任何代码把 `request_traces.retrieved_ids` 与任务分数 join 后回写卡片 quality（已搜索 src 全部 + python；`retrievedIds` 仅用于落盘 `recordRequestTrace` 与 stats 展示）。
  - v2 文档自身 §5 演进方案把"#2 实战归因奖惩与置信度"列为**未启动**的后续工作（1-2 天）；姊妹文档 system-design §5.6 也明确标注"待建（已立项方向，C 后统一修复批次）"。
- **为什么构成问题**：§3.6 的"运行方式与有效作用"与 §2.3/§4 的数据流把"归因奖惩 + confidence 更新"当作现役机制描述，但代码中既无 confidence 字段、也无归因回写逻辑。这与文档自身 §5（列为未来方案）和 system-design §5.6（标注待建）自相矛盾，属于对现役状态的事实性夸大。

---

## Finding 6 — §3.5"触发器为局级胜负 / 三路合并进料"与代码现状不符

- **严重级**：minor
- **文档位置**：§3.5（"触发器为局级胜负（已从门控信号迁移…）；进化进料三路合并——学生轨迹、同局老师胜局、败局对照"）
- **文档断言**：学习回路触发器已迁移到"局级胜负"，进料为学生轨迹 + 同局老师胜局 + 败局对照三路合并。
- **代码事实**：
  - 实际触发为外部 cron/manual：`scheduler.ts` 头部注释"Triggering is external (cron or manual…)"，`offline/schedule.ts` 安装 launchd/crontab，`run-evolution.ts` 提供 `--loop` 常驻。
  - 进料为全量批次：`etlSessionFiles`（etl.ts）与 `collectTrajectories`（pipeline.ts）读 `inputDir` 下**全部** `*.jsonl`，无胜负过滤、无"三路合并"逻辑。
  - `eval/synthesize_alfworld_sessions.py:50` 与 `synthesize_campaign_sessions.py` 仅在 metadata 携带 `won`/`score`，不据此分流进料（已搜索 campaign.py/alfworld_agent.py/src 全部，无胜局/败局分流进进化管线的代码）。
- **为什么构成问题**：§3.5 以现在时陈述"触发器为局级胜负"和"三路合并进料"，但代码现状是"外部 cron 触发 + 全量批次进化"（文档第三句"C campaign 执行每日批次全量进化"才是准确的）。"局级胜负迁移/三路合并"是 R2 设计叙事，未在现役 C campaign 代码中落地。

---

## Finding 7 — toolcall-validator"在线仅观察不拦截"与实际行为不符

- **严重级**：minor
- **文档位置**：§2.4 调用图（"HS --> VTC["validateToolCallStream() 观察模式 toolcall-validator.ts"]"）、§2.4 模块表（"toolcall-validator | 工具调用白名单校验，在线仅观察不拦截"）
- **文档断言**：`validateToolCallStream()` 在线仅观察、不拦截。
- **代码事实**：`packages/agent-server/src/toolcall-validator.ts`
  - `:208-209`：`finish_reason=length` 时"rejects the whole toolCall batch （整批拒绝）"
  - `:347/:370`：校验失败 `emit({type:"error", reason:"error", errorMessage:"toolCall rejected: …"})`，以 error 事件终止流、替换 toolCall 输出。
  - 真正"observe-only"的是另一条路径：`/v1/chat/completions` 流式透传里的 `validateAccumulatedToolCalls`（server.ts `teeOpenAISSEWithSession`，注释"observe-only: violations are logged but the raw bytes are never altered"）。
- **为什么构成问题**：`validateToolCallStream()`（/api/stream 路径）实际会拦截并拒绝非法 toolCall 批次，并非"仅观察不拦截"。"观察模式/不拦截"只对 /v1 流式透传路径成立。文档把两条路径的行为混为一谈，且对点名函数 `validateToolCallStream` 的职责描述错误。

---

## Finding 8 — `create_trace()` 归属 queued→leased→run_started 不实

- **严重级**：minor
- **文档位置**：§2.2 时序图（"G->>GDB: create_trace（queued, leased, run_started…）"）、§2.4 调用图（"CT["TraceStore.create_trace() queued→leased→run_started"]"）
- **文档断言**：`create_trace()` 完成 queued→leased→run_started 状态推进。
- **代码事实**：
  - `packages/agent-gateway/src/agent_gateway/store/trace_store.py:64`：`create_trace` 仅以 `state=RequestState.received.value` 创建 trace。
  - queued/leased/run_started 是 `chat.py` 中 `chat_completions` 的三次独立 `store.transition()` 调用（`:811` queued、`:816` leased、`:823` run_started），并非 `create_trace` 所为。
- **为什么构成问题**：时序图与调用图把三段状态推进错误归属给 `create_trace()`。职责描述不准确（低影响，但属事实性错误）。

---

## Finding 9 — 离线调用图边关系与实际调用层级不符

- **严重级**：minor
- **文档位置**：§2.4 离线调用图（PY1/PY2/PY3 → PSO；VAC → RDS → CLN → WCK 链）、§2.4 模块表（"offline/verifier + canonicalize + checkpoint | …dormant 复评与 TTL 清理…"）
- **文档断言**：三 Python 管线调用 `promoteStagedOutputs()`；`verifyAndCanonicalize()` → `runDormantRescore()` → `removeDormantBefore()` → `writeCheckpoint()` 呈调用链；"dormant 复评与 TTL 清理"归 verifier/canonicalize/checkpoint 模块。
- **代码事实**：`packages/agent-server/src/offline/scheduler.ts` 的 `runDailyEvolution` 内：
  - `:90` 调 `pipelineFn`（`runOfflinePipeline`）产出 skills/sops/cards.json；`:91` 调 `promoteFn`（`promoteStagedOutputs`）——两者是 `runDailyEvolution` 的**顺序兄弟调用**，Python 子进程并不调用 `promoteStagedOutputs`（子进程只写 JSON，见 pipeline.ts）。
  - `:106-135` 调 `runDormantRescore` + `verifyAndCanonicalize`（dormant 复评），`:142` 调 `removeDormantBefore`，`:145` 调 `writeCheckpoint`——同为 `runDailyEvolution` 的平级阶段，非嵌套调用链。
  - `runDormantRescore` 定义在 `pipeline.ts:140`，`removeDormantBefore` 是 `experience-store.ts` 的 store 方法，均不在 verifier/canonicalize/checkpoint 模块。
- **为什么构成问题**：调用图把"顺序执行的阶段"画成"嵌套调用链"（VAC→RDS→CLN→WCK），且把 `promoteStagedOutputs` 画成 Python 管线的下游，与实际调用层级不符；模块表将"dormant 复评与 TTL 清理"错配到 verifier/canonicalize/checkpoint。

---

## 附：已核实且与代码一致（不列为问题）的断言

- 函数名与文件均存在且职责一致：`handleStream`(proxy-handler.ts)、`lastUserText`(proxy-handler.ts:130，私有，跳过 `<system-reminder>`)、`retrieve`/`buildFtsQuery`/`cosineScore`(retrieval.ts)、`buildInjection`(injection.ts)、`buildSkillCatalog`(skill-catalog.ts)、`buildSopSchemas`(sop-schema.ts)、`SessionWriter`/`buildAssistantMessage`(session-writer.ts)、`validateToolCallStream`(toolcall-validator.ts)、`recordRequestTrace`(experience-store.ts 方法)、`etlSessionFiles`(etl.ts)、`runOfflinePipeline`/`collectTrajectories`/`runDormantRescore`(pipeline.ts)、`promoteStagedOutputs`/`verifyAndCanonicalize`(verifier.ts)、`writeCheckpoint`(checkpoint.ts)、`runDailyEvolution`(scheduler.ts)、`run-evolution.ts` 三命令(单次/--loop/--status)、`schedule.ts` cron/launchd、gateway 侧 `execute_with_escalation`/`begin_escalation`/`finish_escalation`(chat.py)、`evaluate_quality`(quality.py)、`scan_envelope`(security/dlp.py)、`BudgetLedger.reserve`(store/budget_ledger.py)、`TraceStore.create_trace`/`record_model_run`(store/trace_store.py)、`OmlxProvider.complete`/`KimiProvider.complete`。
- 阈值与参数：晋升阈值 `PROMOTION_THRESHOLD=0.5`(verifier.ts)、bm25 top-24(`min(limit*3,24)`)、余弦重排 top-8(`RETRIEVAL_LIMIT=8`)、SKILL top-10、SOP top-15、dormant 复评 200 条/批、TTL 30 天、容量 10000、升级四规则顺序 `invalid_tool_schema→finish_reason_length→empty_output→forced_tool_missing`(quality.py:88-96)、前置错误码 422/403/429(errors.py:12/16/17)、升级每请求仅一次、云端结果不二次门控(仅记录 cloud_finish_reason，chat.py finish_escalation)。
- x-gateway 三种载体：响应头(`chat.py` `response.headers["x-gateway"]`)、body 内嵌 `x_gateway`(`build_openai_response`)、SSE 注释 `: x-gateway`(`format_sse_comment`)。
- 双 SQLite 物理隔离：gateway `var/agent_gateway.db`(config.toml) vs agent-server `var/experience.db`(EXPERIENCE_STORE_PATH)，两个独立文件。
- 快照只读检索/换载：`ExperienceStore.readDb`(snapshotPath 只读连接)服务 `search`/`listActive`，写路径走 `this.db`(live)；`eval/snapshot_store.py` 用 SQLite backup 生成快照，重启换载。
- 注入双层开关：server 级 `AGENT_SERVER_INJECTION`(server.ts) + 请求级 `options.injection`/body `injection`(proxy-handler.ts / server.ts)。
- "checkpoint 幂等（ckpt-sha256[:16]）"：`writeCheckpoint` 生成 `ckpt-<sha256 前16>` 且 `INSERT OR IGNORE`(checkpoint.ts / experience-store.ts)。
