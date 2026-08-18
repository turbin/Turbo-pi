# 对抗式审查报告：round 3 修订稿对账（2026-08-14 C 后统一修改方案 v2）

日期：2026-08-14
对象：doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md（v2 全文重写稿）
依据：round-2.md 第 4 节 11 项核查清单 + F-18 落实确认（答辩方选择 a+b 组合）

## 1. 核查清单逐项对账

| # | 核查项（来源） | 结果 | 对账证据（修订稿） |
|---|---|---|---|
| 1 | F0 批次：randomUUID、注入集落库、task_id 透传、既有 trace 数据处置声明（F-1/F-2/F-3） | **通过** | §1-1（randomUUID，server.ts:165）、§1-2（injected_ids 新列 + SKILL/SOP 显式排除或另列）、§1-3（harness→session 头→request_traces 链）、§1-4（request_traces 及派生看板 hit-rate/stats 页标记不可信/归档）；边界声明（§1 末段）正确限定受污染面且覆盖 C 判据不受污染的事实（与 round-2 补充说明 2 核实一致） |
| 2 | issue-013 登记 + index 更新 + TS 回归测试落点（F-1） | **通过** | §1-5：issue 文件路径、index 更新随 F0 同 commit、`packages/agent-server/test/regressions/issue-013-*.test.ts`（唯一性/碰撞合并哨兵，先红后绿） |
| 3 | F1 三处模块落点修正 + SOP/SKILL/EVIDENCE 豁免声明（F-4/F-5） | **通过** | §2-1（EXTRACTION_PROMPT + CARD_SCHEMA + cardsToStaged 三处，明示"不在 skill_evolution"）；§2-2（仅 Method/ABILITY、Python 打分侧 + TS 闸门两处落点、SOP/SKILL/EVIDENCE 显式豁免并写入决策记录）；§2-3 重蒸定案 + 4-6h 耗时估算 |
| 4 | F2 对照校准口径与功效预算（F-6） | **通过** | §3-6：仅 D1/D7 可校准、其余日跳过不做跨日近似；n=20 功效有限声明（红线 6 全量为准不外推）；对照臂每日同跑纳入后续 campaign 设计并计成本 |
| 5 | F2 降权落地形态 + 台账 1 达成度表述（F-7） | **通过** | §3-3：confidence 降低→retrieval.ts 排序降权、quality 不动；首版仅降权不自动降级、降级触发人工确认；台账 1 首版达成度表述为"降权+人工确认降级通道，非全自动闭环"——如实 |
| 6 | F2 confidence 迁移：user_version + 快照再生 + 兼容读取（F-8） | **通过** | §3-5：ALTER TABLE + user_version 版本化 + 快照再生流程 + COALESCE 兼容读取，四项齐全 |
| 7 | F3 验收口径对齐（F-18-a）+ ETL 打标路径（F-18-b）+ 工期上修 | **通过** | §4-2b（ETL 打标：复用 F0 task_id 透传 + 任务→域注册表，EVIDENCE 纳入过滤范围）；§4 验收口径修订（"带 domain 标签卡（含 ETL 打标 EVIDENCE）跨域注入为零" + 存量未回填卡窗口期风险显式接受声明）；回归测试含"无标签卡仍可见"；§4 预估 1.5-2 天人工工时 + A/B 实测日历时间另计 |
| 8 | §6-1 方案 A 口径修正（F-10） | **通过** | §6-1：注明 plan-b-rerun:25 的 agent-local 口径已被 08-09 实测否决（routing.py:31），以修正版为准（双臂 agent-auto + pilot 800/1024 + <5% 门控预注册），并承诺批准时同步修正 plan-b-rerun 文件 |
| 9 | §7 措辞（保持 fixed、修复后无复发）+ INDEX 已完成标注（F-11/F-16） | **通过** | §7：全部保持 fixed、下一发布周期后评估 closed；发布周期口径写明（changelog 0.80.10/07-16 + Release v0.81.0 提交 07-21 无 tag）；008/009 改"修复后（D1/D2 起）无复发"；§8 INDEX 标注已完成 |
| 10 | 重蒸语料量/耗时估算（F-13） | **通过** | §2-3：920 卡对应 7 日语料，按 35-45min/夜推算 4-6h，分批夜间执行——与 C 报告实测口径一致 |
| 11 | Python 侧测试落点声明（F-17） | **通过** | §2-4：TS 侧 + Python 侧（CARD_SCHEMA 校验 + 打分封顶哨兵，参照 test_issue002_pipeline_resilience.py 惯例） |

**11/11 通过。**

## 2. F-18 落实确认

答辩方选择 **a+b 组合**（§4-2b + §4 验收口径修订），确认：

- **b（ETL 打标路径）**：§4-2b 已写——EVIDENCE 直插不经蒸馏，须在 ETL 摄入时按 session 所属任务打域，复用 F0 task_id 透传 + 任务→域注册表。方案层面成立（依赖链 F0→F3 在执行顺序中已串行保证）。
- **a（验收口径修订）**：验收改为"带 domain 标签卡（含 ETL 打标 EVIDENCE）的跨域注入为零"，并保留窗口期声明——存量 920 卡在 F1 重蒸完成前无标签、按"无 domain 不过滤"仍跨域可见，该窗口期风险显式接受而非掩盖。与 §4-3（重蒸顺带打标，默认域 office）自洽。
- 工期上修 1.5-2 天人工工时（含 ETL 路径+在线通道+回填），混合库 A/B 实测日历时间另计——口径合理。

**F-18 确认关闭。**

## 3. 新增发现（minor，不构成阻塞，建议并入修订稿）

### F-19（minor，维度 1）：F0 的 requestId 修复仅覆盖 /v1 路径，/api/stream 路径不落 trace 未处置

- 问题陈述：F0 改动点 1 只引 `server.ts:165`（/v1/chat/completions 路径）。`/api/stream` 路由（server.ts:150-161）调用 handleStream 时不传 requestId，proxy-handler 的 `if (opts.requestId)` 守卫（proxy-handler.ts:66-79）使该路径**从不写 request_traces**。若该路径（pi 原生客户端/生产口径）未来也需归因，数据通道仍缺失。建议 F0 增补一条：/api/stream 路径同样传 requestId 并落 trace，或显式声明"该路径不落 trace"的边界及理由。
- 证据：`packages/agent-server/src/server.ts:150-161`（无 requestId 入参）；`packages/agent-server/src/proxy-handler.ts:66-79`（requestId 守卫）。

### F-20（minor，维度 4）：INDEX.md 本方案条目仍是 v1 结构摘要

- 问题陈述：INDEX.md:193 的条目摘要描述的是 v1 结构（"修复批次 F1/F2/F3 + 台账 4 项 + 裁决 5 项"），未反映 v2 新增的前置批次 F0 与 issue-013 升格；§8 引用行号"188-194"中 194 为空白行（本方案条目在 :193）。按 INDEX 维护纪律（同 commit 登记/更新），建议修订稿定稿或 F0 实施时同步刷新摘要。
- 证据：`doc/design/INDEX.md:193`（现文本）、`:188-192`（五份 08-13 plans）。

## 4. 总结论

**共识达成。** round-2 第 4 节 11 项核查清单全部通过；F-18 的 a+b 组合落实确认；round-1 的 17 项发现全部关闭且修订稿均已体现；无维持项、无残留争议项阻塞用户审核。F-19/F-20 为两项新的 minor 级细化建议（/api/stream 路径 trace 边界声明、INDEX 摘要刷新），不构成方案阻塞，建议在修订稿定稿或 F0 实施时一并吸收，无需再开新轮。

审查闭环：round-1（17 项发现）→ round-2（17 项关闭 + F-18）→ round-3（11 项对账通过 + F-18 确认 + F-19/F-20 minor 建议）。方案可交用户审核。
