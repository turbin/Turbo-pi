# M1（T0+T1）开发决策记录：F0 归因数据通道 + 离线管线最小断点

日期：2026-08-14
状态：**已实施，测试全绿（279 TS + 38 Python + 54 eval）**
依据：`plans/2026-08-14-post-c-unified-fix-batch-plan.md` v5（§1 F0、§5 管线断点）；`plans/2026-08-14-fix-batch-dev-tasks.md`（T0/T1 行、§2 TDD 协议、§4 环境约束）；`doc/issues-snapshot/issue-013-request-id-collision-trace-merge.md`；issue-002 余留（管线断点）

## 1. TDD 过程记录（先红后绿）

### T0：issue-013 回归测试（`test/regressions/issue-013-request-id-collision.test.ts`，7 例）

先写断言后实现，首跑 7/7 红（旧代码）：

1. **requestId 非计数器序列**（红因：旧代码 `String(request.id)` 为 Fastify 每进程 req-N 计数器，不匹配 UUID 正则）
2. **两阶段 upsert 不覆盖 retrieved/injected 字段**（红因：无 injected_ids 列/输入）
3. **同 id 冲突不合并阶段一字段（合并哨兵）**（红因：同上，列不存在）
4. **真实请求链 injected_ids ⊆ retrieved_ids**（红因：同 2）
5. **task_id 透传到 session 头 metadata 与 trace 行**（红因：无 task_id 解析与列）
6. **/api/stream 纳入 trace 落库**（红因：该路径不传 requestId，无 trace 行）
7. **旧库迁移补列 + 安全默认值**（红因：initSchema 无迁移逻辑）

实现过程中测试暴露的**实现缺陷**（测试先行价值的直接证据）：

- 初版 upsert 用 `COALESCE(excluded.injected_ids, ...)` 合并——phase-2（completion）调用未提供 injectedIds，但绑定 `JSON.stringify(undefined ?? [])` = `'[]'`，COALESCE 无法区分"未提供"与"显式空集"，把 phase-1.5 的注入集覆写成 `[]`（测试 2、4 红）。修复：DO UPDATE 子句改用**独立 NULL 哨兵参数**（见 §2 决策 T0-4）。
- 测试的 fetch mock 复用同一 Response 对象（SSE body 流只能消费一次），第二请求 502——测试侧改用 per-call body 工厂。

### T1：断点回归测试（`python/tests/test_issue002_pipeline_resume.py`，6 例）

先写断言后实现，首跑 6/6 红（`score_trajectories`/`ScoreJournal` 不存在，收集期 ImportError）。测试暴露的测试侧问题（非实现缺陷）：

- `CrashOnTask` 包装器缺 `criteria/scale/K` 属性（指纹计算读取）——加 `__getattr__` 委托；
- 崩溃匹配对象是任务**描述文本**而非 task_id（`score_pair(task, ...)` 收到的是描述）；
- "半截行"场景构造：若该 key 已有哈希匹配的有效条目，复用是正确语义（哈希即凭证）；真实崩溃场景是"该 key 从未落盘 + 半截行"，按此构造断言。

## 2. 设计决策（每条附理由）

### T0 归因数据通道（issue-013）

**T0-1 requestId 改 randomUUID（/v1 与 /api/stream 两路径一致）**
理由：Fastify 每进程 base-36 计数器实例重启即重置、双实例各自计数，跨日/跨实例必然碰撞（C 库 D2-D7 检索记录全失的根因）。randomUUID 全局唯一，且与响应体 `chatcmpl-<uuid>` 同源（node:crypto），无序列可预测。`reply.header("x-request-id")`、session 头 metadata、request_traces 行三处同用该值（O spec R4 契约不变）。

**T0-2 injected_ids 口径 = EVIDENCE 实际入 prompt 者 + Method/Guard 截取 top-5 后的 id**
- EVIDENCE：过滤后实际进入 `<Extra Info>` 池的全部卡 id；
- ABILITY：排序截取 METHOD_LIMIT/GUARD_LIMIT（5）**之后**的 id（过滤掉 malformed 者，与内容组装同一集合）；
- 无 blocks 或无 user 消息可 splice 时列表为空（"实际入 prompt"语义）；
- **SKILL/SOP 显式排除**（方案 §1-2 预留的口径选项）：SKILL 走 systemPrompt catalog、SOP 走 tools 合并，均为独立通道，混入会污染"检索→注入"归因口径；如需另行加 injected_skill_ids/injected_sop_ids，留待后续批次；
- 注入关闭（对照臂）时写显式 `[]`——与"检索未命中"在语义上可区分。

**T0-3 两阶段 upsert 扩展字段，阶段一字段保持 first-write-wins**
retrieved_ids/ts/model/hit 仍不参与 ON CONFLICT 更新（合并哨兵：即使 id 冲突，检索记录也不被覆盖）；injected_ids/task_id 加入更新集，使 phase-1.5（注入组装后补写）与 phase-1（检索）可分写。

**T0-4 upsert 合并的 NULL 哨兵（关键实现决策）**
COALESCE(excluded.x, …) 无法区分"调用方未提供"与"显式空值"（两阶段调用天然省略字段）。injected_ids 列 NOT NULL DEFAULT '[]'，INSERT 路径绑定 `'[]'` 兜底，但 DO UPDATE 子句用**独立的 NULL 哨兵参数**：`injected_ids = COALESCE(?, request_traces.injected_ids)`，未提供时绑定 NULL → 保留 phase-1.5 值；显式 `[]`（对照臂）→ 写入 `[]`。task_id 列可空，直接用 `COALESCE(excluded.task_id, …)` 即可。

**T0-5 迁移机制：PRAGMA table_info 检查 + ALTER TABLE ADD COLUMN（initSchema 内）**
- 新库：CREATE TABLE IF NOT EXISTS 直接含新列；旧库：表已存在则 CREATE 为 no-op，随后 PRAGMA 检查缺列并 ALTER；
- 旧行回填：`injected_ids TEXT NOT NULL DEFAULT '[]'`（常量默认值，SQLite 允许）使存量行读回 `[]`；task_id 可空读回 NULL；
- 读取侧 `COALESCE(injected_ids,'[]') / COALESCE(task_id,'')` 双保险；
- **快照库 readonly 语义不受破坏**：initSchema 只跑 live 库（this.db），快照（readDb）仅服务 experiences 检索读，从不被 ALTER（与 M10/issue-006 的写侧-读侧分离一致）。

**T0-6 /api/stream 路径定案：纳入 trace 落库（与 /v1 同口径）**
理由：
1. /api/stream 是 pi 原生路径（SPEC §4.1），/v1/chat/completions 是其 OpenAI 兼容别名——同一 handleStream 管线两个入口。若豁免，F2 归因（injected_ids × 任务分数）对走原生路径的客户端系统性盲区；
2. 该路径已写 session JSONL（experience_injection 条目），纳入后 requestId 在响应头/session 头/trace 行三者一致，与 /v1 同契约，可审计闭环；
3. 成本为零：handleStream 已有完整检索字段与两阶段 upsert，仅需传入 requestId；
4. 风险评估：trace 行数随请求量线性增长（按 id 唯一，无合并），无额外风险。
实现：server.ts /api/stream handler 生成 requestId、设置 x-request-id 头、传入 handleStream；proxy-handler 的 `if (opts.requestId)` 守卫从"无 id 即豁免"转为"有 id 即落库"。

**T0-6 修正声明（2026-08-14 打回修复，主会话 review 独立核实）**：原文本节理由 3 称"handleStream 已有完整检索字段与两阶段 upsert，仅需传入 requestId"——**表述失真**：handleStream 当时只写阶段一（检索）与阶段一点五（注入集），从不写阶段二（completion），/api/stream 的 trace 行 finish_reason/prompt_tokens/completion_tokens/latency_ms 永远 NULL，与 /v1（streaming 走 traceStreamCompletion、非 streaming 走 server.ts 完成点）不对称。本次补齐：
1. `teeWithSessionClose` 增加 `onClosed(customType, data)` 回调（writer 关闭后执行），handleStream 在其完成点写阶段二——`response_completed` 时以 done/error 事件的 reason+usage 写 finish_reason/tokens/latency（toolUse→tool_calls；usage 为 pi-ai 形态 input/output/cacheRead/cacheWrite，与 gateway 的 prompt_tokens/completion_tokens 数字等价；finish_reason 缺失兜底 "stop"，与 traceStreamCompletion 同款）；
2. 底层流异常（tee pull catch）写 `finishReason:"error"`（与 traceStreamCompletion catch 分支同口径）；客户端取消（aborted）不写阶段二（与 traceStreamCompletion cancel 分支一致）；
3. gateway 建流失败等 handleStream 抛错路径补写 `finishReason:"error"` + error 消息（与 /v1 catch 分支同口径）。
回归证据：`test/regressions/issue-013-stream-completion-phase.test.ts`（pi-test 写，先红后绿）断言 /api/stream 完成后 trace 行 finishReason="stop"/promptTokens=10/completionTokens=3/latencyMs≥0。

**T0-7 task_id 透传链：campaign.py（extra_body）→ /v1 body.task_id → session 头 metadata → request_traces.task_id**
- campaign.py `run_agent` 的 `task_id` 为**必选关键字参数**（沿用 C1 对 injection 的纪律先例：缺归因键是静默数据质量损失，不允许缺省；4 处既有测试同步更新）；
- /v1 解析 `body.task_id`（OpenAI 兼容 snake_case）；/api/stream 解析 `body.taskId`（pi 原生协议 camelCase，与 types.ts 现有 `sessionId/maxTokens` 同约定）；
- 非空字符串才透传；不带 task_id 的生产 pi 客户端不受影响（taskId 可空，COALESCE 读回 ""）；
- 值仅入 metadata 与 trace 行，不透传给上游 gateway（归因键不污染模型请求）。

### T1 离线管线最小断点（issue-002 余留）

**T1-1 断点单元 = 任务组（task_id），非单次打分调用**
理由：打分在组粒度产出（同 task_id 多轨迹走 PPT 锦标赛出组内归一化质量，单轨迹走 vs_reference），组内结果不可拆分；按组落盘使 journal 条目数与组数同阶（C 阶段 ~20-40 组/夜），fsync 次数可接受。

**T1-2 输入哈希 = 打分 prompt 指纹 + 轨迹内容（防脏复用）**
- prompt 指纹 = sha256(PAIRWISE_TEMPLATE + REFERENCE_TRAJECTORY + 各标准 description + G + K) 前 16 字节——任一打分参数变化即全部缓存失效（自动过期，无手工版本号）；
- 组哈希 = 指纹 + 任务文本 + 组内全部轨迹文本（按序）——新增/变更轨迹（新 session 补录）该组自动重打；
- 哈希匹配 + 数量对齐才复用；`score_threshold` 不参与哈希（质量与阈值正交，阈值变化只需重算 accepted）。

**T1-3 落盘方式：JSONL 增量 append + flush + fsync**
每组分完立即追加（崩溃不丢已完成部分）；load() 按 key last-write-wins、跳过损坏半截行（该 key 视为未完成重打——真实崩溃现场是"该 key 从未落盘"，半截行后无有效条目）；已有哈希匹配条目时半截行不影响复用（哈希即凭证）。

**T1-4 resume 语义：幂等跳过**
同 run 目录重复运行即跳过哈希匹配组（--resume 与重复运行同一机制）；TS 侧 `--resume <run_dir>` 复用给定目录，普通运行创建 `var/offline/runs/<ts>`（ISO 时间戳，冒号/点替换为 `-`）。PPT 组 resume 不重跑锦标赛，tournaments 报告只含本轮实际重打的组（审计可见性取舍，mock 打分对输入确定性，产物与全新跑一致——测试断言逐位一致）。

**T1-5 TS/Python 分工与"双副本"收敛**
- TS：创建/透传 run 目录（run-evolution CLI → scheduler → runOfflinePipeline/runDormantRescore 的 `--run-dir`）；不读不写产物；
- Python：产物读写与跳过逻辑全部在 `verification_selection`（新模块 checkpoint.py 的 `ScoreJournal`/哈希 + pipeline.py 的 `score_trajectories_with_checkpoint`）；
- 双副本核查结论：打分代码只存在于 `verification_selection`（verifier.py 为唯一实现，skill_evolution 的 llm_client.py 副本不打分、不涉及）；"两处" = 主管线 CLI 与 --rescore CLI 两个入口，两者共用同一 journal/哈希机制（收敛为共享 checkpoint 模块），无第二份打分代码需要同步。
- runDir 未配置时（库模式/直跑 CLI）零 IO，行为与改造前完全一致。

**T1-6 loop 模式与 --resume 组合**
`--loop --resume <dir>` 每轮复用同一目录：哈希匹配跳过旧 session 打分、新 session 自动补打——安全且高效（ETL 全量重扫的代价保留，打分代价消除）。

## 3. 边界与遗留风险

1. **既有 request_traces 数据仍不可信**（F0 修复前落库者）：修复不回溯旧行；派生看板口径按方案 §1-4 声明归档。C 判据结论不经 request_traces，不受影响。
2. **PPT 组 resume 后 tournaments 报告不含缓存组**：仅影响审计展示，不影响卡片产物；如需完整报告可后续把 normalized/counts 一并落盘。
3. **提取（LLM 结构化）阶段不在断点范围**：崩溃发生在打分完成之后、cards.json 写出之前时，resume 会重跑提取（分数复用，LLM 调用仍花在提取上）——按方案 §5 范围（打分最贵阶段优先），ETL/提取断点视 office 先行阶段故障率再定。
4. **`--resume` 目录不存在时**：mkdir 后当全新目录处理（全量重打）——幂等安全，不报错。
5. **campaign.py task_id 必选参数**：外部调用方（非本仓库脚本）若直接调 run_agent 会 TypeError——仓库内无其他调用方（已 grep 确认），属预期破坏。
6. **eval/results/ 下 campaign 工件使 `check:pinned-deps` 持续失败**：pre-existing（gitignore 的 C 阶段产物，stash 前后一致失败），本次不修；`npm run check` 其余阶段（biome/ts-imports/shrinkwrap/install-lock/tsgo/browser-smoke）全部干净。

## 4. 测试与检查结果

- TS：`packages/agent-server` 全包 284 通过（31 文件，含新增 issue-013 主回归 7 例 + pi-test 补 injected-ids-granularity 4 例 + stream-completion-phase 1 例（打回修复的红例）、pipeline --run-dir 转发 1 例、run-evolution resume 2 例）；Node 25 经 `scripts/with-node25.sh`。
- Python：`python/tests/` 41 通过（含 test_issue002_pipeline_resume.py 6 例 + pi-test 补 test_issue002_resume_fingerprint.py 3 例）；eval `tests/` 54 通过（campaign task_id 断言更新 + 4 处调用点）。
- `npx tsgo --noEmit`：0 错误；biome：0 问题；ts-imports/shrinkwrap/install-lock/browser-smoke 全过。
- 唯一 check 失败项：`check:pinned-deps`（pre-existing，见 §3-6）。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§1 F0、§5 管线断点）；plans/2026-08-14-fix-batch-dev-tasks.md（T0/T1）；doc/issues-snapshot/issue-013-request-id-collision-trace-merge.md；doc/issues-snapshot/issue-002-evolution-logprobs-json-truncation.md（余留）
