# Addendum v2（GPT 评审落地）主会话整体 review：GPT 19 节逐节对账 + 验收记录

日期：2026-08-19
状态：**验收通过（对账 17/19 全落地 + 1 项 deferred + 1 项补漏中）；eval 262 + python 89 + gateway 195 主会话独立复跑全绿**
依据：`doc/design/D阶段实验设计补充评审_指标与条件检查.md`（GPT 评审）；`plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md`；`doc/design/2026-08-19-d-stage-addendum-v2-pi-test-review.md`（pi-test 复核）；`doc/design/2026-08-19-d-stage-addendum-v2-t7-t8-t9-changes-and-decisions.md`（pi-dev-1 决策记录 D-1~D-18）

## 执行链

pi-dev-1（T7/T8/T9）+ pi-dev-2（T6/T10）并行 → pi-test 复核（251+1xfail，发现 4 项打回级缺陷：5.2 混库配对/5.3 旧 schema 裸崩/5.1 D7 臂口径/5.4 双 /v1）→ 双方打回修复（262 passed 0 xfail）→ 主会话整体 review（本文件）：实现文件通读 + 三套件独立复跑 + 19 节对账。

## GPT 评审 19 节逐节对账

| § | 内容 | 落地 | 证据 |
|---|---|---|---|
| 一 | **Oracle Teacher Plan 诊断**（用户裁决必须） | ✅ T8 | `oracle_diagnostic.py`：A/B/C/D 四条件、sha256("oracle-diag") 子集三优先级、plan 蒸馏（编号步骤正则+失败计数）、oracle 前缀天然隔离不进 evolution、A/B 复用认 x2/x3 等效臂（打回修复） |
| 二 | 命中拆命中/命中正确 + NegativeTransfer | ✅ T6 | `metrics_v2.transfer_hits`（Useful/FalseHit，配对缺失臂均值近似标注）+ `regression` 的 MemoryInducedRegressionRate（δ=0.1 严格小于） |
| 三 | Plan Adherence 族 | ✅ T7 | `plan_adherence.py`：Adoption/Deviation 双指标，动作 token 提取启发式与误报面预注册入 docstring |
| 四 | Success@K | ✅ T6 | `metrics_v2.success_at_k`：K∈{5,10,15,20,30}，rounds 真从 transcript 解析（pi-test 验证非 requests 冒充），按日/臂分组 |
| 五 | Functional vs Judge | ✅ T6 | `functional_judge`：breakdown `automated.*`/`llm_judge.*` 前缀分组、HardPass、背离清单；数据零新埋点（QCB hybrid 天然分层，主会话实证） |
| 六 | Gate 混淆矩阵 | ⚠️ **deferred（FP 侧）** | FN 侧已有（v1 addendum MissedEscalationRate）；FP 侧（不该升级却升级）需反事实 ground truth（升级任务禁升级重跑）——D 阶段 escalation 至今为 0，评审原文亦允许"audit subset 上做"；**裁决：D7 若有升级样本则开 audit subset，无则在最终报告声明 FP 不可测** |
| 七 | Teacher 计划质量评估 | ✅ 部分（机制+报表） | F4 可证伪验证闸是入库质量门本体（v1 既有）；质量指标并入 `memory_lifecycle.py`（Utility/Duplicate/Age）；TeacherPlanLength/Generalizability 单列指标不单设（评审为建议级，库生命周期报表覆盖其决策用途） |
| 八 | Memory 生命周期 | ✅ T7 | `memory_lifecycle.py` 五指标；Utility 配对规则打回修复（只允许同库对照 experiment-control / x2-x3，混库计 unpaired_n） |
| 九 | Context Budget（MemoryTokenRatio） | 🔧 **补漏中**（数据已备 T4） | request_traces.injected_tokens/prompt_tokens 已采集（v1 T4）；报表函数漏落——已派 pi-dev-2 补 `context_budget` 节（ratio 分布 + 四分桶 score 对照），验收后关闭 |
| 十 | Treatment Compliance | ✅ T6 | `treatment_compliance`：X3/X4 零注入校验 + 违规明细 + 旧 schema 降级（5.3 修复）+ n=0 不 fail |
| 十一 | Task Difficulty 分层 | ✅ T6 | `difficulty_layers`：D1 baseline 三档（仅用实验前信息）+ 关键词辅层 + 分层 MemoryGain |
| 十二 | 失败迁移矩阵 + RecoveryConversion | ✅ T6 | `migration`：四象限 + Recovery 双口径（efficient_only / efficient_or_boundary，任务书扩展预注册） |
| 十三 | 回归/负迁移率 | ✅ T6 | `regression`：RegressionRate（D1→D7）+ improved/unchanged/regressed 分布 |
| 十四 | held-out 泄漏检查 | ✅ T7 | `leakage_check.py`：3-gram Jaccard>0.6 + future-task 检查 + unresolved_ratio>0.2 结论降级（pi-test 漏检偏置打回修复）；**真实发现：27b 备份库 12 对 exact 泄漏+12 条 future 违规——9B 空库起跑不受影响；D7 transfer 结论前必须对新库重跑本检查（已入 runbook 裁决）** |
| 十五 | 重跑稳定性审计 | ✅ T9 | `rerun_audit.py`：五类典型确定性选取 + RunToRunVariance；执行排期=D7 后诊断窗口（与 Oracle 同批省 preflight） |
| 十六 | 教师成本摊销 | ✅ T10 | 两个 llm_client `_post` 落 `evolution-usage.jsonl`（写失败只告警、MockLLM 不写）+ `economics` 节四项 TotalSystemCost + 单价表预注册 |
| 十七 | 七层指标体系 | ✅ 报表约定 | 最终报告按七层组织：Outcome(metrics) / Autonomy(addendum v1) / Trajectory(trajectory_metrics) / Retrieval(transfer_hits) / PlanExecution(plan_adherence) / MemoryQuality(lifecycle+leakage) / Economics(economics)——写入交叉日 runbook 报告模板 |
| 十八 | 优先 8 项 | ✅ 8/8 | Oracle(T8) / 2×2 触顶成败(v1 cap 三档+§十二迁移) / Success@K / Useful-FalseHit / Plan Adoption-Deviation / Functional / Compliance / RecoveryConversion |
| 十九 | "突破 30 轮"机制组合判定 | ✅ 判定规则入档 | 最终报告判定式 = EfficientSuccessRate↑ ∧ ExhaustedFailureRate↓ ∧ FunctionalSuccess 不降 ∧ NegativeTransfer 不恶化 ∧ Compliance=100%（+ON/OFF 配对同向）——写入本节即预注册 |

## 主会话补充裁决（随本记录生效）

1. **§六 FP 侧 deferred**（理由见表；升级样本出现即触发 audit subset）。
2. **泄漏检查 D7 门禁**：D7 出 TransferGain 结论前，必须对**当日生产库**跑 leakage_check 且 conclusion≠degraded 且 MemoryLeakageRate=0，否则 TransferGain 降级为探索性。（27b 备份库的泄漏发现不影响 9B 空库主线，但证明该检查不可省。）
3. **§九 补漏**（pi-dev-2 进行中）：`context_budget` 节随本批次一并验收。

## 测试与冒烟证据（主会话独立复跑）

- eval pytest **262 passed 0 xfailed**；python 管线 **89 passed**；gateway **195 passed**；agent-server vitest **346 passed**（pi-dev-2 复跑，主会话确认）
- 真实数据冒烟（pi-test+dev 双方，主会话抽验）：metrics_v2 × campaign-20260819 ✅；leakage_check × 27b 备份库（12 对 exact+12 future，conclusion=ok，unresolved=0）✅；memory_lifecycle × 同库 ✅；旧 schema 库 compliance 降级不崩 ✅
- pi-test 假绿审计：无假绿；4 项打回缺陷全部修复并转绿（262 0 xfail）

## 遗留

1. §九 context_budget 报表（进行中，关闭后本项清零）
2. T8 Oracle 端到端真实冒烟（主会话 pilot 执行：单任务 D→蒸馏→C 全链路）
3. run-evolution 真实管线的 usage 台账首轮落账（D1 夜间进化时验证）
4. 观察项（pi-dev-1 决策记录遗留 5.5-5.7）：低风险，D7 报告时复核

Refer Spec：doc/design/D阶段实验设计补充评审_指标与条件检查.md；plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md；doc/design/2026-08-19-d-stage-addendum-v2-pi-test-review.md
