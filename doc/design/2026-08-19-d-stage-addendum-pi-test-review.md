# D 阶段增强（preview.html）T1-T4 独立复核报告（pi-test）

日期：2026-08-19
复核人：pi-test（独立测试复核）
范围：pi-dev-1（T1+T2）与 pi-dev-2（T3+T4）未提交改动，全量独立复跑 + 假绿审计 + 补缺失用例。
依据：doc/design/preview.html（主稿）、doc/design/plans/2026-08-19-d-stage-addendum-dev-tasks.md（任务书）。
状态：**两路改动复核通过（测试全绿）；遗留问题 1 项验证成立（held-out×cross 差分污染，主会话已裁决排除，未修）；观察项 4 条待主会话确认。无打回级实现缺陷。**

## 1. 全量独立复跑证据

| 套件 | 命令 | 结果 | 与基线比 |
|---|---|---|---|
| eval pytest | `cd packages/agent-server/eval && ./.venv/bin/python -m pytest tests/ -q` | **145 passed, 1 xfailed**（146 collected） | 基线 141 → 净 +4（补 6 用例 + 1 xfail 文档用例，1 用例强化） |
| agent-server vitest | `cd packages/agent-server && ../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run` | **346 passed**（42 files） | 基线 344 → +2（/api/stream 双路径 2 用例；迁移用例扩展 1 处） |
| gateway pytest（验收口径② 附带） | `cd packages/agent-gateway && uv run pytest -q` | **195 passed** | 无回归 |

CLI 干跑核验（验收口径③）：
- `campaign.py --dry-run --day 2 --arms x1,x2,x3,x4 --run-id camp-verify`：输出 `held-out 8 on x2,x3`；28 任务行（20 重复 + 8 held-out）；每任务臂序为排列（如 `task_00002: x3 → x1 → x2 → x4`、`task_00023: x4 → x1 → x3 → x2`），非臂块顺序；held-out 行只含两臂（`task_00064: x3 → x2`）。
- 同 run-id 二次运行顺序一致（确定性）；`--run-id camp-verify7` 顺序整体不同（seed 敏感性）。
- 真实 corpus 核验：96 执行单元（4×20 + 2×8）两两唯一；28 任务臂序共 14 种不同序；held-out 臂序集合 = {x2→x3, x3→x2}；7 天 daily_batch 切片与 held-out 零交集、与 D1 切片零交集。

## 2. 假绿审计结论（逐文件）

**test_campaign_task_block.py（pi-dev-1）— 无假绿。**
- 臂序：`test_task_block_plan_full_coverage_80_and_permutation` 断言 80 执行单元、`len(set(pairs))==80`（每 (task,arm) 恰一次）、每任务臂序为四臂排列、不同任务 ≥2 种不同序——臂块顺序实现只会产生 1 种序，会被捕获；`order_differs_across_run_ids` 验证 seed 敏感性。测的是机制（sha256 digest 排序的产物），非 mock 透传。
- 三态：completed（无 tool_calls break）、max_turns（monkeypatch MAX_TURNS=3 循环耗尽）、timeout（真实 `elapsed > timeout_s` 检查）——**三态均由真实退出路径触发**，mock 只供消息、不由 mock 决定终止原因。
- held-out 接线：`test_arms_day_held_out_only_on_x2_x3` 驱动 campaign.main() 真实回路（task_block_plan / kind 判定 / 落库），断言 x1/x4 不含 held-out、行 kind=held_out、行带 termination_reason。
- D1 resume 兼容：`test_completed_keys_tolerates_old_rows_without_termination_reason` + `test_resume_skips_done_pairs_and_writes_termination_reason`（旧行无字段读取不炸、新行带字段）。

**test_campaign.py / test_campaign_cross_wiring.py（pi-dev-1）— 无假绿。**
- held-out 选取确定性/恰 8 个/D1 切片排除/7 天轮转摘除均以真实 corpus 断言；`test_daily_batches_cover_new_tasks_exactly_once` 已改为 `union == new − held` 且与 held 无交。

**test_synthesize_campaign.py（pi-dev-1）— 无假绿。**
- 写入隔离：`filter_inputs` 纯函数（臂白名单 + held-out 排除 + 计数）+ CLI 默认/覆盖参数，held-out 用例用真实 corpus 的 held-out 任务 id 构造 fixture。

**test_campaign_metrics_addendum.py（pi-dev-2）— 无假绿。**
- 边界全覆盖：score 0.29/0.30 阈值、grading_error 双形态（嵌套/顶层）、max_turns∧<0.5 子句、旧行 .get 容错；分母计数与零分母；--metrics 接线（addendum 节存在且判据节不受影响）。

**test_trajectory_metrics.py（pi-dev-2）— 无假绿。**
- 六指标均以手构 transcript 验证机制：RepeatToolRate 只算相邻（非相邻归 StateRevisit）、canonical args key 序、多 call 按位对齐；RetryRate 的错误标记归因（含纯文本隔层）；StateRevisit 相邻/非相邻区分；ProductiveRound 全新型文本；RoundCount 分位线性插值（numpy 口径）；**CapRate 双口径**——显式 max_turns→capped、显式 completed+requests=30→**不误判**（§8.1 核心）、旧行 fallback requests>=30 且 fallback_n 标注。

**test/retrieval-observability.test.ts（pi-dev-2）— 无假绿。**
- 迁移：真实旧 schema 库文件（含旧行）→ initSchema → 列存在、user_version=2、**旧行数据保留**（retrieved_scores 回填 '[]'、injected_tokens NULL）、幂等不重复 ALTER、**getHitRateStats 读旧行不炸**（本次补）。
- e2e：/v1 与 /api/stream 双路径（本次补后者）断言 `ids == retrieve() 重跑结果`、`scores == expected`、等长、单调递减——真实检索管线产物，非 mock 字段。
- COALESCE 三阶段合并：phase-2 完成调用不覆盖 phase-1/1.5 的观测字段。
- injection 关闭：scores=[]、injectedTokens=0（显式 0 与省略的 NULL 区分）。

**结论：未发现假绿。** 全部新测试断言的是机制行为而非实现细节；三态终止由真实退出路径触发；held-out 的"不出现在 daily_batch / 只挂 x2/x3"均有真实 corpus 或 main() 回路的直接断言；T4 迁移覆盖"含旧数据的库升级后数据保留 + 读回"。

## 3. 补充用例清单（本次补写，红绿如下）

| 用例 | 位置 | 结果 | 说明 |
|---|---|---|---|
| `test_resume_mid_task_block_no_dup_no_loss` | eval/tests/test_campaign_task_block.py | 绿 | 断点续跑在 task-block 中段：同任务 4 臂完成 3 臂（x1/x2/x3），恢复只补 x4 一次；其余任务全量；Counter 校验全文件无重复 (arm,task) 对 |
| `test_termination_reason_timeout_via_main` | 同上 | 绿 | timeout 路径端到端：campaign.main() + **真实 run_agent** + 确定性时钟（timeout_s=0）→ run.jsonl 行 termination_reason="timeout"、requests=0、transcripts 落盘物含 [timeout] 追加 |
| `test_termination_reason_timeout`（强化） | 同上 | 绿 | 原墙钟依赖改为确定性时钟（消除理论 flake） |
| `test_held_out_rows_do_not_contaminate_cross_diffs` | eval/tests/test_campaign_cross.py | **xfail（红，文档化遗留）** | 见 §4 问题 1；修复后转绿并移除 xfail 标记 |
| `test_cli_eligible_arms_empty_string_fails_loud` | eval/tests/test_synthesize_campaign.py | 绿 | `--eligible-arms ""` → 全部排除 → fail loud（SystemExit），不静默合成 |
| `test_cli_eligible_arms_unknown_arm_fails_loud` | 同上 | 绿 | `--eligible-arms bogus-arm` → fail loud |
| `/api/stream` 双路径 2 用例 | agent-server/test/retrieval-observability.test.ts | 绿 | retrieved_scores 与 retrieved_ids 按位对齐 + injectedTokens>0；injection off → [] 与 0 |
| 迁移用例扩展（读回断言） | 同上 | 绿 | 迁移后经 getHitRateStats 读旧行不炸：retrieved_scores='[]'、injected_tokens=NULL |

红绿说明：除 xfail 一项（即 §4 问题 1，验证真实缺陷存在，按要求不修）外全部为绿。补写的用例覆盖了任务书点名的全部"重点怀疑对象"。

## 4. 遗留问题清单

### 4.1 【已裁决遗留，验证成立，未修】held-out 行污染 campaign_cross 差分核算

- 现象（实测复现）：D7 四臂日 x2/x3 各含 20 重复 + 8 held-out 行（kind=held_out，campaign.py 落库形态）。`campaign_cross.cross_arm_diffs`（eval/campaign_cross.py，`_mean` 处）**不按 kind 过滤**，x2/x3 均值按 28 行计算、x1/x4 按 20 行。
- 合成验证（重复集 score=0.8、held-out score=0.2）：`library_evolution (x2−x1) = −0.171`（期望 0）、`sanity_diff (x3−x4) = −0.171`（期望 0）——**已超预注册 SANITY_TOLERANCE=0.05，check_sanity 会误报"未建模混淆"**；`injection_effect (x1−x4)` 不受影响（x1/x4 无 held-out）。另返回字典中 `n_per_arm_per_day: 20` 为硬编码，与实际 28 不符。
- 修复建议（主会话裁决排除，本复核未动代码）：`cross_arm_diffs` 内均值计算按 `kind == "repeat"` 过滤（per_day 与 overall 同处过滤），`n_per_arm_per_day` 改为实际计数；或 campaign.py 落库时对 x2/x3 的 held-out 行单独标记后由差分侧排除。已加 xfail 用例 `test_held_out_rows_do_not_contaminate_cross_diffs` 登记，修复后转绿。

### 4.2 【观察项，待主会话确认】addendum_metrics 作用域为全量行（臂混合）

- `campaign.py --metrics` 路径 `addendum_metrics(rows)` 不过滤臂（campaign_metrics.py 的 daily_summary/check_criteria 均限定 experiment 臂）。四臂日 run.jsonl 含 x1-x4 行（D1/D7 还含 control 行），三指标（尤其 autonomous_success_rate）将混入非生产臂行，稀释"学生独立性"解释。docstring 声明"调用方决定作用域"但调用方未过滤。
- 建议：主会话裁决 addendum 是否限定 experiment 臂（及四臂日无 experiment 臂时的报告口径）。不阻塞，报告指标随行带 n 字段可对账。

### 4.3 【观察项】未标注 escalated 的旧行在 addendum 中视为未升级

- `addendum_metrics` 用 `r.get("escalated")`，缺失视为未升级（C2 fail-loud 只作用于判据函数 escalation_rate）。旧行可能虚高 autonomous_success_rate。低风险：D1 起跑行均带 escalated（C2 已生效）。

### 4.4 【观察项】`--eligible-arms` 含空格时静默排除

- `set(args.eligible_arms.split(","))` 不去空格：`--eligible-arms "experiment, x2"` 的 `" x2"` 不匹配任何文件 → x2 被静默排除（非 fail loud）。建议 strip 或文档注明。低风险。

### 4.5 【观察项】timeout 终止的 requests=0

- run_agent 的 timeout 检查在 `requests += 1` 之前，超时任务 requests=0（已在补写用例中断言）。与 CapRate fallback（requests>=30）无冲突：timeout 行带 termination_reason 键，不走 fallback。口径合理，仅记录。

## 5. 对账结论（任务书验收口径）

| 验收项 | 结论 |
|---|---|
| 1. preview §7.2/§8.1/§9/§10/§12.2/§3/§17.3 逐节有落地证据（代码+测试） | 通过。§12.2（task_block_plan + dry-run 证据）、§8.1（三态 + CapRate 双口径）、§7.2/Q8（held-out 8 个、轮转摘除、挂 x2/x3）、§10（eligible-arms 默认 experiment,x2）、§3（三指标预注册）、§17.3（trajectory 六指标 + 分位）、§9（retrieved_scores/injected_tokens 双路径） |
| 2. eval pytest 全绿 + agent-server vitest 全绿 + gateway pytest 不回归 | 通过（145+1xfail / 346 / 195） |
| 3. dry-run 臂序 task-block 随机且确定性；day 7 含 held_out 挂 x2/x3 | 通过（实测证据见 §1） |
| 4. D1 resume 兼容（旧行无 termination_reason 不炸） | 通过（completed_keys / is_obvious_failure / trajectory fallback 三处 .get/键检查容错 + 测试） |
| 5. 决策记录随 commit | 由主会话执行（本复核不 commit） |

## 6. 复核改动文件清单

仅测试文件（未动任何实现文件）：
- `packages/agent-server/eval/tests/test_campaign_task_block.py`（+3 用例，1 用例强化）
- `packages/agent-server/eval/tests/test_campaign_cross.py`（+1 xfail 文档用例）
- `packages/agent-server/eval/tests/test_synthesize_campaign.py`（+2 用例）
- `packages/agent-server/test/retrieval-observability.test.ts`（+2 用例，1 用例扩展）

注：本报告未登记 INDEX.md（登记随主会话 commit 一并处理）。
