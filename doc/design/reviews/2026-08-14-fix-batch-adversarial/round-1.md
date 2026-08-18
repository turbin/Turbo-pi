# 对抗式审查报告：2026-08-14 C 后统一修改方案（round 1）

日期：2026-08-14
对象：doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md
方法：§0 实态核实表逐条代码级复核（含 backup/c-campaign-20260814 数据实证）；F1-F3 改动点对照现役代码；台账/裁决/流转项对照纪律与历史决策记录。
结论：**17 项发现（1 critical / 10 major / 6 minor）**。方案整体框架与台账吸收方向正确，但 F2 的归因数据前提与 F1 的模块落点存在实质性问题，§6 的 closed 建议违反仓库自身纪律。未发现需要全盘推翻的方案级缺陷，建议修正后交用户审核。

---

## Critical

### F-1：F2 的归因数据前提不成立——C campaign 历史 request_traces 只有 D1 期数据，跨日请求 ID 碰撞把 D2-D7 的 retrievedIds 全部丢失

- 维度：学习机制有效性（2）/ 实现一致性（1）
- 问题陈述：F2 改动点 1 声称"request_traces.retrievedIds × 任务分数 join，数据均已落库（§0-9 已核实）"，验收要求"对 C campaign 历史数据回放，机制能后验标出 issue-010 中致降分的卡"。但 §0-9 只核实了**代码写路径存在**，未核实 C 数据实际落库。实测 C 终态库 request_traces 共 860 行，ts 全部 ∈ {2026-08-09, 2026-08-10}，D2-D7（08-11~08-13）零行。根因：requestId 来自 Fastify 每进程 base-36 计数器（实例重启即重置；8789/8790 两实例同日也各自从 1 起），而 recordRequestTrace 是两阶段 upsert，ON CONFLICT 只更新 completion 字段，ts/retrieved_ids/hit 永久保留首写值——跨日/跨臂请求被静默合并成一行。方案未包含任何修复数据收集的改动，且 C 历史回放验收在现数据上不可执行。
- 证据：
  - `packages/agent-server/src/experience-store.ts:386-397` upsert 只更新 finish_reason/prompt_tokens/completion_tokens/latency_ms/error，不更新 ts/retrieved_ids/hit；
  - `backup/c-campaign-20260814/store/experience-c-final.db`：`SELECT substr(ts,1,10), COUNT(*) FROM request_traces GROUP BY 1` → 仅 08-09（491）+ 08-10（369）；hit=1 仅 4 行；860 行 request_id 为 req-10..req-z 单计数器序列；
  - D6 归档（08-13，515 个 session 文件）session 头 requestId 为 req-10、req-11、…，与库中既有行全部重叠（`/tmp/scd6/sessions/*.jsonl` vs `request_traces.request_id`，抽 20 个 id 全命中）；D3 归档 req-q..req-z 同样全命中；
  - D1 归档中同一 requestId（如 req-z）出现 2 次（8789/8790 双实例同库写入）；
  - `packages/agent-server/src/server.ts:165` `const requestId = String(request.id)`（Fastify 默认每进程计数器）。
- 修改建议：在 F2 之前增加前置批次"归因数据通道修复"：requestId 改用 randomUUID（或 trace 键复合 session+序号）；request_traces 增加 session/task 维度；记录**实际注入集**而非 retrieved 集（见 F-2）。C 历史回放验收改为不可行口径（或以 session JSONL 的 experience_injection 条目做近似回放，并显式声明 requestId 跨日碰撞、task 归属只能靠 workspace 路径字符串解析的误差）。

---

## Major

### F-2：credit assignment 未解决且奖惩对象错误——retrievedIds ≠ 注入集，SKILL/SOP 完全无归因信号

- 维度：学习机制有效性（2）
- 问题陈述：F2 奖惩规则对 retrievedIds 全体同奖同罚，但检索集与注入集不等价：buildInjection 对 Method/Guard 按 quality 截 top-5、跳过非 active/malformed 卡；SKILL（top-10）与 SOP（top-15）由 buildSkillCatalog/buildSopSchemas 独立检索注入，根本不出现在 retrievedIds 里。按现规则，被检索但未注入的卡也会被奖惩（高频检索卡被系统性过奖——正是方案声称要消除的"误赞"正反馈回路），而 SKILL/SOP 没有任何实战归因信号。设计 v2 §3.6 把"多卡共注入的 credit assignment"列为前置问题，F2 未给出任何分配方案。
- 证据：
  - `packages/agent-server/src/injection.ts:33` active 过滤、`:56` `slice(0, METHOD_LIMIT)`、`:58` topGuards 截取；
  - `packages/agent-server/src/injection.ts:88-102` SKILL/SOP 由 store 独立检索注入（不在 retrieved 参数内）；
  - `packages/agent-server/src/proxy-handler.ts:74` 落库的是 `retrieved.map(...)`（检索集）；
  - `doc/design/2026-08-13-agent-server-high-level-design-v2.md` §3.6 前置问题清单。
- 修改建议：F2 改动点 1 增加"实际注入集落库"（proxy-handler/server 注入路径同步写入注入 id 集）；奖惩对象改为注入集；对同任务多卡共注入给出明确分配策略（按角色/检索分数加权、或不动作仅记数）；SKILL/SOP 显式排除或走独立通道。

### F-3：任务分数与请求之间的 join 键不存在——run.jsonl 的 trace_ids 是无处落库的 chatcmpl id

- 维度：实现一致性（1）
- 问题陈述：F2 归因管道声称"纯离线计算"。但任务分数在 run.jsonl 中，其请求标识 trace_ids 是 agent-server 响应体自造的 `chatcmpl-<uuid>`，该 id 未写入 session 文件、未写入 request_traces、未写入 gateway 任何表。task → request → retrievedIds 的关联链在现落库数据中不存在；会话文件里 task 身份只隐含在 system 消息的 workspace 路径字符串中（非设计键）。
- 证据：
  - `packages/agent-server/src/server.ts:404` `id: chatcmpl-${randomUUID()}`；
  - `packages/agent-server/eval/results/campaign-c-20260809/run.jsonl` 每条记录的 trace_ids 均为 chatcmpl-*（首行示例）；
  - D3 session 归档（439 文件）grep chatcmpl 0 命中（`/tmp/scd3/sessions/*.jsonl`）；
  - `packages/agent-server/eval/campaign.py:118` `trace_ids.append(getattr(resp, "id", ""))`，未读 x-request-id 响应头。
- 修改建议：归因管道设计里新增 task_id/session 维度落库（harness 透传 task_id → session 头 metadata → request_traces 列），或明确采用 workspace 路径解析的近似映射并评估误配率；不接受"数据均已落库"的表述。

### F-4：F1 改动点 2 引错蒸馏模块——Method 卡的提取 prompt 在 verification_selection，不在 skill_evolution

- 维度：实现一致性（1）
- 问题陈述：issue-010 的致降分卡是 role=Method 的 ABILITY 卡（cards.json 产出）。其提取 prompt 是 verification_selection/pipeline.py 的 EXTRACTION_PROMPT，schema 校验在 experience.py CARD_SCHEMA。skill_evolution/prompts.py 产出的是 skills.json（SKILL 卡）。按方案引用的文件改 prompt 并重蒸馏 920 卡，Method 卡不会获得 deliverables 字段——主修复落空。
- 证据：
  - `packages/agent-server/python/verification_selection/pipeline.py:24` EXTRACTION_PROMPT（role: Method|Guard|Workflow）；
  - `packages/agent-server/python/verification_selection/experience.py:31-33` CARD_SCHEMA required = ["trigger","procedure","evidence","boundary","role"]（无 deliverables）；
  - `packages/agent-server/src/offline/verifier.ts:180-199` cardsToStaged 五元组 payload 映射；
  - `doc/issues-snapshot/issue-010-*.md` 注入内容为 Method 卡；§0-8 全 python/ grep deliverable 零命中（已复核属实）。
- 修改建议：F1 改动点 2 改为 verification_selection 的 EXTRACTION_PROMPT + CARD_SCHEMA（experience.py）+ TS 侧 cardsToStaged payload 映射三处；若 skill_evolution 也需要交付物维度，单列一项并说明理由。

### F-5：F1 改动点 3 落点无法承载交付物检查，且适用范围未划定——统一执行会冻结 EVIDENCE 晋升并破坏 SOP/SKILL 预验证通道

- 维度：实现一致性（1）
- 问题陈述：verifier.ts 只对 staged JSON 做阈值闸，无轨迹访问能力；"按卡执行的回放轨迹产出交付物"的判定只能在 Python verification_selection（持有 TeacherTrajectory 的打分处）实现，方案却只引 verifier.ts。更关键的是适用范围：EVIDENCE（ETL 句子级候选，无轨迹无交付物）、SKILL/SOP（quality=1 / utility 预验证通道，绕过 0.5 闸）若被统一"无交付封顶 <0.5"，整库晋升冻结、预验证通道破坏——与方案自述"红线 3 的细化而非变更"冲突。
- 证据：
  - `packages/agent-server/src/offline/verifier.ts:60` 唯一闸门 `item.quality >= PROMOTION_THRESHOLD`，模块无轨迹输入；
  - `packages/agent-server/src/offline/verifier.ts:147` skills quality=utility、`:169` SOP quality=1（预验证直通）；
  - `packages/agent-server/src/offline/etl.ts:44-59` EVIDENCE 候选无交付物概念；
  - `doc/design/2026-08-13-agent-server-high-level-design-v2.md` §6 红线 3、§3.3 局限声明。
- 修改建议：交付检查仅作用于 Method（ABILITY）卡；落点写明 Python verification_selection 打分标准/后处理 + TS 闸门二次校验两处；SOP/SKILL/EVIDENCE 显式豁免并写入决策记录。

### F-6：F2 对照臂校准在 D2-D6 无数据——对照臂仅 D1/D7 运行

- 维度：学习机制有效性（2）
- 问题陈述：F2 按日批次离线结算并依赖"对照臂（injection off）差值校准区分卡的作用与任务本身难"，但 campaign 设计对照臂仅 D1/D7 运行；D2-D6 无同日同任务对照分数，差值校准在多数结算日不可执行。方案未说明校准数据来源或对照臂扩日成本，也未见统计功效预算（红线 6 精神）。
- 证据：
  - `packages/agent-server/eval/campaign.py:6` "对照臂（仅 D1/D7）"、`:224` `arms["control"] = batch["repeat"]`；
  - `doc/design/2026-08-13-agent-server-high-level-design-v2.md` §3.6 "对照臂差值校准的统计功效"列为前置问题。
- 修改建议：明确校准口径（仅 D1/D7 可校准、其余日跳过校准或跨日近似），或将"对照臂每日同跑"纳入后续 campaign 设计并计入成本；补样本量/功效预算。

### F-7：最小样本阈值 ≥5 无依据、样本单位未定义——同任务多次注入不是独立样本

- 维度：学习机制有效性（2）
- 问题陈述：设计 v2 §3.6 把"最小样本阈值取值"列为前置问题，方案直接取 5，无来源。且注入次数 ≠ 独立样本：同任务多请求共享同一 judge 任务分数，一卡在同任务内注入 5 次仍是 1 个有效样本；重复集 n=20 的任务池下多数卡独立样本数远低于 5，"≥5 次注入才允许动作"实际可能永不触发或触发在伪样本上。
- 证据：
  - 方案 §2 改动点 2 "最小样本阈值 ≥5 次注入才允许动作"；
  - `packages/agent-server/eval/results/campaign-c-20260809/run.jsonl`：任务级单分数、任务内 11-20 次请求（首行示例）；
  - `doc/design/2026-08-13-agent-server-high-level-design-v2.md` §6 红线 6、§3.6。
- 修改建议：阈值按"独立任务数"定义（如 ≥3 个不同任务），给出取值来源（仿真/历史分布）并预注册；否则按红线 6 精神降级为"仅降权不降级"。

### F-8：F2 confidence 列 DDL 迁移无机制承载

- 维度：工程风险（3）
- 问题陈述：方案仅写"需 DDL 迁移"。现役 experience-store 无迁移框架：initSchema 只有 CREATE TABLE IF NOT EXISTS；快照库为 readonly 冻结副本（M10），存量 6 份每日快照 + archive 库均不含新列；无 user_version 版本化。直接加列后旧快照/归档读取与回滚语义均无交代。
- 证据：
  - `packages/agent-server/src/experience-store.ts:155-211` initSchema 无 ALTER/user_version；
  - `packages/agent-server/src/experience-store.ts:45-52` snapshotPath readonly 语义（M10）；
  - `backup/c-campaign-20260814/store/c-d{2..7}.db` + `packages/agent-server/var/eval/snapshots/` 多份冻结副本。
- 修改建议：F2 写明迁移方案：ALTER TABLE ADD COLUMN + user_version 版本化 + 快照再生流程 + 旧库读取兼容（COALESCE 默认值）。

### F-9：F3 无存量卡补标方案、在线通道未列——920 条 active 无 domain，域过滤会清零检索

- 维度：实现一致性（1）/ 工程风险（3）
- 问题陈述：F3 只给新卡"蒸馏自动打标"，920 条存量 active 卡无 domain；"bm25 召回后按 domain 过滤"严格执行则存量卡全部被滤除，C 重复集分数必退化——与 F3 自己的验收目标（C 重复集分数不因过滤退化）直接冲突。"harness 随请求传入 domain"的通道也不存在：/v1 路径只解析 temperature/max_tokens/stop/thinking/injection；/api/stream 的 ProxyStreamOptions 无 domain；session 头 metadata 只有 model/provider/requestId，"合成器 task_type/arm 元数据透传"无落点。
- 证据：
  - `packages/agent-server/src/server.ts:220-227` /v1 路径仅解析上述字段；
  - `packages/agent-server/src/types.ts:10-26` ProxyStreamOptions 无 domain；
  - `packages/agent-server/src/server.ts:208` session 头 metadata 仅 model/provider/requestId；
  - `backup/c-campaign-20260814/store/experience-c-final.db` active=920（实测），schema 无 domain 列（§0-1 已复核）。
- 修改建议：F3 增加：存量卡 domain 回填策略（默认 office 域或重蒸馏带标签）；在线请求/session 头 domain 字段的完整改动点清单（types.ts/server.ts/proxy-handler.ts/retrieval.ts/collectTrajectories/harness）；合成器元数据通道设计；工期重估（0.5-1 天不足以覆盖回填+双路径管线+A/B 实测）。

### F-10：§5-1 推荐的方案 A 继承已被实测否决的口径——plan-b-rerun 仍写 agent-local 绕门控

- 维度：工程风险（3）/ 流程合规（4）
- 问题陈述：统一方案推荐方案 A（冷+热双臂）并引用 plan-b-rerun，但该 plan 口径要点仍写"冷库臂可用 agent-local 路由（绕开门控，绝对纯净基线）"——08-09 对抗审查已实测否决（V1 路由忽略 model 名，agent-local 无绕门控语义），issue-003 文件"方案 A 的两处修正"第 1 条与 progress 文件均有记载。按现文批准 A，执行时可能按被否决口径跑 4 天。
- 证据：
  - `doc/design/plans/2026-08-13-plan-b-rerun-pure-27b.md:25` agent-local 口径；
  - `packages/agent-gateway/src/agent_gateway/routing.py:31` `del envelope, context  # V1: no per-request routing inputs yet`；
  - `doc/issues-snapshot/issue-003-*.md` 修复节修正 1；`doc/design/progress/2026-07-24-eval-benchmark.md:37`。
- 修改建议：§5-1 写明修正口径：双臂统一 agent-auto + pilot 校准 max_tokens（800/1024）+ 门控 <5% 预注册；或注明以 08-09 修正版为准，并同步修正 plan-b-rerun 文件。

### F-11：§6 的 fixed→closed 建议违反仓库自身纪律——零个发布周期无复发

- 维度：流程合规（4）
- 问题陈述：AGENTS.md 与 issues-snapshot 纪律：closed 判定需"一个发布周期无复发"。最近一次发布为 v0.81.0（2026-07-21），issue-001（08-05 修复）与 004~009（08-09~08-10 修复）修复后零个发布周期。且"issue-008/009 D1-D7 全程无复发"表述失实——两 issue 正是在本 campaign 的 D1/D2 发现并修复，准确表述为"修复后 5-6 天无复发"。
- 证据：
  - `git tag --sort=-creatordate`：最新 v0.81.0（2026-07-21）；
  - `doc/issues-snapshot/issue-008-*.md` 报告 08-09（D1 监视器告警）；issue-009 报告 08-10（D2）；
  - `doc/issues-snapshot/index.md` 状态图例；AGENTS.md "Issue Snapshot"节。
- 修改建议：§6 改为"保持 fixed，待下一个发布周期后评估 closed"；008/009 措辞改为"修复后无复发"。

---

## Minor

### F-12：§0 证据表两处行号/表述不精确

- 维度：实现一致性（1）
- 证据：`packages/agent-server/eval/gate_length_escalation.py:23`（方案写 :24）；`packages/agent-server/src/offline/run-evolution.ts:145` 为 CLI 分发起点（149-172 为分支块，可接受）；§0-2"仅 ETL 幂等"不准确——writeCheckpoint 同 id 重写为 no-op（checkpoint.ts docstring :10-15），checkpoint 同样幂等。结论不受影响。
- 建议：核实表按实测行号修正表述。

### F-13：工期口径混淆与重蒸馏耗时依据不明

- 维度：工程风险（3）
- 问题陈述：F1 预估 1-1.5 天，但其验收要求"短程验证 campaign（重复集 3 天）"（日历时间 ≥3 天 + 夜间进化）；存量 920 卡重蒸馏按 C 实测"每夜 35-45min 处理单日轨迹"（C 报告 §4）推算，7 天语料全量重蒸为若干小时，"~1.5h 管线运行"依据不明；且"重蒸或批量补字段"未定案（LLM 回填的质量风险与重蒸的成本是两种不同方案）。F3 的 0.5-1 天含"A/B 实测"+混合库 campaign 同理不现实。
- 证据：方案 §1 预估与验收；`doc/design/2026-08-14-agent-server-c-campaign-final-report.md` §4（35-45min/夜）。
- 建议：预估统一标注"人工工时 vs 日历时间"，重蒸给出语料量与单卡成本估算，补字段与重蒸二选一定案。

### F-14：F2 降级可被现役 dormant 复评原路晋升——无排除机制

- 维度：学习机制有效性（2）
- 问题陈述：被实战降 dormant 的卡仍进入 runDormantRescore 复评（每批最老 200 条），复评用同一 vs_reference 自评分数——该分数正是 issue-010 证明与实战结果脱钩的同一盲区，降级卡可经"自评复升→再注入→再失败"循环。注：dormant 池已满 10000（实测），新降级卡排队位次靠后有部分缓解，但不构成机制保证。
- 证据：`packages/agent-server/src/offline/scheduler.ts:106-141`；`packages/agent-server/python/verification_selection/pipeline.py:200-239` _rescore_cli vs_reference 口径；`backup/c-campaign-20260814/store/experience-c-final.db` dormant=10000。
- 建议：F2 增加排除机制：实战降级卡跳过复评 N 批或带降级标记需实战证据才可复升。

### F-15：F2-3 "检索降权"未列检索侧改动点

- 维度：实现一致性（1）
- 问题陈述：现役检索排序为 bm25+余弦（quality/confidence 完全不参与检索排序，quality 仅用于 Method/Guard 注入截取）。实现"高确信低样本卡检索降权"必须改 retrieve()/search()，方案未引 retrieval.ts/experience-store.ts 检索路径。
- 证据：`packages/agent-server/src/retrieval.ts:12-17`、`:61-68`；`packages/agent-server/src/injection.ts:56-63`。
- 建议：F2 改动点补 retrieval.ts / store.search 的排序加权改动。

### F-16：§7 的 INDEX 补登记为已完成工作

- 维度：流程合规（4）
- 问题陈述：INDEX.md 已于 08-14 更新（六份 plans 含本方案均已登记），方案 §7 把"补登记"列为"本方案附带执行"，易误判为未做。
- 证据：`doc/design/INDEX.md:4`、`:188-193`。
- 建议：改为"已登记（同 commit，INDEX.md:188-193）"或删除该执行项。

### F-17：F1 回归测试落点覆盖不足——Python 侧缺声明

- 维度：流程合规（4）
- 问题陈述：按 F-4/F-5 修正后，交付物检查与 CARD_SCHEMA 校验的实现主体在 Python verification_selection，回归测试应为 python/tests/ 侧（参照 test_issue002_pipeline_resilience.py 的落点惯例），方案只声明 TS `packages/agent-server/test/regressions/issue-010-*.test.ts`（TS 落点本身符合 AGENTS.md 纪律，但覆盖不了 Python 侧逻辑）。
- 证据：`packages/agent-server/python/tests/test_issue002_pipeline_resilience.py` 为 Python 侧回归惯例；方案 §1 改动点 5。
- 建议：F1 测试计划补充 Python 侧落点声明（schema 校验 + 打分封顶哨兵）。

---

## 附：§0 实态核实表复核结论

逐条复核结果（全部经代码/数据实证）：

| # | 项 | 方案结论 | 复核 |
|---|---|---|---|
| 1 | deliverables/domain/confidence 未建 | 未建 | 属实（types.ts:28-39；全 src grep 零命中） |
| 2 | 断点/--resume 未建 | 未建 | 属实（checkpoint.ts 整轮粒度；run-evolution.ts CLI 仅 --status/--loop） |
| 3 | verifier 交付物检查未建 | 未建 | 属实（verifier.ts:60 唯一闸门） |
| 4 | active 降级通道未建 | 未建 | 属实（scheduler.ts:106 仅 listDormant；verifier.ts 同 hash active 直接 continue） |
| 5 | x-gateway marker 无 trace_id | 未建 | 属实（chat.py:84-108 字段清单；:135 trace_id 仅作响应体 id） |
| 6 | DLP 不扫 tools[] | 部分建 | 属实（dlp.py:14-18 三模式；scan_envelope 仅 messages+tool_calls） |
| 7 | ETL 完整性校验未建 | 未建 | 属实（etl.ts:88 malformed 跳过；error/aborted 流仍摄入） |
| 8 | 蒸馏 prompt 无交付物 | 未建 | 属实（python/ 全量 grep 零命中） |
| 9 | retrievedIds 落库 | 已建 | **代码写路径已建**（experience-store.ts:96/405/429；server.ts:253；proxy-handler.ts:74），但 C campaign 实际数据因 request_id 碰撞丢失 D2-D7（见 F-1）——"数据前提已具备"的结论不成立 |
| 10 | gate_length_escalation.py 门控 | 已建 | 属实（:23 DEFAULT_MAX_RATE=0.05） |

唯一实质修正：§0 结论中"F1-F3 三批次的数据前提（retrievedIds）已具备"应改为"代码写路径已具备，历史数据不满足 F2 回放前提（F-1）"。
