# D 阶段 Addendum v2 落地（T7+T8+T9）开发决策记录

日期：2026-08-19
执行：pi-dev-1（T7 离线分析器 + T8 Oracle 诊断 harness + T9 重跑审计）
依据：`doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md`（§1.2/§1.3/§1.4）；
`doc/design/D阶段实验设计补充评审_指标与条件检查.md`（§一/三/八/十四/十五）；
`doc/design/preview.html`（§7.2 held-out、§10 写入隔离）
纪律：TDD 先红后绿；eval pytest 全绿（基线 150 → 242）；不 commit/push；
不读不改 .env；不改 omlx；单测全 mock，无真实 LLM 调用。

## 交付清单（10 个新文件，未改动既有文件）

| 文件 | 内容 |
|---|---|
| `eval/plan_adherence.py` | T7：PlanAdoptionRate / PlanDeviationRate（评审 §三），按日分组 JSON |
| `eval/leakage_check.py` | T7：MemoryLeakageRate（3-gram Jaccard 阈值 0.6）+ future-task 提前入库检查（评审 §十四） |
| `eval/memory_lifecycle.py` | T7：ReuseCount / SuccessAfterReuse / Utility / Age / DuplicateRate（评审 §八） |
| `eval/oracle_diagnostic.py` | T8：A/B/C/D 四条件诊断 + plan 蒸馏 + 汇总（评审 §一） |
| `eval/rerun_audit.py` | T9：5 任务 ×3 重复 RunToRunVariance 审计（评审 §十五） |
| `eval/tests/test_plan_adherence.py` 等 5 个 | 对应测试（全 mock，sqlite 内存库 + 合成 transcripts） |

测试：新增 63 个用例；eval 全量 242 passed（150 基线 + T6 23 + T7/T8/T9 63 + 其余）。

## 关键决策（D-1 ~ D-14）

- **D-1（T7 PlanAdoption/Deviation 口径）**：注入卡 join 用 `request_traces.injected_ids`（F0 issue-013 语义：实际进 prompt 的卡 id），限 `type='ABILITY' ∧ payload.role ∈ {Method,Guard}`（SKILL/SOP 独立通道不计，与 injection.ts 注入集一致）；统计只覆盖注入开启臂（experiment/x1/x2）行——control/x3/x4 的 injected_ids 恒空，同一 task_id 的卡不能算到注入关闭的行上。理由：分母语义必须与"注入了卡"严格对应。
- **D-2（动作 token 启发式，预注册）**：bash 命令动词词表（词边界匹配）+ 文件路径（绝对路径或带扩展名相对路径，子串匹配——路径常被拼接改写如 `.bak` 后缀）+ 工具名 `bash`；停用词过滤。误报面在 docstring 注明：文本共现 ≠ 语义等价（"用词不同的等价动作"误判为偏离；"文本相同语义相反"不判为遵循）。
- **D-3（触顶判定统一）**：termination_reason=="max_turns"，旧行 fallback requests>=30——与 trajectory_metrics/campaign_metrics 既有口径完全一致，不另立口径。
- **D-4（source_task 解析顺序，预注册）**：① `payload.taskId`（ABILITY 卡，verifier cardsToStaged 写入；真实库带臂前缀 `control-`，以 `task_` 为锚剥离）→ ② `payload.sourceSession`（EVIDENCE 卡）→ session 文件头 `metadata.task_id`（etl.ts sessionTaskId 同口径；候选解析：原路径 → 搜索目录+文件名 → 搜索目录+"sessions(-synth)"标记后相对后缀，覆盖真实库 `eval/sessions-synth/campaign-d1/x.jsonl` 形态）→ ③ 均取不到时用卡 content 全文与 held-out prompt 比对（近似口径，pairs 里 `fallback=true` 标注）。默认搜索目录 = var/eval/sessions + eval/sessions-synth（实测 920 active 卡全解析）。
- **D-5（leakage 阈值）**：字符 3-gram Jaccard > 0.6 判泄漏（任务书 §1.2 预注册值）；held-out prompt 取 QCB 任务 md 的 `## Prompt` 节（campaign.task_prompt）。
- **D-6（future-task 检查口径）**：held-out 首跑日 = D7 = campaign 开始日 + 6 天（preview §7.2：held-out 只挂 D7）；开始日从 results 目录名 `campaign-YYYYMMDD` 解析，`--campaign-start-date` 可覆盖，解析不到时跳过并在输出标注。created_at 取日期部分按 ISO 串比较。
- **D-7（lifecycle 口径）**：ReuseCount=retrieved_ids 展开计数；SuccessAfterReuse 任务分取 run.jsonl 行最大值（跨日/跨臂）；Utility 有同日 ON/OFF 配对（命中任务限内）按 ON−OFF 均值，无配对用命中任务 score 均值近似并标注 method（评审 §八允许的近似，不伪造对照）；ON/OFF 臂映射与 campaign_cross.ARM_INJECTION 同源；DuplicateRate=同 source_task 多 active 卡占比（active=status='active'），n_unresolved 单独计数。
- **D-8（T8 子集选取，预注册）**：`deterministic_subset(rows, n=5)`——D1 重复集（day==1 ∧ arm==experiment ∧ kind∈{None,repeat}）内 ExhaustedFailure（触顶∧失败）优先 → hard 档（D1 score<0.3）补 → sha256("oracle-diag"+task_id) 排序取；档内同键排序，纯函数确定性。
- **D-9（T8 A/B 复用口径）**：默认复用 run.jsonl——A=control 臂行、B=experiment 臂行，每任务每臂文件首行（重复集任务 D1 即同时出现两臂）；缺任一报错并提示 --run-ab；--run-ab 时 A/B 全部新跑（8789 injection off/on）。
- **D-10（plan 蒸馏，预注册）**：蒸馏 prompt 模板写死模块内（要求编号步骤、每步一句）；解析=正则提取编号，要求从 1 连续编号、每步 ≥4 字符；API 失败或格式不符 → 该任务 C 跳过并计 distillation.failures_n（与 D 成功数差即失败数）。C 包装模板预注册："以下是教师为此类任务验证过的正确计划，请按步骤执行：…"（绕开检索直接给计划，评审 §一原文语义）；plan 以重编号行嵌入（9B 执行友好）。
- **D-11（T8 教师 client）**：base_url 参数化（默认 http://127.0.0.1:8899/v1，env ORACLE_TEACHER_BASE_URL / --teacher-base-url 覆盖）；api_key 只读 env JUDGE_API_KEY（不读文件）；model=deepseek-v4-pro（judge 同款）。教师中继可达性用无认证 urllib 探针 fail fast，不调 preflight（preflight 的 .env 读取路径与"代码只读 env"约束冲突）。
- **D-12（T8 写入隔离）**：全部落盘写 `results/oracle-diagnostic-<date>/`（oracle.json + transcripts/oracle-{A,B,C,D}-*.json，`oracle` 前缀——任务书 §1.3），绝不写 campaign 的 results/<run>/transcripts/；合成器不认该目录/臂名，天然不进 evolution（评审 §十 与 preview §10 精神）。
- **D-13（T9 选取，预注册）**：`select_audit_tasks`——五类（最高分=代表分最大 / ExhaustedFailure 行数最多 / 改善最大=D7−D1 最大 / 退化最大=最小 / 中位=代表分最接近全体中位数），同类 sha256("rerun-audit"+task_id) 排序，类别轮流取、去重后补足；代表分=run.jsonl 行最大 score，D1/D7 配对限 arm==experiment。
- **D-14（T9 不落盘）**：重跑审计不写 transcripts——纯稳定性测量，评分只用内存执行对象，不产生 evolution 输入（任务书未要求落盘，且落盘徒增泄漏面；docstring 注明）。

## 真实数据冒烟（离线，无 LLM）

- `plan_adherence.py results/campaign-20260819 --experience-db ../var/eval/archive/experience-27b-final-20260819.db`：D1 3 个注入任务 adoption=1.0；触顶失败任务 task_00021 deviation 24/30。
- `memory_lifecycle.py`（同库 + campaign-20260819）：33 卡被复用；3 命中任务 success 2/3；utility=approximation（D1 无同日 ON/OFF 配对）；age n=116056（含 removed）；duplicate_rate 0.93（920 active 全解析，855 与同 source_task 卡共存——多日同任务重复挖掘所致，正是该指标要暴露的量）。
- `leakage_check.py --experience-db ../var/eval/snapshots/c-d4.db --results campaign-20260819`：**发现真实泄漏**——4/8 held-out 任务（task_00011/00041/00050/00064）在 c-d4 快照中有 exact source_task 卡（sim=1.0，created 2026-08-11 < D7 首跑 2026-08-25，future-task 违规同命中）。此为 C 时期经验库（held-out 机制 2026-08-19 才生效，C 期这些任务是普通新任务，合法入库）与当前 held-out 集合撞车；D 期若以该快照作冻结库，相应任务 transfer 比较会受 exact-replay 污染。**提请主会话裁决**：冻结库选库/换 held-out 集合/转移报告剔除污染任务，三选一（不属本任务范围）。
- oracle 子集/rerun 选取在 campaign-20260819 真行上确定性输出（3 行 D1 在跑中，A 全缺 → 报错提示 --run-ab，符合设计）。

## 打回修复（2026-08-19，pi-test v2 复核报告）

- **D-15（5.2 中，真实触发）**：memory_lifecycle Utility 配对规则预注册死——
  只允许同库配对照：experiment vs control / 四臂日 x2 vs x3（ALLOWED_PAIRS）；
  x1/x4 冻结臂与混库组合（x1−x3）一律不配对并计 unpaired_n（双面齐备但无合法
  同库配对的 (task, day) 组数，两种 method 分支均输出）。旧行为（文件序首臂）
  会配出 x1−x3 混库配对且随 task-block 随机执行序不稳。测试：替换旧钉住用例，
  新增 x1−x3 不得配对 / 混库组合计数 / 混合组三用例。
- **D-16（5.4 低）**：oracle_diagnostic._probe_teacher 探针 URL 去尾 /v1 防双拼
  （_teacher_models_url），测试覆盖 base 含/不含/带尾斜杠三种形态。
- **D-17（泄漏 fallback 观察项）**：leakage_check 报表增 unresolved_n /
  unresolved_ratio（source 三阶解析失败或 source prompt 取不到的 active 卡
  计数与占比——fallback content 比对是假阴性偏置，无法被 future-task 检查
  兜底），ratio > 0.2（预注册 UNRESOLVED_DEGRADED_THRESHOLD）时
  conclusion="degraded"（泄漏结论只作探索性），CLI 输出 degraded 告警行；
  docstring 注明漏检偏置。测试：降级/边界（恰 0.2 不降级）/全解析/空库四用例。
- **D-18（5.5 连带，主会话同期决定）**：oracle ab_scores_from_rows 按
  campaign_cross 等效臂口径复用——A=control/x3、B=experiment/x2（各取文件序
  首行），x1/x4 冻结臂不参与（缺 A/B 报错提示 --run-ab）。主会话同期改写的
  测试并入（含 1 处断言矛盾修正：冻结臂任务缺 A/B 计入 missing）。

修复后 eval 全量 **262 passed**（251+1xfail 基线：metrics_v2 xfail 转绿 + 本批
新增 8 用例）。真实备份库冒烟复现 pi-test 数字：leakage 12 对/rate 1.5/920 卡
全解析 conclusion=ok；memory_lifecycle 数字不变 + unpaired_n=0；四臂形态
x2−x3 配对 0.05/2 对 + 混库组 unpaired_n=1；degraded 路径（1 卡未解析 ratio 1.0）
输出 conclusion=degraded。

## 遗留

- T8/T9 真实端到端（D→plan→C 真实跑通进 Langfuse、5×3 真跑）由主会话统一做（铁律：不跑真实 LLM 批量）。
- T7 三分析器在 D 期完整数据（D1-D7 + 四臂日）上的终版报表由主会话在 D7 后汇总。
- c-d4/27b 快照 exact 泄漏（12 对 / 7-8 个 held-out 任务）待主会话裁决（冻结库选库/换 held-out 集合/剔除污染任务）。
- 观察项 5.5（T9 改善/退化类主批形态不可选）、5.6、5.7（plan_adherence 缺 transcript 分母）待主会话确认。

Refer Spec：doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md；
doc/design/D阶段实验设计补充评审_指标与条件检查.md；
doc/design/preview.html；
doc/design/2026-08-19-d-stage-addendum-v2-pi-test-review.md
