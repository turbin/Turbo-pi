# D 阶段 Analysis Addendum v2（GPT 补充评审）落地：指标设计与任务书

日期：2026-08-19
状态：**已批准方向（用户 08-19 指令：Oracle 诊断必须添加；完全遵循 GPT 建议实施；按 GPT 指标重新设计；pi agent 开发、主会话整体 review；先 pilot 后跑批）**
依据：`doc/design/D阶段实验设计补充评审_指标与条件检查.md`（GPT 评审，下称"评审"）；`doc/design/preview.html`（主稿）；`plans/2026-08-19-d-stage-addendum-dev-tasks.md`（v1 任务书）
纪律：全部新增为 **Analysis Addendum v2**，主判据①-⑤与已起跑执行口径不变；评审 §十八优先 8 项全部纳入。

## 1. 指标设计（预注册口径，开发以本节为准）

### 1.1 离线分析包（T6，评审 §四/十二/十三/二/五/十一/十）

| 指标 | 预注册定义 |
|---|---|
| Success@K | P(任务在第 K 轮前成功)，K∈{5,10,15,20,30}；成功=score≥0.5；轮数取 transcript assistant 回合数；输出按日/臂分组 |
| 失败迁移矩阵 | 重复任务 D1→D7 逐任务四象限迁移计数：EfficientSuccess=成功∧¬触顶 / BoundarySuccess=成功∧触顶 / EarlyFailure=失败∧¬触顶 / ExhaustedFailure=失败∧触顶（触顶=termination_reason=="max_turns"，旧行 fallback requests>=30） |
| RecoveryConversionRate | P(D7=EfficientSuccess ∨ BoundarySuccess ∣ D1=ExhaustedFailure)——评审原文为 EfficientSuccess，扩展含 Boundary 并在输出中分列两口径 |
| RegressionRate | P(score_D7 < score_D1 − δ)，**δ=0.1 预注册**，逐任务配对 |
| MemoryInducedRegressionRate (=NegativeTransferRate) | P(score_ON < score_OFF − δ)，同任务同日的 ON/OFF 臂配对（对照臂日 + 四臂日 x2 vs x3）；δ=0.1 |
| UsefulHitRate / FalseHitRate | 任务级近似（评审认可近似口径）：注入任务 score_ON ≥ score_OFF − δ 且 hit=true → useful；score_ON < score_OFF − δ → false/负迁移；分母=hit=true 任务数；逐任务注记 pairing 缺失时按臂均值近似并标注 |
| Functional vs Judge 分层 | grading.breakdown 按前缀分组：`automated.*` 均值=FunctionalScore（HardPass=全部 automated 子项=1.0）、`llm_judge.*` 均值=JudgeScore；报 FunctionalSuccessRate（HardPass 占比）与 Judge↔Functional 背离任务清单（Judge≥0.5 ∧ ¬HardPass） |
| 难度分层 | 按 D1 实验臂 baseline score 三档：easy ≥0.6 / medium 0.3-0.6 / hard <0.3（分层仅用实验前信息）；另按任务元数据（id 含 dsl/workflow/multi 关键词）辅层；分层报 MemoryGain |
| TreatmentCompliance | 四臂日：X3/X4 全部 request_traces injected_tokens=0 ∧ injected_ids=[]；X1/X4 走冻结实例（gateway base 指纹）；模型指纹=AGENT_EVAL_EXPECTED_OMLX_MODEL；输出 compliance_rate（目标 100%）+ 违规明细 |

### 1.2 B 级分析器（T7，评审 §三/十四/八）

| 指标 | 预注册定义 |
|---|---|
| PlanAdoptionRate | 注入 Method/Guard 卡的任务中，transcript 出现卡片关键动作（从卡 content 提取动作词/命令 token，启发式预注册）覆盖 ≥1 的比例 |
| PlanDeviationRate | 触顶∧失败任务中，与任何注入卡动作 token 零重叠的 toolCall 占比（启发式，注明误报面） |
| MemoryLeakageRate | held-out 任务 prompt 与库中卡片 source_task 的 prompt 文本相似度（字符 3-gram Jaccard，阈值 0.6 预注册）> 阈值的配对数 / held-out 任务数；目标=0；另查 future-task 提前入库（卡片 created 晚于该任务首跑日的 source_task 不得等于 held-out id） |
| Memory 生命周期报表 | experience.db 离线：ReuseCount（request_traces retrieved_ids 计数）、SuccessAfterReuse、Utility=E[Δscore∣memory]（F2 confidence 口径对齐）、Age、DuplicateRate（卡片 contentHash 近重：同 source_task 多 active 卡比例） |

### 1.3 Oracle Teacher Plan 诊断（T8，评审 §一，用户裁决必须添加）

四条件（诊断子集 = 确定性选 5 个任务：D1 重复集中 ExhaustedFailure 任务优先 + 补足 hard 档任务，选取键 sha256("oracle-diag") 预注册；执行时机 **D7 后一次性**，不进主批、不进 evolution——transcripts 打 `oracle` 前缀且合成器不认该臂名，天然隔离）：

| 条件 | 实现 |
|---|---|
| A：9B Alone | 8789 injection=off 跑诊断任务（复用对照臂数据若已有，否则新跑） |
| B：9B + Retrieved Memory | 8789 injection=on（复用实验臂数据） |
| C：9B + Oracle Teacher Plan | 8789 injection=off + Oracle plan 直接嵌入任务 prompt 包装（**绕开检索**，注释注明评审 §一）；plan 来自条件 D 的轨迹蒸馏 |
| D：Teacher Direct Solve | deepseek-v4-pro（8899 中继）跑同一 bash-tool agent loop（同 MAX_TURNS=30、同 workspace 克隆、同 judge） |

输出（每任务 + 汇总）：MemoryGain=B−A、RetrievalLoss=C−B、ExecutionGap=D−C、TeacherSolveRate；plan 蒸馏方式（教师轨迹→结构化步骤，同一教师模型摘要）预注册入 docstring。

### 1.4 重跑稳定性审计（T9，评审 §十五）

5 任务 × 3 重复（任务选取 = 高分/30轮失败/改善/退化典型，确定性键 sha256("rerun-audit")）；指标 RunToRunVariance = 每任务 score 极差与标准差；搭车 D7 后诊断批同一窗口执行（省 preflight）。

### 1.5 教师成本摊销（T10，评审 §十六）

run-evolution 落 usage 台账（var/eval/evolution-usage.jsonl：每 LLM 调用 model/prompt_tokens/completion_tokens）；AmortizedTeacherCost = Σ(teacher tokens)×单价 / SuccessfulReuseCount；单价表预注册常量（deepseek-v4-pro 公示价，注明日期）；TotalSystemCost 报表含 StudentInference/Escalation/AmortizedTeacher/Infra 四项。

## 2. 任务拆分（沿用双人组协议与通用约束）

| 任务 | 内容 | 负责 | 预估行 |
|---|---|---|---|
| **T6** | 离线分析包 v2（§1.1 全部 7 指标）——eval/metrics_v2.py + 测试 | pi-dev-2 | ~600 |
| **T10** | 教师成本摊销（usage 台账 + 摊销报表，并入 metrics_v2） | pi-dev-2 | ~200 |
| **T7** | Plan Adherence + 泄漏检查 + Memory 生命周期（§1.2） | pi-dev-1 | ~450 |
| **T8** | Oracle 诊断 harness（§1.3，A/B/C/D 四条件 + plan 蒸馏 + 汇总输出） | pi-dev-1 | ~450 |
| **T9** | 重跑稳定性审计（§1.4，复用 campaign run_agent 回路） | pi-dev-1 | ~150 |
| **T-docs** | 本任务书 + INDEX + 决策记录（主会话） | 主会话 | — |

## 3. 验收口径（主会话对 GPT 评审逐节对账）

1. 评审 §一~§十九每节有落地证据或明确的 deferred 记录（§七教师计划质量闸=F4 已有机制+T7 报表覆盖；§十七七层体系=报表分组方式）
2. eval pytest 全绿 + 真实数据冒烟（campaign-20260819 + pilot-9b-addendum + pilot v2 的 request_traces/experience.db）
3. Oracle harness 单任务端到端 pilot（D→plan→C 真实跑通，进 Langfuse）
4. 预注册完整性：所有阈值（δ=0.1/相似度 0.6/难度档/选取键）入 docstring 或本任务书
5. pi-test 复核无假绿；决策记录随 commit

Refer Spec：doc/design/D阶段实验设计补充评审_指标与条件检查.md；doc/design/preview.html；plans/2026-08-19-d-stage-addendum-dev-tasks.md
