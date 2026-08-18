# 对抗式审查报告：round 2 裁决（2026-08-14 C 后统一修改方案）

日期：2026-08-14
对象：答辩方 round-1 回复（doc/design/reviews/2026-08-14-fix-batch-adversarial/round-1-response.md）

## 0. F-11 证据反驳的独立复核（先于裁决）

答辩方反驳"本仓库无 git tags、'v0.81.0 (2026-07-21)'标签不存在、changelog 最新 0.80.10"。独立复核结果：

- `git tag`：空；`git ls-remote --tags origin`：空——**本仓库确实无任何 tag**。我 round-1 的 F-11 证据行"git tag: 最新 v0.81.0 (2026-07-21)"是把 `git log --grep=Release` 的输出误记为 tag 输出，**引用错误，接受答辩方反驳**。
- `packages/coding-agent/CHANGELOG.md`（及各包）最新发布版章节为 `[0.80.10] - 2026-07-16`——**属实**。
- 补充事实（答辩未提及但利于其结论）：main 上存在 `9c480b6a Release v0.81.0`（2026-07-21）提交（无对应 tag、changelog 无该版本章节）。无论以 changelog 版本（07-16）还是以 Release 提交（07-21）计发布周期，issue-001（08-05）与 004~009（08-09~08-10）修复后均为**零个发布周期**——F-11 实质结论不受证据修正影响，成立。

## 1. 逐条裁决

| # | round-1 严重度 | 裁决 | 理由 |
|---|---|---|---|
| F-1 | critical | **关闭** | 答辩方独立复跑数据实证一致（860 行、ts 08-09/08-10、4 hit、860 distinct）；升格登记 issue-013 并新增前置批次 F0（randomUUID + 注入集落库 + task_id 透传）为正确处置。附修订稿核查项：F0 须含**既有 request_traces 数据的处置声明**（F0 修复前数据作废/归档标记），issue-013 按纪律入 doc/issues-snapshot/ 并配 `packages/agent-server/test/regressions/issue-013-*.test.ts`（碰撞/唯一性哨兵） |
| F-2 | major | **关闭** | F0 落"实际注入集"直接响应本发现 |
| F-3 | major | **关闭** | F0 的 task_id harness→session 头→request_traces 透传补上 join 键 |
| F-4 | major | **关闭** | 修订承诺"F1 模块落点三处修正"（verification_selection EXTRACTION_PROMPT + CARD_SCHEMA + cardsToStaged） |
| F-5 | major | **关闭** | 修订承诺含 Method 限定 + Python/TS 两处落点；附核查项：SOP/SKILL/EVIDENCE 豁免须在修订稿显式写明 |
| F-6 | major | **关闭（附硬核查项）** | 答辩整体接受，但修订承诺清单未点名 F-6。修订稿 F2 节**必须**出现对照校准口径（仅 D1/D7 校准、其余日跳过或跨日近似，或对照臂扩日成本）与功效预算；缺席则 round 3 升回维持 |
| F-7 | major | **关闭** | "独立任务数 ≥3（预注册）+ 首版仅降权不自动降级"比原建议更保守，合理。附核查项：修订稿须定义"降权"落地形态（quality / confidence / 排序权重之一或组合），并说明与台账 1（active 降级通道）首版达成度的关系 |
| F-8 | major | **关闭** | 修订承诺含迁移方案；核查项：须含 user_version 版本化 + 快照再生 + 旧库读取兼容 |
| F-9 | major | **关闭（附新发现 F-18 关联项）** | "无 domain 不过滤"兼容规则 + 重蒸顺带打标 + 通道清单 + 工期上修 1-2 天均合理；但兼容规则与 F3 验收目标存在冲突（见 F-18），须在修订稿一并处理 |
| F-10 | major | **关闭** | 修订承诺含"§5-1 口径修正" |
| F-11 | major | **关闭** | 证据以复核修正为准（无 tags；changelog 0.80.10/07-16；Release 提交 9c480b6a/07-21 亦早于全部修复）；实质结论接受 + §6 措辞修正承诺 |
| F-12 | minor | **关闭** | 接受 |
| F-13 | minor | **关闭** | 重蒸/补字段定案为重蒸（LLM 回填无验证通道，判断正确）；核查项：重蒸语料量与耗时估算建议仍写入修订稿 |
| F-14 | minor | **关闭** | 补充说明 3 明确"复升排除机制配套" |
| F-15 | minor | **关闭** | 修订承诺含"检索侧改动点" |
| F-16 | minor | **关闭** | §7 标注已完成 |
| F-17 | minor | **关闭** | 修订承诺含 Python 侧测试落点 |

17 项全部关闭（F-1/F-6/F-7/F-8/F-9 带修订稿核查项）。

## 2. 对 5 点补充说明的表态

1. **F-1 升格 issue-013 + 前置批次 F0**：**同意**。附注：F0 范围建议再含一条——request_traces 派生消费面的数据声明（hit-rate 看板 `/api/stats/hit-rate`、stats 页在 campaign 期间同样受碰撞合并污染，F0 修复前的此类数据应标记不可信，防止后续分析误用）。
2. **C 结论不受污染的边界声明**：**同意**（已独立核实：C 判据升级率口径为 gateway model_runs 全量 + x-gateway 标记，归因 +10.3pp 用 run.jsonl 臂×日分数，D3 注入内容审查用 session tar 的 custom_message——三者均不经 request_traces，结论确实不受 F-1 影响）。建议边界声明扩一句：受污染面为 request_traces 表本身及其派生看板，而非 C 判据。
3. **F-7 保守路径**：**同意**。附注见裁决表 F-7 核查项（降权落地形态定义、与台账 1 达成度的表述对齐）。
4. **F-9 "无 domain 不过滤"兼容规则**：**同意规则本身**，但由此引出新发现 **F-18**（见下），验收口径须随之修订。
5. **F-11 措辞修正**：**同意**。"全部保持 fixed，下一发布周期后评估 closed"+"修复后（D1/D2 起）无复发"均准确。

## 3. 新增发现（由补充说明 4 引入）

### F-18（major，维度 1/2）："无 domain 不过滤"兼容规则使 F3 验收目标"跨域注入为零"不可达成，且 ETL EVIDENCE 无打标路径

- 问题陈述：答辩方定案"卡无 domain 不过滤（向后兼容存量 920 卡），有 domain 才参与过滤"。该规则下：a) 存量 920 卡在 F1 重蒸完成前全部无 domain，混合库中 ALFWorld 任务仍可被 office 卡注入——与 F3 验收"混合库（ALFWorld+办公卡同库）跨域注入为零"直接冲突；b) ETL 产出的 EVIDENCE 候选不经蒸馏管线（etlSessionFiles 直接插句），F3 的"蒸馏管线按轨迹来源自动打标"覆盖不到 EVIDENCE——该类卡**永久无 domain、永久不过滤**，跨域串扰对 EVIDENCE 类（注入量最大的类之一）不被消除。原方案 F3 改动点 2 仅覆盖蒸馏写入路径，未含 ETL 路径。
- 证据：
  - round-1-response.md 补充说明 4（答辩方定案原文）；
  - 方案 §3 验收："混合库（ALFWorld+办公卡同库）跨域注入为零"；
  - `packages/agent-server/src/offline/etl.ts:29-47` ETL 直插 EVIDENCE，无打标步骤；
  - `packages/agent-server/src/offline/verifier.ts:60` EVIDENCE 晋升仅过 quality 闸。
- 修改建议（修订稿二选一或组合）：a) 验收口径改为"**带 domain 标签卡的跨域注入为零**"+ 显式声明存量/无标签卡在回填完成前的跨域可见窗口期及其风险接受；b) 补 ETL 打标路径（复用 F0 的 task_id 透传 + 任务→域注册表，ETL 摄入时按 session 所属任务打域），把 EVIDENCE 纳入过滤范围。若选 b，工期需再上修。

## 4. 修订稿核查清单（关闭项的条件集合，round 3 复核时逐项对账）

1. F0 批次：randomUUID、注入集落库、task_id 透传、既有 trace 数据处置声明（F-1/F-2/F-3）
2. issue-013 登记文件 + index 更新 + TS 回归测试落点（F-1）
3. F1 三处模块落点修正 + SOP/SKILL/EVIDENCE 豁免声明（F-4/F-5）
4. F2 对照校准口径与功效预算（F-6）
5. F2 降权落地形态 + 与台账 1 达成度表述（F-7）
6. F2 confidence 迁移：user_version + 快照再生 + 兼容读取（F-8）
7. F3 验收口径对齐（F-18-a）或 ETL 打标路径（F-18-b）+ 工期再上修
8. §5-1 方案 A 口径修正（双臂 agent-auto + pilot + <5% 门控）（F-10）
9. §6 措辞（保持 fixed、修复后无复发）+ §7 已完成标注（F-11/F-16）
10. 重蒸语料量/耗时估算（F-13）
11. Python 侧测试落点声明（F-17）

## 5. 结论

**共识达成（附条件）**：round-1 的 17 项发现全部关闭，答辩方接受无对抗项；答辩方 5 点补充说明全部同意（其中 F-11 证据反驳经独立复核成立，我 round-1 的标签引用有误，已修正）。新增 F-18（major）源于答辩方补充说明 4 的定案规则，需并入修订稿一并处理。下一轮（round 3）只做修订稿核查：按第 4 节清单逐项对账 + F-18 落实确认，不再追溯已关闭项。
