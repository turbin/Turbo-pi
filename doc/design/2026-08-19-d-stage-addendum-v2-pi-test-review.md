# D 阶段 Addendum v2（T6/T7/T8/T9/T10）独立复核报告（pi-test）

日期：2026-08-19
复核人：pi-test（独立测试复核）
范围：pi-dev-2（T6 metrics_v2 + T10 usage 台账）与 pi-dev-1（T7 plan_adherence/leakage_check/memory_lifecycle、T8 oracle_diagnostic、T9 rerun_audit）未提交改动；决策记录 `doc/design/2026-08-19-d-stage-addendum-v2-t7-t8-t9-changes-and-decisions.md`。
依据：`doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md`（§1.1-1.5 预注册口径）；`doc/design/D阶段实验设计补充评审_指标与条件检查.md`（GPT 评审）。
纪律：仅补/改测试，未动任何实现代码；不 commit；未读 .env；未改 omlx。
状态：**三套件全绿（242→251+1xfail / 89 / 346）；无测试假绿；发现 4 项实现缺陷（打回级，其中 1 项理论触发、3 项真实路径触发）+ 9 项观察项。决策记录冒烟数字全部独立复现，真实数据冒烟确认备份库存在 exact 泄漏（12 对 / 7 个 held-out 任务）。**

## 1. 全量独立复跑证据

| 套件 | 命令 | 结果 | 与基线比 |
|---|---|---|---|
| eval pytest | `cd packages/agent-server/eval && ./.venv/bin/python -m pytest tests/ -q` | **251 passed, 1 xfailed**（252 collected） | 基线 242 → 净 +9 用例（+1 xfail 登记缺陷，本复核补） |
| python 管线 | `cd packages/agent-server && uv run pytest python/tests/ -q` | **89 passed** | 与基线一致（无回归） |
| agent-server vitest | `../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run` | **346 passed**（42 files） | 与基线一致（无回归） |

T10 台账写入侧（test_usage_ledger.py，6 用例）在 eval 套件内已覆盖。

## 2. 假绿审计结论（逐文件，重点怀疑对象逐项）

**test_metrics_v2.py / metrics_v2.py（T6+T10）— 无假绿，3 项缺陷登记（见 §5）。**
- Success@K 的 rounds 来源：`_success_group` 用 `parse_rounds(doc.get("transcript"))`（assistant 回合数），**非 requests 列**。测试行 requests=10 而 transcript 4/12/20 回合，断言 k5/k10/k15 按 transcript 轮数落点——若实现改用 requests 必红。真实数据复核：task_00019 transcript 28 回合（requests=28 巧合相等），k5-k20=0、k30=2/3 与 transcript 轮数一致。
- 四象限触顶：`_is_capped` 有 termination_reason 键时严格 `== "max_turns"`，旧行 fallback requests>=30（trajectory_metrics 同款复用）；测试覆盖 max_turns 显式、旧行 fallback、requests=30+completed 不误判（v1 既有用例）。
- δ=0.1 严格小于：`round(diff,9) < -DELTA`；边界用例 0.8→0.70 恰差 0.1 判 unchanged，0.69 判 regressed。负迁移同日配对（experiment vs control / x2 vs x3），x1/x4 不参与（预注册）。
- Functional automated 前缀：`automated.*` 现存键均值 + 全部==1.0 判 HardPass；**缺 key 行仍参与且会带偏（只余 1.0 键的行判 HardPass，高估方向）**——预注册口径未排除缺键行，行为与 docstring 一致，已补用例钉住并登记观察项（§5.9）。
- 难度分层只用 D1 实验臂行（`d1_rows` 来自 days[0] + experiment 优先）分档，D7 只用于增益——实验前信息隔离成立。
- compliance task_id 粗 join 误报面：ok/违规/unverifiable 三态与 docstring notes 声明逐字一致（"存在≥1 零注入痕迹→ok；全部非零→违规；无痕迹→unverifiable"）；`scope` 冗余的 `in FOUR_ARMS` 条件无害。无四臂数据 n=0 不 fail（实测 campaign-20260819 返回 n=0）。
- economics：teacher 单价常量、摊销公式、TotalSystemCost 四项均按 docstring；esc_micro/1e6 单位换算正确（100000+50000 micro → 0.15 USD 用例）。真实网关 23151 行 escalation 全 NULL cost → 0 计 + note（实测输出含"23151 行…按 0 计"）。

**test_leakage_check.py / leakage_check.py（T7）— 无假绿，fallback 方向定性见 §4。**
- 3-gram Jaccard：`char_trigrams` 字符三元组集合、`len(∩)/len(∪)` 集合语义正确；短文本（<3 字符）整体作一个 gram 防除零；双空集记 1.0（report() 路径下不可达，held_prompts 已过滤空串）。
- source_task 三阶解析（taskId → sourceSession → content fallback）：各阶测试齐全；normalize_task_id 以 `task_` 锚剥离臂前缀（真实库实测 920 active 全解析、leak 对全 fallback=False）。
- future-task 检查：created_at 日期部分 ISO 串比较，`<` 严格；空 created_at 不误报（`""` falsy 跳过）。
- 真实备份库冒烟：**12 对 exact 泄漏（sim=1.0，7/8 held-out 任务）**，12 条 future-task 违规（created 2026-08-11/12 < D7 首跑 2026-08-25）——与决策记录 c-d4 发现同构且面更大，坐实"冻结库选库"裁决紧迫性。

**test_plan_adherence.py / plan_adherence.py（T7）— 无假绿，2 项观察项（§5.6/§5.7）。**
- 注入卡 join 用 request_traces.injected_ids（F0 issue-013 语义）限 ABILITY∧role∈{Method,Guard}；control/x3/x4 行不计分母（有专门用例）。
- 动作 token：动词词边界（"cat"≠"concatenate"用例）、路径子串（`.bak` 改写用例）、停用词过滤；误报面 docstring 注明（文本共现≠语义等价）。
- Deviation 只算触顶∧失败任务（completed 失败不计，有用例）。

**test_memory_lifecycle.py / memory_lifecycle.py（T7）— 无假绿，1 项缺陷登记（§5.2）。**
- ReuseCount=retrieved_ids 展开计数（JSON 解析容错）；SuccessAfterReuse 用 run.jsonl 行最大值；DuplicateRate active 口径 + n_unresolved 计数；Age 三种时间格式容错。
- Utility 配对按 docstring"每臂首行（文件序）"实现——**四臂日会取 x1（冻结+ON）−x3（当日+OFF）混库配对，且取哪两臂由 task-block 随机执行序决定**（缺陷登记，见 §5.2）。

**test_oracle_diagnostic.py / oracle_diagnostic.py（T8）— 无假绿，2 项缺陷登记（§5.3/§5.4）。**
- A/B 复用：每臂文件序首行（不按日过滤）——真实主批重复集 D1 必含两臂故为同日行，跨日形态仅理论（已补用例钉住）。**四臂主批行（x1-x4）不认作 A/B**（与 D-9 登记一致，观察项 §5.5）。
- 子集选取：ExhaustedFailure→hard 档→sha256 序，纯函数确定性（重复调用一致用例）。
- 蒸馏解析：STEP_RE 编号从 1 连续、每步≥4 字符；无编号/不从 1 起/过短均拒（各有用例）；D 失败不蒸馏不跑 C（有用例）；蒸馏失败计 failures_n 且 C 跳过（有用例）。
- C 条件包装：测试断言 prompt 以预注册模板开头、plan 重编号行内嵌、`injection=False`、走 STUDENT client——**绕开检索成立**（注入关 + plan 在 prompt 内）。
- 写入隔离：oracle-D-/oracle-C- 前缀 + 独立 out_dir，断言不写 run.jsonl/transcripts。
- `_probe_teacher` 探针 URL 双 /v1 缺陷（§5.4）。

**test_rerun_audit.py / rerun_audit.py（T9）— 无假绿，1 项观察项（§5.5）。**
- 五类选取确定性（重复调用一致）、去重补足、键预注册 sha256("rerun-audit")；RunToRunVariance=极差+样本 stdev（n<2→0.0，用例齐全）；injection=True 断言；无 transcripts 落盘断言。
- **主批形态（D1 双臂 + D7 四臂）下 delta 恒空**（D7 无 experiment 行）→ 改善/退化两类典型不可选（用例钉住，观察项 §5.5）。

**test_usage_ledger.py（T10）— 无假绿。**
- 两个 llm_client.py 的 OpenAICompatClient 成功响应（含 choices）追写台账；**MockLLM 纯规则类不经过 _post/_record_usage，测试断言台账文件不创建**；写失败（父级为文件 → makedirs OSError）仅告警不抛（capsys 断言）；usage 缺失记 0；每调用追一行（2 调用 → 2 行）；caller 默认取包名、sop_lifecycle 显式覆盖。

**结论：未发现测试假绿。** 全部新测试断言机制行为而非 mock 透传；真实数据冒烟验证决策记录数字可复现。

## 3. 补充用例清单（本次补写，红绿如下）

| 用例 | 位置 | 结果 | 说明 |
|---|---|---|---|
| `test_migration_d7_both_arms_should_prefer_x2` | eval/tests/test_metrics_v2.py | **xfail（红，缺陷登记）** | D7 同时含 experiment 与 x2 行时实现取 experiment，与 docstring/任务书（D7 等效臂=x2）不符；修复后转绿 |
| `test_functional_partial_automated_breakdown_participates` | 同上 | 绿 | breakdown 缺 automated 键的行仍参与均值+HardPass（只余 1.0 键 → HardPass，钉住带偏方向） |
| `test_success_at_k_empty_transcript_counts_zero_rounds` | 同上 | 绿 | 空 transcript → 0 轮 → 全部 K 命中（高估方向观察项） |
| `test_economics_escalation_null_cost_rows_noted` | 同上 | 绿 | cost_micro_usd 全 NULL → 0 计 + note（真实网关形态） |
| `test_leakage_fallback_paraphrased_content_misses` | eval/tests/test_leakage_check.py | 绿 | source 解析失败 + 改写 content → 漏检（假阴性方向钉住，§4） |
| `test_ab_reuse_first_row_per_arm_in_file_order` | eval/tests/test_oracle_diagnostic.py | 绿 | 每臂文件序首行（不做日过滤）跨日混配形态钉住 |
| `test_ab_reuse_four_arm_rows_not_reusable` | 同上 | 绿 | 四臂行（x1-x4）不可复用为 A/B → 恒需 --run-ab（观察项） |
| `test_utility_four_arm_day_pairs_first_on_off_in_file_order` | eval/tests/test_memory_lifecycle.py | 绿 | 四臂日 x1−x3 混库配对钉住（缺陷登记 §5.2） |
| `test_selection_ignores_d7_x2_delta_on_four_arm_main_batch` | eval/tests/test_rerun_audit.py | 绿 | 主批形态 delta 恒空 → 改善/退化类失效（观察项 §5.5） |
| `test_plan_adoption_transcript_missing_excluded_from_denominator` | eval/tests/test_plan_adherence.py | 绿 | 缺 transcript 任务不计分母（静默抬高率，观察项 §5.7） |

套件全量：**251 passed + 1 xfailed**（242 基线 + 本复核 10 用例）。

## 4. 泄漏检查 fallback 方向定性（要求项）

**结论：source_task 解析失败的卡回落 content 全文比对，方向为漏检（假阴性）偏置——不可接受方向，需按解析率审计使用。**

- 解析成功路径：同源卡 sim=1.0 必检出（exact 泄漏无歧义）。
- fallback 路径：卡 content 是蒸馏改写文本（procedure/boundary 步骤语），与 held-out prompt 的字符 3-gram 相似度可能远低于 0.6 → 真实泄漏漏检。实测：改写中文 content 与英文 prompt 相似度 0 → rate 0.0（补用例钉住）。
- 该偏置无法被 future-task 检查完全兜底：future-task 检查同样依赖 source_task 解析成功；解析失败时两条检查同时失明，只剩文本相似度一层。
- 缓解建议（主会话）：报表附带 `n_cards_checked` 与 unresolved 卡数/占比（现输出 n_cards_checked 但无 unresolved 计数——leakage_check 的 report 未输出解析率统计）；unresolved 占比高（EVIDENCE 为主、session 文件缺失）时泄漏结论降级为探索性。
- 本次真实冒烟：备份库 920 active 全解析（ABILITY payload.taskId 直接可用），fallback 未触发，漏检风险实际未暴露；c-d4/D1-post 冻结快照同构。

## 5. 遗留问题清单

### 5.1 【打回·低（理论触发）】metrics_v2._experiment_rows D7 臂优先级与预注册口径相反

- `packages/agent-server/eval/metrics_v2.py:114-124`：`_experiment_rows` 对任意 day 都"优先 experiment、缺则 x2"；模块 docstring（L19-24）与任务书 §1.1 预注册"D7 实验等效臂 = x2（四臂日），无 x2 行回退 experiment"。D7 同日同时存在 experiment 与 x2 行时（pilot 混模式/合并批次形态）实现取 experiment，与预注册相反。
- 实际主批形态（D7 四臂日无 experiment 行）不触发，但预注册口径必须一致。
- 修复建议：按 day 区分——D1 优先 experiment、D7 优先 x2（或传入优先级参数）。
- 已加 xfail 用例 `test_migration_d7_both_arms_should_prefer_x2` 登记。

### 5.2 【打回·中（真实触发）】memory_lifecycle Utility 四臂日配对混入冻结库维度且由文件序决定

- `packages/agent-server/eval/memory_lifecycle.py:119-135`（matched_deltas）：ON/OFF 配对取"每臂文件序首行"，但四臂日同时存在 x1/x2（ON）与 x3/x4（OFF）。实测 D7 命中任务配出 **x1（冻结库+ON）− x3（当日库+OFF）= 0.4**，混入库版本维度；且取 x1 还是 x2、x3 还是 x4 由 task-block 随机执行序（run.jsonl 文件序）决定——同任务在不同批次语义不稳。
- 影响：主批 D7 数据上 Utility（E[Δscore|memory]）口径混乱，是 T7 生命周期报表核心指标。
- 修复建议：当日库配对优先 (x2,x3)，冻结配对 (x1,x4) 兜底；或按库维度输出两对 Utility 并标注。
- 已加用例 `test_utility_four_arm_day_pairs_first_on_off_in_file_order` 钉住现行为。

### 5.3 【打回·中（真实触发）】metrics_v2._load_traces 对旧 schema 库裸崩

- `packages/agent-server/eval/metrics_v2.py:138-156`：只 fail-loud 缺表，未校验列。实测 `--experience-db backup/27b-experience-20260819/store/experience.db`（无 `injected_tokens` 列，T4 迁移前 schema）→ `sqlite3.OperationalError: no such column: injected_tokens` 裸 traceback。c-d4 快照、D1-post 冻结快照同构。
- 修复建议：PRAGMA table_info 校验必需列，缺失时按各节降级 n=0 + note（与"库缺失→None 降级"同风格），或抛明确 ValueError 说明库版本要求。
- 备注：默认 var/eval/experience.db（T4 迁移后）正常；本次冒烟用默认库通过。

### 5.4 【打回·低（真实触发但影响小）】oracle_diagnostic._probe_teacher 探针 URL 双 /v1

- `packages/agent-server/eval/oracle_diagnostic.py:363-371`：`DEFAULT_TEACHER_BASE_URL` 已含 `/v1`，探针拼 `f"{base_url}/v1/models"` → `http://127.0.0.1:8899/v1/v1/models`（实测确认）。行为影响：中继可达时 404→HTTPError→视为可达（探针虚过但随后 OpenAI 调用仍正常）；中继不可达时连接拒绝→URLError→fail fast 仍有效。即探针目的未完全失效，但路径构造错误。
- 修复建议：base_url 去尾 `/v1` 后再拼 `/v1/models`（与 OpenAI client 的 path 约定一致）。

### 5.5 【观察项·待主会话确认】T9 改善/退化典型类在主批数据上不可选（T8 A/B 同理）

- `rerun_audit.py:84`：delta 配对限 `arm=="experiment"`（D-13 登记）；主批 D7 四臂日无 experiment 行 → delta 恒空 → 评审 §十五最有价值的"Memory 明显改善/反向退化"两类在真实主批上永不入选（实测两组仅 delta 不同的数据选取完全一致）。
- 建议：D7 配对改用 x2（campaign_cross 实验等效臂口径，与 metrics_v2 D7 口径一致）。
- 连带：`oracle_diagnostic.ab_scores_from_rows`（L212）只认 control/experiment 臂名，主批四臂行（x3/x4=OFF、x1/x2=ON）本可作 A/B 却不认 → 复用路径对四臂数据恒缺、必须 --run-ab（与 D-9 登记一致，但任务书 §1.3"复用对照臂数据若已有"在四臂主批下不成立）。

### 5.6 【观察项】plan_adherence 四臂日 transcript 按 task_id 取首 ON 臂文件

- `plan_adherence.py:311`：transcripts 字典只按 task_id 键，四臂日 x1/x2 两行共用同一 transcript（文件序先者）；adoption/deviation 按行双计（同一任务 x1、x2 各计一次），detail 重复、deviation 行级分母翻倍。任务级 rate 值不受影响。建议按 (task,arm) 取 transcript 或按任务去重。

### 5.7 【观察项】plan_adherence 缺 transcript 任务静默排除出分母

- `plan_adherence.py:243`：缺 transcript 的任务 detail 注 adopted=None 但不计分母 → transcript 数据缺失会静默抬高 adoption 率。建议计 unknown 并输出计数。

### 5.8 【观察项】metrics_v2 Success@K 空 transcript 高估

- `metrics_v2.py` `_success_group`：文件存在但 transcript 为空 → rounds=0 → 全部 K 命中（高估方向），与"缺文件计 unknown"不对称。低风险（campaign 正常落盘非空），已补用例钉住。

### 5.9 【观察项】metrics_v2 functional 缺键行带偏 + _ids_empty("null") 防御

- `_functional_group`：breakdown 缺部分 automated 键的行按现存键均值+HardPass（只余 1.0 键 → HardPass，高估方向）——预注册口径未排除，已补用例。
- `_ids_empty`（L170）：`"null"` 字符串 → json.loads→None→`len(None)` TypeError。TS 侧 `NOT NULL DEFAULT '[]'` 保证不可达，防御性建议。

### 5.10 【已裁决遗留引用】c-d4/27b 快照 exact 泄漏待主会话裁决

- 真实冒烟确认：27b 备份库 12 对 exact 泄漏（7/8 held-out 任务，sim=1.0 全解析）、12 条 future-task 违规（created 2026-08-11/12 < D7 2026-08-25）。决策记录已提请主会话三选一裁决（冻结库选库/换 held-out 集合/剔除污染任务）——本复核数据进一步坐实，且面比 c-d4 更大（含 task_00014/00078/00087）。

## 6. 真实数据冒烟复核（离线，无 LLM）

| 冒烟 | 命令/输入 | 结果 |
|---|---|---|
| metrics_v2 | `results/campaign-20260819`（默认 var/eval experience.db + gateway 库 + 台账） | 不炸、形态正确：3 行 D1 全为旧行（无 termination_reason）→ fallback_n=3，task_00002（0.812/30 轮）判 BoundarySuccess；Success@K k5-k20=0、k30=2/3（transcript 轮数 30/28/30）；transfer hit_true_n=0（9B 库 173 traces 无 hit=1，降级合规）；compliance n=0（无四臂数据）；economics：台账 2 行 model "m" 0 token → teacher 成本 0、reuse 0 → amortized=None；escalation 23151 行全 NULL → 0 计 + note |
| metrics_v2（负例） | 同上 + `--experience-db backup/27b.../experience.db` | **裸崩**（缺 injected_tokens 列，§5.3） |
| leakage_check | 27b 备份库（只读） | 920 active 卡全解析；**12 对 exact 泄漏（sim=1.0，7/8 held-out）、12 条 future-task 违规**；rate=1.5（配对数/held 数，可 >1 为预注册口径） |
| memory_lifecycle | 27b 备份库 + campaign-20260819 | 与决策记录数字逐一吻合：33 卡复用（top 87 次）、命中 3 任务 success 2/3、utility=0.499875（approximation）、age n=116056（6-9 天）、duplicate_rate=0.929（920 全解析/855 重复） |

## 7. 对账结论（任务书验收口径）

| 验收项 | 结论 |
|---|---|
| 1. 评审 §一~§十九每节有落地证据或 deferred 记录 | 本复核范围内 §四/十二/十三/二/五/十一/十/十六（T6/T10）、§三/十四/八（T7）、§一（T8）、§十五（T9）均有实现+测试+真实冒烟证据；§七（F4+T7 报表）与 §十七（报表分组）由主会话对账 |
| 2. eval pytest 全绿 + 真实数据冒烟 | 通过（251+1xfail；三路冒烟见 §6） |
| 3. Oracle harness 单任务端到端 pilot（D→plan→C 进 Langfuse） | 遗留：主会话统一执行（铁律不跑真实 LLM 批量）；harness 单测覆盖全流程形态 |
| 4. 预注册完整性（阈值/难度档/选取键入 docstring 或任务书） | 通过；发现 1 处 docstring 与实现不一致（§5.1，xfail 登记） |
| 5. pi-test 复核无假绿 | 通过（§2）；4 项实现缺陷打回（§5.1-5.4），9 项观察项（§5.5-5.10） |

## 8. 复核改动文件清单

仅测试文件（未动任何实现文件）：
- `packages/agent-server/eval/tests/test_metrics_v2.py`（+3 用例，+1 xfail 登记）
- `packages/agent-server/eval/tests/test_leakage_check.py`（+1）
- `packages/agent-server/eval/tests/test_oracle_diagnostic.py`（+2）
- `packages/agent-server/eval/tests/test_memory_lifecycle.py`（+1）
- `packages/agent-server/eval/tests/test_rerun_audit.py`（+1）
- `packages/agent-server/eval/tests/test_plan_adherence.py`（+1）

注：本报告未登记 INDEX.md（登记随主会话 commit 一并处理）。
