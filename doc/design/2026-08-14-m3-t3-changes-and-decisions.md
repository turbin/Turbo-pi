# M3（T3）开发决策记录：F2 实战归因奖惩 + 置信度

日期：2026-08-14
状态：**已实施，测试全绿（TS 306 + Python 66 + eval 66）**
依据：`plans/2026-08-14-post-c-unified-fix-batch-plan.md` v5（§3 F2）；`plans/2026-08-14-fix-batch-dev-tasks.md`（T3 行、§2 TDD 协议）；`doc/design/reviews/2026-08-14-fix-batch-adversarial/m2-test-review.md`（§6-① PPT 混合组交互）；`doc/design/2026-08-14-m2-t2-changes-and-decisions.md`（T2 先例）

## 1. TDD 过程记录（先红后绿）

### Python 侧（`eval/tests/test_attribution.py`，12 例）

首跑收集期 ImportError 全红（`eval/attribution.py` 不存在）：

1. 合成序列「卡 A 注入后 ≥3 个任务日失败 → 降权」（confidence 0.5→0.25 + demote_candidate）
2. 「卡 B 连续成功 → 加分，封顶 1.0」
3. 「<3 失败样本不动」（阈值正交性）
4. 「同任务日多请求 = 1 个样本」（样本单位）
5. 「多卡共注入仅记数不动作」（credit assignment 首版不做）
6. 「先加分后降权」顺序语义（min(c*0.5, 0.3) 收敛）
7. --store 证据源（request_traces join run.jsonl，含跨日合并与多卡样本）
8. --sessions-dir 证据源（experience_injection 近似；control 臂 disabled 排除）
9. --injections 清单证据源（C 回放；缺 run.jsonl 行跳过计数）
10. --apply 写 confidence 列
11. --demote 人工确认通道（active→dormant + rescore_excluded_batches=N；未知 id 忽略）

实现后 11/12 绿；1 例测试侧日期映射错误（ts 与 campaign day 差一天）修正后全绿。

### TS 侧（`test/attribution-confidence.test.ts`，8 例）

先写断言后实现，首跑 8/8 红（迁移逻辑/新方法/加权不存在）：

1. 旧库迁移：PRAGMA+ALTER 补 confidence/rescore_excluded_batches 列 + user_version=1；旧行读回默认值
2. insert/getById 往返（含非默认 confidence）
3. 旧 schema 快照 readonly 打开不破（读路径默认值兜底）
4. demoteToDormant（人工降级通道 + 复升排除标记）
5. decrementRescoreExclusions（每批递减、钳 0）
6. 检索排序加权：同相关性高确信优先；降权卡沉底
7. runDailyEvolution 跳过带排除标记的 dormant 卡 + 计数递减

实现后 7/8 绿；1 例测试侧 TTL 误伤（fixture createdAt 早于测试 epoch 的 TTL cutoff）修正后全绿。

### M2 finding ① 的 TDD（PPT 混合组拖低）

先写判别性测试（`test_ppt_mixed_group_no_deliverable_does_not_drag_partner`）再实现：
- 构造：N（无交付、verifier 字母分 4/5 更强）与 D（有交付、3/5）同组；
- 实测旧行为（T2 时代混合锦标赛）：D 归一化 0.4455 → 被拖拒；
- 修复后：D 单独 vs_reference 0.6225 过闸、N 封顶 0.49——测试对"不排除的旧实现"红、对新实现绿。
- 连带更新 3 处既有断言（全组无交付零打分：resume_cap 两例的 `calls > 0` → `== 0`、M1 断点测试的变更轨迹补交付标记）——语义收紧（拦截前移），非放松。

## 2. 设计决策（每条附理由）

### T3-1 样本单位 = 任务日（(day, task_id)），非独立任务字面、非请求

run.jsonl 每行 = 一个任务日样本（独立 judge 评分、独立 workspace）；同任务日 15-20 条请求共享该分数 → 只算一个样本（"同任务多请求共享同一 judge 分数，非独立样本"的字面含义）。跨日同任务（重复集）是独立样本。

理由：a) 重复集 campaign 的结构就是"同任务多日重跑"——若按字面 distinct-task 计数，重复集单任务卡永远无法达到降权阈值（测量盲区，issue-010 靶例正是单任务三日失败）；b) 计划 §3-2 的括号注释只定义"同任务多请求"非独立，未定义跨日为同一样本；c) 报告同时输出 distinct_tasks 计数供审计（实测 issue-010 卡 distinct_tasks=1、injected_task_days=3——口径差异可见）。预注册：DEMOTION_MIN_FAILURES=3 按任务日样本计数。

### T3-2 预注册常量（唯一权威在 eval/attribution.py）

- SUCCESS_SCORE=0.5（任务日 score ≥0.5 = 成功样本，与晋升阈值对齐）；
- CONFIDENCE_DEFAULT=0.5（列 DEFAULT + COALESCE 读回）；
- CONFIDENCE_INC=0.1/成功样本，封顶 1.0；
- DEMOTION_MIN_FAILURES=3（任务日失败样本）；降权公式 `min(c*0.5, 0.3)`——0.3 为"实战降权标记"阈值（≤0.3 的卡在检索中沉底）；
- RESCORE_EXCLUDE_BATCHES=3（复升排除 N 批）；
- 顺序语义：先加分后降权（成功加分后触发降权事件 → 按公式收敛，实测 0.7→0.3）。
理由：全部可测试、可审计；历史分布依据（失败率基线）随 F2 实际数据积累后校准。

### T3-3 归因关联表 = 离线脚本内建（eval/attribution.py），不落库

「卡×结果」关联是纯离线计算产物：request_traces.injected_ids × task_id × ts → 任务日样本 → run.jsonl 分数 join。不建独立 SQLite 表（首版无需跨会话查询；报告 JSON 即产物；若后续需要关联表落库再演进）。三种证据源适配器：--store（post-F0 主口径）、--sessions-dir（experience_injection 近似）、--injections（显式清单，C 回放）。

### T3-4 降权落地：confidence → 检索排序加权（cosine × confidence）

`retrieve()` 最终排序分 = cosineScore × confidence；store.search 保持 bm25 纯候选（不掺权重——它只选候选池，权重在重排步生效）。quality 字段不动（verifier 分数语义独立）。首版不自动降级：--apply 按规则写 confidence（降权自动）；active→dormant 由 --demote 显式清单（人工确认后执行）。

### T3-5 复升排除 = rescore_excluded_batches 列（计数而非布尔）

被实战降级（--demote）的卡置 N=3 批排除标记；runDailyEvolution 的 rescore 阶段过滤 `rescore_excluded_batches > 0` 的 dormant 行；每批运行后全量递减（>0 者 -1，钳 0）——N 批后恢复自评复评资格。阻断"自评复升→再注入→再失败"循环（审查 F-14）。

理由：计数列比布尔标记多一层"何时恢复"的语义，且递减逻辑（每批一次 UPDATE）简单可测；恢复后若无实战证据仍会再次被降权（自愈回路）。

### T3-6 PPT 混合组处理（m2 finding ①）：修复，非记录为边界

无交付轨迹**不参与锦标赛**（组构造期过滤）：a) 它们在封顶后不可能产卡；b) 参与只会以 verifier 高分抢占归一化质量、拖低有交付伙伴（issue-010 教训：自评高分 ≠ 行为效用——verifier 看不见交付物，其"强"不可信）；c) 全组无交付 → 零打分全部封顶（拦截比打分后封顶更早，省 LLM 调用）。DELIVERY_CAP_VERSION v1→v2（锦标赛组成变化 = 质量语义变化，T2 时代 journal 全部失效重打——T2-6 机制的既定用途）。

代价与边界：有交付轨迹只与有交付伙伴竞争（纯有交付组行为不变）；混合组中无交付轨迹的 journal 值 = 0.49（非原始分，语义正确——它们从未被打分）。实测：restill 冒烟 83 卡结果与 T2 完全一致（41 restilled / 6 无交付淘汰）。

### T3-7 迁移 = M1 模式 + user_version 版本化；快照再生说明

- CREATE TABLE 新列（fresh 库）+ PRAGMA table_info 检查 + ALTER ADD COLUMN（旧库）+ `user_version` ≥ 1 戳记（SCHEMA_VERSION=1）；
- 读路径 COALESCE 兜底：rowToExperience `?? 0.5 / ?? 0`——旧 schema 快照（readonly，从不被 ALTER）打开不破（测试 3 实证）；
- 快照再生：snapshot_store.py 整库复制，新列随 live 库自动带入；docstring 注明"归因奖惩生效期跑批前必须重新生成快照"（旧快照读默认值，检索不含真实置信度）。

### T3-8 C 回放口径与误差声明（计划 §3-7）

C 期证据实态（T3 实施时重新核实）：request_traces 仅 4 行有 retrieved（F-1 定案不可用）；c-d2..7 六库无 task_id 列、无 injected_ids；C 期 session JSONL（含 experience_injection）未留存于仓库——全量归因不可重建。回放定案：**--injections 显式清单 + 逐行证据 provenance**（`eval/replay-manifests/issue-010-c-campaign.jsonl`）：
- D3 行 = issue-010 D3 注入内容审查实证（session 归档 custom_message）；
- D4/D5 行 = 显式标注"近似"：同任务同库（c-d3..c-d5 均含该卡）同失败形态（分析完整无交付），D3 注入卡仍为唯一主检索命中；
- 误差声明：requestId 跨日碰撞（F-1）、retrieved⊇injected 无截断信息、workspace 路径解析 n/a（task-day 键控）。
回放结论：机制**能**后验标出 issue-010 致降分卡（exp-94dd6dbd90f3fa62：3 失败任务日 → confidence 0.5→0.25、demote_candidate=True）；但该结论依赖 D4/D5 近似成立——真实全量归因需 post-F0 新 campaign 数据。

### T3-9 不自动降级、对照校准、明确不做

- active→dormant 人工确认（--demote 显式清单；报告输出 demote_candidates 供审阅）；
- 对照校准口径（计划 §3-6）：对照臂仅 D1/D7 运行，校准仅这两日可执行——T3 不新增校准逻辑（confidence 奖惩只吃 run.jsonl 分数，与校准无关），口径沿用，写入本记录；
- 明确不做：token 级 RL、单请求即时奖惩（按任务日批次离线结算）、SKILL/SOP 归因（独立通道）、多卡 credit assignment 加权（仅记数）。

## 3. 边界与遗留风险

1. **C 回放近似依赖**：issue-010 卡被标出依赖 D4/D5 的近似行成立（T3-8）；全量 C 归因不可重建（数据已失）。
2. **--store 模式的 day 映射**：ts 日历日 → campaign day 依赖 --campaign-start-date（默认 2026-08-09）；日期越界样本静默跳过（报告 manifest_skipped 可见）。post-F0 跑批应显式传参。
3. **EVIDENCE 卡同样参与奖惩**：injected_ids 含 evidence 池——EVIDENCE 卡也会被加分/降权（检索加权对全类型生效）。口径一致，无特殊处理。
4. **confidence 奖惩与质量阈值的交互**：降权卡仍可被检索命中（只是沉底）——"降权不降级"的保守语义；彻底排除需人工降级通道。
5. **ETL 路径晋升不受复升排除约束**：verifyAndCanonicalize 对匹配 contentHash 的 dormant 行仍可晋升（新证据通道）——复升排除只拦 runDormantRescore 自评通道（循环源头），新 ETL 证据属合法复升。
6. **全组无交付组零打分**：journal 存 0.49 占位——resume 语义与新鲜一致（幂等）；LLM 调用节省为附带收益。
7. **eval/results 工件使 check:pinned-deps 持续失败**：pre-existing（M1/M2 同口径），本次不修；`npm run check` 其余阶段全过。
8. **restill 与 T3 无交互**：重蒸用 score_trajectories_with_checkpoint，混合组分区后冒烟结果与 T2 逐项一致（41/6/36/0）。

## 4. 测试与检查结果

- TS：`packages/agent-server` 全包 **306 通过**（32 文件；含新增 attribution-confidence 8 例；既有 fixture 35 处补 confidence/rescoreExcludedBatches 字段）；Node 25 经 `scripts/with-node25.sh`。
- Python：`python/tests/` **66 通过**（含新增 PPT 混合组拖低回归 1 例；resume_cap/断点测试 3 处断言随拦截前移更新）；eval `tests/` **66 通过**（含新增 test_attribution 12 例）。
- 冒烟：restill 真实 C 库导出（83 ABILITY 卡）结果与 T2 逐项一致；C 回放（--injections 清单）输出 issue-010 卡 demote_candidate=True（confidence 0.5→0.25）。
- `npx tsgo --noEmit` 0 错误；biome 0 问题（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/browser-smoke 全过。
- 唯一 check 失败项：`check:pinned-deps`（pre-existing，eval/results 工件，M1/M2 同口径）。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§3 F2）；plans/2026-08-14-fix-batch-dev-tasks.md（T3）；doc/design/reviews/2026-08-14-fix-batch-adversarial/m2-test-review.md（§6-①）；doc/design/2026-08-14-m2-t2-changes-and-decisions.md（T2-6 指纹机制先例）
