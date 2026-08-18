# M3（T3）测试 agent 独立复核报告：实战归因奖惩 + 置信度

日期：2026-08-14
复核人：pi-test（测试/质量 agent，独立于 pi-dev 复核）
对象：M3 里程碑（T3，F2 归因奖惩 + confidence 迁移 + PPT 混合组修复），工作区未提交变更（HEAD=08a267a3 M2）
结论：**门禁通过（附 1 项待用户确认口径项，§2a）**——无代码缺陷；复升排除、迁移、回放、PPT 修复全部实证通过

---

## 1. 全量测试独立复跑（不信开发方数字）

| 套件 | 开发方声明 | 独立复跑 | 判定 |
|---|---|---|---|
| TS `packages/agent-server`（Node 25 包装） | 306 通过 / 32 文件 | **306 通过 / 32 文件** | 一致 |
| Python `python/tests/` | 66 通过 | **66 通过** | 一致 |
| eval `tests/`（含 test_attribution.py 12 例） | 66 通过 | **66 通过** | 一致 |

补测后终态（§5）：TS **309**、Python **69**、eval **71**，全绿（补测 11 例均为判别性用例）。

## 2. 重点审计逐项结论

### 2a. 样本单位 = 任务日 —— **口径偏离方案字面，需主会话/用户确认**（本里程碑最重要 finding）

- 方案 §3-2 字面："阈值 **≥3 个不同任务**"；实现（T3-1）：`DEMOTION_MIN_FAILURES=3` 按**任务日**样本（`(day, task_id)`）计数，`distinct_tasks` 仅审计输出不参与规则。
- **方案内部自相矛盾**：§3 验收判据"回放能后验标出 issue-010 中致降分的卡"——该卡 `distinct_tasks=1`（仅 task_00091 三日失败，本次回放实测确认），按字面 distinct-task 口径**不可能**满足验收判据。开发方选择满足验收判据的解释，且 T3-1 完整记录理由、报告输出 `distinct_tasks` 供审计。
- **统计风险（同任务跨日相关性）**：跨日同任务样本共享任务级随机效应（任务难度、judge 对同任务的系统性偏差）——单任务困难即可触发降权（task-level confound），不满足字面"不同任务"的独立性意图。实例：issue-010 卡因 task_00091 单任务三日失败被降权（0.5→0.25），而 D6/D7 该任务回升 0.79/0.78——若降权发生在回升前，单任务 confound 会把"其实有效的卡"按沉。
- **结论**：机制实现自洽、预注册与审计可见性合格，但样本单位是预注册口径的实质变更，**必须经主会话（用户）确认后生效**；建议主会话裁决时考虑补 `distinct_tasks >= 2` 为 demote_candidate 的必要条件（或保持现状并在降权报告中显著展示 distinct_tasks）。本项不构成本复核的打回（决策记录已完整披露），但列为门禁确认项。

### 2b. 降权/加分常量误伤边界 —— 通过（含两处边界实证）

- 新卡与存量卡 confidence 初始值**均为 0.5**（列 DEFAULT + COALESCE，实测旧库读回 0.5）——无迁移期系统性落差。
- 一次降权事件（3 个失败任务日，且**仅单卡注入样本计数**，多卡样本不驱动奖惩）→ `min(c*0.5, 0.3)`：默认卡 0.5→0.25；高置信度卡（0.9，2 成功 + 3 失败后 0.8+0.2=1.0→0.5→0.3 封顶）恒收敛 ≤0.3（补测锁定）。**"过激"评估**：0.3 是"实战降权标记带"的二元语义（决策 T3-2），一旦触发无论历史如何都沉底——但落地形态受限（仅检索排序加权，卡仍可命中；active→dormant 需人工 --demote），误伤代价有界。3 次单卡注入失败是强信号（多卡样本被排除），阈值本身合理。
- 与 2a 的交互：任务级 confound 是误伤的主要来源（单任务三日失败即降权），见 2a 建议。

### 2c. 检索加权 cold start —— 通过

- 迁移时全部卡 0.5 → 无系统性新卡压制（与旧卡平权）；奖惩只在证据积累后分化（设计语义）。
- 等相关性下满额奖励卡（1.0）优先于新卡（0.5）——加权语义锁定（补测）；**相关性优势可补偿**（cosine 优势超过置信度差距时新卡仍居首，补测实证）——不存在"新卡永远起不来"的冷启动死锁。
- 注意：EVIDENCE 卡同样参与加权（决策 §3-3 声明），检索池主体是 EVIDENCE（C 库 5 万+ 行）——降权影响面按类型无差别，与声明一致。

### 2d. 复升排除 N=3 递减正确性 —— 通过（全生命周期补测实证）

- 实现：`decrementRescoreExclusions` 对全部 >0 行每批 -1（钳 0），scheduler 过滤 `<= 0` 才可复评，`verifyAndCanonicalize` ETL 晋升不受限（§3-5 声明一致）。
- 补测锁定全生命周期：3→2→1→0（前 3 批零复评调用）→ 第 4 批恢复复评并晋升。主测试只覆盖 3→2 单步。
- 边界核查：active 行（ETL 复升后）残留标记无害（继续递减到 0）；无死循环（钳 0）。

### 2e. demote 人工通道不自动执行 —— 通过

- grep 全仓：`demoteToDormant` 仅定义于 experience-store、`demote_cards` 仅由 attribution CLI `--demote` 分支调用；`run_attribution_cli`/scheduler 无任何自动降级路径。`--apply` 只写 confidence。测试 11/12 覆盖。

### 2f. PPT 混合组修复副作用 —— 通过（实证无崩溃、幂等、restill 结果不变）

- 全组无交付：**零 LLM 调用**、无崩溃、全部封顶 0.49、journal `method="capped"`、resume 零调用且逐位一致（补测锁定多轨迹形态）。
- 混合组（2 有交付 + 1 无交付）：锦标赛只含有交付轨迹（`tournaments` 键仅 task 组），journal 按原组序回填（无交付占位 0.49 + 有交付真实分），resume 一致（补测实证）。
- 输入哈希含全部轨迹文本：增删无交付轨迹会强制重打（过度失效，安全方向，效率代价小）。
- **restill 冒烟复现**：v2 语义下真实 C 库导出结果与 T2 逐项一致（41 restilled / 6 无交付 / 36 低分 / 0 缺源 / 837 跳过）——T3-6 声称验证通过。

### 2g. C 回放结论证据强度 —— 通过（近似依赖如实声明，前提逐项实证）

- 独立复跑：`--injections` 清单回放 → 3 任务日样本、`distinct_tasks=1`、0.5→0.25、`demote_candidate=True`（与声称一致）。
- **D3 实证**：run.jsonl 实测 score=0.0、`output_file_exists: 0.0`、judge notes 与 issue-010 分析吻合（分析完整、未写交付文件）。
- **D4/D5 近似前提逐项核验**：① 卡 `exp-94dd6dbd90f3fa62` 在 c-d3/c-d4/c-d5 三库中均 active（实测）；② run.jsonl D4/D5 同为 0.0 且 notes 记录同失败形态（D4："只读文件未产出 md"；D5："cross-file evidence gathering... 未完全展示交付"）✓；③ 误差声明齐备（requestId 碰撞、retrieved⊇injected、task-day 键控）。
- **保留意见**：D4/D5"该卡仍为唯一主检索命中"不可直接验证（无当日 session 注入证据；且 c-d4/c-d5 库中 ABILITY 卡增至 45/59，竞争者多于 c-d3 的 33）——近似成立度随库增长递减。结论"机制能标出"在近似成立的前提下成立，与决策记录表述一致（诚实边界合格）。

## 3. 迁移兼容实测（真实 C 库副本）

- **旧库迁移**：`experience-c-final.db` 副本（无 confidence 列）initSchema 后：experiences 补 `confidence`/`rescore_excluded_batches` 列、`user_version=1`、旧行读回 0.5/0、写 confidence 可用——全部实测通过。
- **快照 readonly 不破**：以原库为 snapshotPath 只读打开 + initSchema 后原文件 mtime 不变、PRAGMA 无新列；readDb 读路径（search/listActive）COALESCE 读回 0.5/0（实测）。注意 `getById` 读 live 库（issue-006 设计），快照验证须走 search/listActive——测试 3 路径正确。

## 4. 测试计数与 npm run check

- 复跑基线：TS 306 / Python 66 / eval 66（与开发方一致）；补测后 TS 309 / Python 69 / eval 71。
- `npm run check`：biome 干净（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/tsgo（0 错误）/browser-smoke 全过；**check:pinned-deps 138 条失败全部位于 eval/results/**（13 个唯一文件，与本变更无关）——pre-existing 不修，与 M1/M2 同口径。

## 5. 补测试清单（本复核新增 11 例，全绿）

| 文件 | 用例 | 判别性（对错实现会红） |
|---|---|---|
| `test/attribution-confidence-extra.test.ts`（新，TS 3 例） | 复升排除全生命周期（3 批跳过 → 第 4 批复评晋升）；等相关性奖励卡优先；相关性优势补偿冷启动 | 递减逻辑错误 / 恢复资格时机错误 / 加权缺失的实现会红 |
| `eval/tests/test_attribution_extra.py`（新，5 例） | 同任务三日失败降权且 distinct_tasks=1（口径锁）；高置信度 0.9→0.3 封顶；成功后再降权恒 ≤0.3；--store 跳过 control 臂与无 run.jsonl 行；--sessions-dir 无 day 元数据时按 ts 映射日 | 按 distinct-task 计数 / 公式不含 cap / 样本合并错误的实现会红 |
| `python/tests/test_issue010_allcapped_group.py`（新，3 例） | 全组无交付零调用无崩溃全封顶 + journal method="capped"；resume 幂等不翻倍；混合组（2+1）锦标赛范围 + journal 原组序回填 + resume 一致 | 无交付轨迹仍参与锦标赛 / 全组无交付崩溃 / resume 不一致的实现会红 |

## 6. 门禁结论

**通过（附 1 项确认项）**。判据：① 全量测试绿（补测后 309/69/71）；② `npm run check` 干净（仅 pre-existing pinned-deps）；③ diff 规模合规（agent-server + eval + 文档，无越权）；④ 方案 §3 逐项对账——除 2a 口径外全部一致；⑤ 决策记录完整。

**门禁确认项（非代码缺陷，需主会话/用户裁决）**：样本单位"任务日"vs 方案字面"≥3 个不同任务"（§2a）——建议裁决时考虑补 `distinct_tasks>=2` 必要条件以降低单任务 confound 误伤，或保持现状（决策记录已预注册披露）。若裁决维持字面 distinct-task 口径，则需修改 `compute_attribution` 并同步验收判据（回放结论随之改变），本复核将按裁决重跑。

**通过项（无需返工）**：迁移/快照/复升排除/人工通道/冷启动/PPT 修复/回放实证——全部独立复现通过。

Refer Spec：plans/2026-08-14-fix-batch-dev-tasks.md（T3）；plans/2026-08-14-post-c-unified-fix-batch-plan.md v5 §3；doc/design/2026-08-14-m3-t3-changes-and-decisions.md；doc/design/reviews/2026-08-14-fix-batch-adversarial/m2-test-review.md（§6-①）
