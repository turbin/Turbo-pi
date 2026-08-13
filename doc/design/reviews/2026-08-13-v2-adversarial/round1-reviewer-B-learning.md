# 对抗式审查报告（round 1）— 审查员乙：学习机制与指标有效性

- 审查对象：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`（经验学习系统概要设计 v2）
- 审查视角：学习是否真的会发生、指标是否可信
- 审查人立场：对抗式，目标是攻击该设计在"学习"与"指标"上的漏洞；每条 finding 预写设计方可能的反驳点，供答辩使用
- 依据材料：设计文档全文；`2026-08-13-agent-server-system-design-and-issue-inventory.md`、`2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md`、`2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md`、`2026-08-05-agent-server-c-campaign-design.md`、`2026-08-09-adversarial-review-experiment-validity.md`、`2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md`；源码：`packages/agent-server/src/{retrieval.ts, injection.ts, skill-catalog.ts, sop-schema.ts, experience-store.ts, offline/{scheduler.ts, pipeline.ts, etl.ts, verifier.ts, canonicalize.ts}}`、`packages/agent-server/python/verification_selection/{pipeline.py, verifier.py}`、`packages/agent-server/eval/{campaign_metrics.py, synthesize_campaign_sessions.py}`

## 总体判断

设计文档把一条本应是"执行→记录→蒸馏→验证→回流→归因奖惩"的闭环，写成了已经生效的机制；但逐代码核对后，**闭环在三个关键节点上是断的或近乎空洞的**：

1. **验证闸门近乎恒真**（F7）：单轨迹任务的 quality 是对一个硬编码"最弱基线"strawman 的偏好概率，任何多步轨迹都能过 0.5，闸门不验任务成败、不验交付物（issue-010 的根因未解决）。
2. **"三路合并"进料是虚的**（F8）：代码对所有 session 一视同仁，无胜负/教师腿；合成脚本只把学生（含教师兜底步骤的混合）transcript 拼成一条轨迹，"同局老师胜局"与"败局对照"在打分里被替换成 hardcoded strawman。
3. **奖惩闭环不存在**（F10/F13）：§3.6 实战归因整套待建；active 卡没有任何降级/淘汰代码路径（连设计文档自画的 lifecycle 图都未实现），错误晋升卡永久滞留并放大。

指标侧（F1/F2）另有独立问题：预注册判据的"升级率"在核算代码里是 **per-任务日二元**（D7 重复集 n=20），与红线 6 自述的"model_runs 全量口径、拒绝小样本外推"直接矛盾；且实验设计没有能力区分"学习起效"与"门控变松 / 教师兜底 / 注入修格式"。

---

## Findings

### F1 【critical】升级率指标口径自相矛盾：核算代码是 per-任务二元（n=20），与红线 6"全量口径、拒绝小样本外推"冲突

- **文档位置**：§1 目标、§3.1 有效作用（"升级率是衡量学生独立性的核心指标口径"）、§6 红线 6；对照 `eval/campaign_metrics.py::escalation_rate/check_criteria`。
- **攻击论点**：v2 通篇把"升级率"当作核心指标，却从未定义它是 per-request 还是 per-task。预注册判据的实现 `campaign_metrics.py` 里，`escalated` 是**每个任务日一个布尔**（`annotate_escalation` 按 trace_id 集合，任一升级即 True），`escalation_rate = sum(escalated)/len(rows)`，D7 重复集 = 20 行。于是判据①"重复任务升级率 ≤5%"实际上是在 20 个二元观测上断言"≤1 个任务日发生升级"——单个任务翻转就是 5pp，恰是阈值的量级。这与红线 6"核心指标以 model_runs 与 request_traces **全量**为准，拒绝**小样本外推**"自相矛盾：E5 报告里升级率是 3376/6204=54.4%（per-request 全量），而任务日二元口径会把数千请求塌缩成 20 个样本，两种口径数值可能差一个数量级，且文档不说明用哪个。
- **支撑证据**：`campaign_metrics.py` `check_criteria`：`rep_d7 = [r for r in exp if kind=="repeat" and day==final_day]`，`rep_rate = escalation_rate(rep_d7)`；`escalation_rate` 对"缺 escalated 标记"fail loud，但一旦有标记就是对行计数，无 per-request 权重。08-09 审查已点名 `final_day=max(day)` 冒充 D7、空切片 `escalation_rate([])=0` 平凡通过——本文档继承这些未修。
- **设计方可能反驳**："升级率"被有意定义为"任务级升级率"（有多少比例的任务经历过升级），这是用户 08-05 拍板的预注册口径；model_runs 全量口径用于报告核验，判据用任务级口径不算矛盾。
- **追问**：即使口径是有意的，也必须回答——(a) 为何 v2 文档不自含口径定义；(b) n=20 下 5pp 阈值的置信区间是什么、功效多大；(c) 红线 6 说"拒绝小样本外推"，为何首判据恰恰是 20 样本外推。

### F2 【critical】实验设计无法区分"经验学习起效"与"门控变松 / 任务变简单 / 教师兜底掩盖"，且新任务判据无对照基线

- **文档位置**：§1、§3.5、§3.6；`2026-08-05-agent-server-c-campaign-design.md` §3。
- **攻击论点**："重复任务升级率逐日下降"可被多种非学习因素完全解释：(a) 门控是移动靶——issue-003 证明 harness 参数（max_tokens 200→800）能静默把 84-87% 请求升级到云端，门控行为随配置漂移；(b) E5 已证明注入的主要收益是**修格式**（empty_output 升级 -29%），即升级率下降可能只是"注入块把输出格式修好"而非"能力独立"；(c) 教师兜底：升级步骤由 DeepSeek 完成，升级率下降时学生可能在更多步上被教师覆盖，独立性反而未提升。§3.6 自述"对照臂差值做因果校准"，但对照臂只在 D1/D7 各跑一次重复集（20 任务），只有两个时点、无逐日对照，统计功效不足以排除时间漂移。判据②"新任务 <20%"更严重：新任务每天都是新的、只在实验臂跑一次，**无冷库基线、无对照臂**——无法区分"学生泛化能力本来 <20%"与"学习提升了泛化"。
- **支撑证据**：campaign 设计 §3 对照臂仅 D1/D7；新任务无任何 control；`2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md` 证明门控可被 harness 静默改变；`e5-flywheel` §7 证明注入收益主要来自格式修复。
- **设计方可能反驳**：判据③要求"升级率逐日下降趋势 + 成本/错误分布同报"，control D1 vs D7 差值提供"无记忆时的自然波动"参照。
- **追问**：判据③明确"不做硬断言"（软指标）；仅两个时点的 control 无法排除单调的时间漂移；新任务判据的对照从何而来？

### F3 【major】"重复/新任务如何判定"与置信区间、统计功效均未定义

- **文档位置**：§1（目标一句话）、§3.5；`campaign_plan.py` 在 Refer 文档而非 v2 内。
- **攻击论点**：§1 声称"重复任务升级率趋近 0、新任务升级率低于 20%"，但 v2 本身不定义"重复/新任务"的判定规则（task_id 精确匹配？每日 workspace 初始状态是否保证同一任务同构？任务内容跨日是否漂移？），不给出样本量（20 vs 79）的置信区间，不给出最小效应量或统计功效声明。作为"标准参照"文档，读者无法从 v2 单文档判定指标是否可信，必须外跳到 campaign 设计文档才找得到口径，而后者明确说判据①②是"绝对阈值，不要求对照显著性检验"——即判据从设计上就**豁免了显著性检验**。
- **支撑证据**：v2 §1 只有一句目标；`2026-08-05-agent-server-c-campaign-design.md` §6"判据①②是绝对阈值（用户拍板），不要求对照显著性检验"。
- **设计方可能反驳**：绝对阈值是用户拍板的验收口径，不是统计推断；口径细节在 campaign 设计文档，v2 是概要设计不必自含。
- **追问**：绝对阈值可以不要 p 值，但必须给 CI（否则 n=20 下 5% 与 10% 不可区分）；v2 作为"标准参照"应至少引用口径定义处而非留白。

### F4 【major】SKILL 目录与 SOP schema 注入不做任务相关性检索，全局 top-N 恒定注入，稀释上下文且污染 A/B 可归因性

- **文档位置**：§3.4（"SKILL 目录（top-10）入 system prompt，SOP（top-15）转为工具 schema 并入 tools"）。
- **攻击论点**：`buildSkillCatalog` 用 `listActive("SKILL", 10)`（按 quality 全局 top-10）、`buildSopSchemas` 用 `listActive("SOP", 15)`（全局 top-15），**与检索结果完全无关**。意味着每个请求都注入同一批"最优"技能与工具，与当前任务无关——跨任务串扰、上下文稀释；且这使得实验臂的 prompt 构成取决于"库中最优技能/工具的全局状态"这一与任务无关的变量，对照臂与实验臂的差异不只是"检索到的相关经验"。
- **支撑证据**：`skill-catalog.ts` `buildSkillCatalog → store.listActive("SKILL", limit)`；`sop-schema.ts` `buildSopSchemas → store.listActive("SOP", limit)`。
- **设计方可能反驳**：SKILL/SOP 语义上是"通用能力"而非"任务相关经验"，全局注入是合理默认；且 C campaign 中 skill_evolution 无 benchmark 输出 `[]`，SKILL 实际恒空。
- **追问**：若 SKILL 恒空、SOP 稀少，则"五类卡片"在实际运行中退化为少类，v2 为何把 SKILL/SOP 写成核心机制？"通用能力"与"任务相关性"的边界如何保证全局 top-N 不干扰检索 top-8 的效应估计？

### F5 【major】SOP 转 tools schema 无服务端执行器、无契约：模型调用落空、重名静默丢弃，有效性不可预期

- **文档位置**：§3.4、§2.4（`buildSopSchemas`）。
- **攻击论点**：SOP 转成的 function schema 被并入 tools 列表转给 gateway→模型，但 agent-server 没有任何执行器实现这些 SOP 工具；campaign 的 bash agent loop 只认 bash 工具。若学生真的调用某个 SOP 工具，harness 无对应执行器 → toolcall 落空或报错；`toolcall-validator` 是**观察模式不拦截**，错误调用会进入轨迹、进而被蒸馏。重名时"请求侧胜出"（`injection.ts`）静默丢弃 SOP——注入的有效性取决于请求侧是否恰好没重名。设计文档从未声明 SOP 工具"是否应被调用"这一语义（是声明式流程示范，还是可执行工具？），属契约缺失。
- **支撑证据**：`sop-schema.ts` 仅生成 schema；`injection.ts` 重名 `requestToolNames` 过滤；`toolcall-validator.ts` 观察模式（系统设计文档自述"在线仅观察不拦截"）。
- **设计方可能反驳**：SOP 是"给模型看的流程 schema"，模型参考其步骤即可，不必真调用；重名请求侧胜出是合理默认。
- **追问**：若不应被调用，为何以 tool schema 形态注入（模型对 tools 的默认行为就是调用）？文档需要写明 SOP 的预期使用语义，否则"模型是否调用、调用后谁执行"无答案。

### F6 【major】EVIDENCE 观察碎片以 user 角色注入，语义污染 + 插入位置（最后 user 消息前）在多轮任务中错位

- **文档位置**：§3.4（"EVIDENCE 与 Method/Guard 合成用户消息插在最后用户消息之前"）。
- **攻击论点**：(a) 检索到的 EVIDENCE 是助手观察碎片（E5 实证如 "On the desk 1, you see a desklamp 1"），却以 **user 角色**注入，模型会把它们当作"用户断言的事实"，与真实用户指令混淆，可能产生错误信念——E5 §7 已观察到"位置类碎片对规划构成错误暗示（正负对冲）"。(b) 插入位置固定在"最后一条 user 消息之前"，对 30 轮 bash loop 的多轮任务，注入块每次贴当前轮，历史证据与当前步骤的语义错位；且改变了 prompt 骨架（08-09 M5 已发现双 system 不对称）——实验臂与对照臂的差异不只是"多了经验"，还包含结构差异。
- **支撑证据**：`injection.ts` `messages.splice(lastUserIdx, 0, ...)`；`e5-flywheel` §7；`2026-08-09-adversarial-review` M5。
- **设计方可能反驳**："合成用户消息 + <Extra Info> 块"是 SPEC §5.1 既定形态；E5 证明格式示范有正向收益（升级率 -18pp）；位置选最后 user 是为了贴合当前轮。
- **追问**：观察碎片被当作 user 断言的风险如何控制（角色错配是已知 E5 对冲因素）；对多轮任务的"最后 user 前"插入为何优于"首轮注入"或"system 层注入"。

### F7 【critical】验证闸门近乎空洞：quality 是对硬编码 strawman 的偏好概率，不验任务成败、不验交付物

- **文档位置**：§3.3（"晋升统一双阈值 0.5"）、§3.6（"quality 当前为裁判自评点估计"）。
- **攻击论点**：C campaign 每任务只有一条轨迹，走 `select_experiences` 的**单轨迹分支**：`quality = verifier.score_pair(候选轨迹, REFERENCE_TRAJECTORY).preference`，而 `REFERENCE_TRAJECTORY` 是硬编码的一句"最简无结构乱猜、无计划、无检索、无验证"。quality≥0.5 的语义是"judge 认为这条轨迹比一个故意摆烂的基线更值得偏好"——任何多步、带计划/工具调用的轨迹几乎必然通过，**闸门不验任务是否成功、不验交付物是否产出**。这正是 issue-010 的结构性根因，且它发生在晋升闸门这一层（而非仅仅是蒸馏模板缺字段）。
- **支撑证据**：`verification_selection/pipeline.py` `REFERENCE_TRAJECTORY` 常量 + `select_experiences` 单轨迹 `vs_reference` 分支；`verifier.py` 打分标准为 Specification/Output/Errors 的 LLM 主观评判（对 strawman 相对比较）。
- **设计方可能反驳**：vs_reference 是 LLM-as-a-Verifier 论文标准口径，PPT 用于多轨迹任务；0.5 阈值至少过滤掉无结构噪音。
- **追问**：单轨迹场景下 strawman 参照的实际鉴别力为零——一个"结构化但失败"的轨迹 vs "无结构乱猜"，judge 会在哪个标准上判前者输？0.5 阈值是否被任何校准数据验证过？issue-010 明确闸门"不验交付产出"，此发现说明闸门连"成败"都不验。

### F8 【critical】"进化进料三路合并"退化为"一路（学生混合轨迹）vs strawman"，教师胜局与败局对照在实现中不存在

- **文档位置**：§3.5（"进化进料三路合并——学生轨迹、同局老师胜局、败局对照"）。
- **攻击论点**：代码路径 `scheduler → runOfflinePipeline → collectTrajectories` 对所有 session 文件一视同仁——`parseSessionFile` 连 metadata 里的 `score/arm` 都不读，无任何 win/lose/teacher 语义；`synthesize_campaign_sessions.py` 只把 campaign 的 transcript（学生轨迹，升级步骤混入教师单步输出）拼成一条轨迹，**不合成"老师胜局"轨迹、不合成"败局对照"轨迹**。所谓"同局老师胜局"没有数据来源（教师只在 per-request 升级时输出单步，从不整局跑任务）；"败局对照"在打分里被替换成 F7 的 hardcoded strawman。三路合并的"两路半"在实现中不存在。
- **支撑证据**：`pipeline.ts collectTrajectories/parseSessionFile`（无胜负字段）；`synthesize_campaign_sessions.py`（单 transcript，metadata 只有 score/arm/day）；`scheduler.ts`（无三路逻辑）；`pipeline.py`（single-trajectory → vs_reference）。
- **设计方可能反驳**：三路合并的合成在 runbook/synthesize 脚本层，C campaign 首轮暂以单路运行，是阶段性裁剪。
- **追问**：v2 §3.5 把"三路合并"写成**现役运行方式**（"进化进料三路合并"），而非"待建"；若首轮只有一路，则"败局对照使蒸馏能提取差在哪"这一有效作用在当前系统中不成立，文档应如实标注状态。

### F9 【major】"局级胜负"触发器中"局"与胜负阈值未定义，且当前代码根本不消费胜负信号

- **文档位置**：§3.5（"触发器为局级胜负（won=False / score 低于阈）"）。
- **攻击论点**：§3.5 称触发器已从门控迁移到"局级胜负"，但：(a) C campaign 里"局"是任务还是步？"score 低于阈"的阈值是多少（0.5？pass/fail？）？谁判胜负（lib_grading 的 judge=deepseek-v4-pro 本身是 LLM）？v2 均未给出；(b) 更关键的是，当前代码的触发器实际上是"每日夜间 runbook 全量进化"（`runDailyEvolution` 对所有 session 无差别跑），**没有任何胜负条件分支**——文档宣称的触发器与实现不符。
- **支撑证据**：`scheduler.ts`（每日全量，无胜负条件）；`campaign_metrics.py` 有 score/passed 字段但 `collectTrajectories` 不读。
- **设计方可能反驳**：胜负由 campaign.py 落盘的 score 承载，合成脚本写入 metadata，后续可按胜负过滤。
- **追问**：但 `collectTrajectories` 不读 metadata——信号在合成→管线的交接处断裂。若"局级胜负"从未真正驱动进化，则"学习信号与学生独立性解耦、无论门控是否触发都有进料"这一有效作用名不副实。

### F10 【critical】§3.6 实战归因奖惩整套机制"待建"，v2 却把它写成核心机制的有效作用——学习闭环无结果反馈

- **文档位置**：§3.6（以"运行方式与有效作用"表格陈述"实战归因/对照臂差值校准/最小样本阈值防误杀"）、§5 演进方案 2。
- **攻击论点**：v2 §3.6 用"运行方式与有效作用"的肯定语气陈述归因奖惩，但系统设计文档明确该机制"**待建**（C 后统一修复批次）"。代码里 `times_selected` 列只有 schema 定义、**从未被 UPDATE**，全仓无任何 reward/penalty/加分/降权写入。没有归因奖惩，经验库的排序与淘汰就完全由裁判自评驱动，"高分任务注入卡加分"这一闭环**不存在**——学习信号只进不出，模型的行为结果从未回流到卡片质量。整个"经验学习系统"当前实际是"经验注入系统"，没有学习回路。
- **支撑证据**：`experience-store.ts` `times_selected INTEGER NOT NULL DEFAULT 0`（无 UPDATE）；grep 无归因/加分/降权实现；系统设计文档 §5.6"待建"。
- **设计方可能反驳**：v2 是概要设计（含规划中机制），§5 已把归因列为演进方案 2 并预估 1-2 天工期。
- **追问**：§3.6 措辞是"运行方式与有效作用"而非"待建"，读者会被误导为已实现；且 v2 §1 的核心目标"逐步独立"依赖归因闭环，闭环待建 = 目标当前不可验证。文档应把 §3.6 整体标注为"设计意图（未实现）"。

### F11 【major】credit assignment 未解决：多卡共注入时任务分数归因给全部卡，无边际贡献估计；对照臂校准功效趋零；最小样本阈值无值

- **文档位置**：§3.6（"retrievedIds × 任务分数""最小样本阈值防误杀""对照臂差值校准"）。
- **攻击论点**：单次请求最多注入 8 EVIDENCE + 5 Method + 5 Guard + 10 SKILL + 15 SOP ≈ 43 张卡，任务成败往往由 1-2 张关键卡决定，但"retrievedIds × 任务分数"把整局分数归给**全部**注入卡——经典 credit assignment 问题，且会制造 rich-get-richer：字面匹配所有任务的通用碎片被高频检索、持续得分，与真实效用脱钩。对照臂差值校准在 n=20（重复集）且任务级二元结果下功效趋零，无法估计单卡因果效应；"最小样本阈值防误杀"在原文中即"未给出具体值"——连基本参数都未定。
- **支撑证据**：§3.6 表格"实战归因"行原文；`campaign_metrics.py` 任务级二元口径；§3.6 原文"设最小样本阈值防误杀"无数值。
- **设计方可能反驳**：归因是待建方向，v2 只给方向不给算法。
- **追问**：待建可以，但 v2 把"对照臂差值校准（相关≠因果）"写成已有设计，实际既无算法也无样本支撑；至少应给出 credit assignment 的候选算法与功效分析再宣称可"校准"。

### F12 【major】三层循环论证：裁判自评晋升 → 自评排序注入 →（未来）自评任务分数奖惩，全链无 ground truth

- **文档位置**：§3.3（"quality 当前为裁判自评点估计"）、§3.6、§3.4（Method/Guard 按 quality 排序截断）。
- **攻击论点**：quality（judge vs strawman 的自评）→ 晋升（≥0.5）→ 注入排序（`injection.ts` 按 quality 排序取 top-5/top-10/top-15）→ 未来归因用的"任务分数"也是 judge=deepseek-v4-pro 自评（lib_grading）→ 奖惩再喂回 quality。整条信号链没有任何一处接触真实结果（任务是否完成、交付物是否产出）。裁判的任何系统性偏好（如"偏好多步/有计划轨迹"）会贯穿三层并被放大。唯一的外部信号是 gateway model_runs（升级），但 08-04 A-D3 已明确"门控只测形式、不测任务正确性"。
- **支撑证据**：`verifier.py` 标准分解 + `pipeline.py` vs_reference；`injection.ts` `sort((a,b)=>b.quality-a.quality)`；campaign `lib_grading` judge 配置。
- **设计方可能反驳**：lib_grading 含 automated 自动评分部分（可执行交付物的自动检查），非纯 LLM；升级率是独立于自评的形式信号。
- **追问**：automated 评分覆盖率与"交付物检查"正是 issue-010 的待办项，尚未落地；在它落地前，奖惩闭环（F10 待建）一旦按当前设计实现，就是把自评当真理三次叠加。至少需要声明"quality 与任务分数的来源独立性"作为归因机制的前置条件。

### F13 【critical】active 卡无任何淘汰通道："rescore 降级/降回 dormant"未实现，错误晋升卡永久滞留并构成正反馈放大回路

- **文档位置**：§3.3（"rescore 降级为惩罚"）、系统设计文档 lifecycle 图（"active → rescore 下滑 → 降回 dormant"）。
- **攻击论点**：代码中 `runDormantRescore` 只 `listDormant` 复评；状态迁移函数只有 `promoteToActive`（dormant→active）与 `removeDormantBefore`（dormant→removed），**没有任何 active→dormant 或 active→removed 的 UPDATE**。active 卡一旦晋升即永生：无 TTL、无容量上限（cap 10000 只约束 dormant）。结合 F7（闸门不验成败）与 F8（失败轨迹也能过闸），错误卡（裁判误赞的失败片段）会持续注入 → 制造更多失败 → 失败轨迹再蒸馏 → 裁判再误赞同类卡 → 再晋升，形成无刹车的正反馈。§3.6 的"连续失败任务注入卡降权"正是设计的刹车，但它**待建**（F10）。
- **支撑证据**：`experience-store.ts` 全文件仅三条 status UPDATE（promoteToActive 设 active；removeDormantBefore 两条设 removed，均只作用于 dormant）；`scheduler.ts` 只 `listDormant`。
- **设计方可能反驳**：rescore 降级可通过人工干预/重验处理，roadmap 中有此方向。
- **追问**：v2 §3.3 把"rescore 降级"写成**现役机制**，与实现不符；且 30 天 TTL 只对 dormant 生效，active 无界增长会稀释检索质量。至少需要一条 active 的复评/降级路径，或明确承认当前 active 是不可回收的单行道。

### F14 【major】冷启动 bootstrap 循环依赖：教师只当裁判不当示范者，第一代经验只能从（失败）学生轨迹"提炼成功"

- **文档位置**：§1（"经教师少量指导后逐步独立"）、§3.5。
- **攻击论点**："教师少量指导"在系统中实现为"教师当裁判/蒸馏器（打分）"，而非"教师示范完成任务"。冷启动时经验库为空，学生裸跑大概率全失败（ALFWorld R1 冷库 SR 7.5%），夜间进化只能从这些失败轨迹蒸馏；而提取器 prompt 明确写着 "mining ... from a **successful** agent trajectory"（`EXTRACTION_PROMPT`）——把失败轨迹当成功轨迹提取卡片。即：没有教师成功示范，第一代经验只能从失败中"提炼成功"，来源与标签错配。
- **支撑证据**：`pipeline.py EXTRACTION_PROMPT`（"successful agent trajectory"）；`collectTrajectories` 无胜负；`e5-flywheel` R1 冷库 SR 7.5%。
- **设计方可能反驳**：教师"指导"体现为升级步骤（教师单步输出混入 transcript），且 C 阶段换型 27B 后基线更高、有更多成功局可用。
- **追问**：教师从不整局示范，"少量指导"的形态需澄清；若首轮成功局稀疏（08-03 E5 已记录"成功轨迹仅 10/134 → 无米下锅"），蒸馏输入仍是失败主导，错误晋升风险（F7/F13）在冷启动期最高。

### F15 【major】检索无语义层（bm25+余弦）直接削弱"新任务 <20%"的泛化判据

- **文档位置**：§3.4（"bm25 取 top-24，余弦重排取 top-8，无语义解析层"）。
- **攻击论点**：判据②"新任务升级率 <20%"本质是测**跨任务泛化**——经验必须迁移到措辞不同的新任务上。但检索是纯字面匹配（FTS5 bm25 + 词袋余弦），对措辞差异不敏感（系统设计文档自述"字面匹配对措辞差异不敏感，语义检索是待建能力"）。于是判据②恰恰在系统最弱环节（无语义检索）上设验收：新任务换一种措辞描述同一操作，检索就命中不了相应卡片，泛化必然差。若判据②通过，更可能是"新任务本身够简单、学生裸做也不升级"，而非"经验迁移成功"——这又回到 F2 的无对照问题。
- **支撑证据**：`retrieval.ts`（bm25 + cosineScore 词袋重叠）；系统设计文档 §5.3（"无语义解析，字面匹配对措辞差异不敏感"）。
- **设计方可能反驳**：CJK bigram + 前缀匹配缓解了部分措辞差异；语义检索是演进方向。
- **追问**：在无语义层的前提下，判据②测的是"经验泛化"还是"学生原始泛化能力"？这需要新任务冷库基线才能回答，而该基线不存在（F2）。

### F16 【minor】经验库为空时的行为未在设计中声明；SKILL 管线无 benchmark 恒输出空，"五类卡片"宣称不完整

- **文档位置**：§3.2、§3.4。
- **攻击论点**：(a) 空库时 `retrieve` 返回 `[]`，`buildInjection` 的 blocks 为空 → 无合成消息；无 SKILL/SOP 时 systemPrompt/tools 也不变 → 实验臂与对照臂输出**完全相同**，只能靠 session 字段 `disabled:true` 区分。"热库 vs 冷库"对照在库极小/为空时退化为恒等对照，无法度量"经验从无到有"的增量。(b) 系统设计文档 §4.3 明确"skill_evolution.pipeline（无 --benchmark 输出 []）"，即 C campaign 未配 benchmark，SKILL 目录恒为空——SKILL 注入路径是死代码，"五类卡片"实际退化为 EVIDENCE/Method/Guard/SOP 四类（SOP 还受 F5 契约缺失影响）。
- **支撑证据**：`injection.ts`（blocks 空则无 splice，skills 空则 systemPrompt 不变）；`retrieval.ts`（`if(!ftsQuery) return []`）；系统设计文档 §4.3。
- **设计方可能反驳**：空注入是预期冷启动状态，对照设计本就允许；SKILL 管线在配 benchmark 后即可启用。
- **追问**：文档应声明空库/空注入时的退化行为；"五类卡片"作为核心机制宣称，与实际仅少类生效不符，应如实标注各类型的当前生效状态。

### F17 【major】"晋升阈值 0.5 统一"红线被违反：SOP 以 quality=1 恒晋升、SKILL 以 utility 另尺度晋升

- **文档位置**：§3.3（"晋升统一双阈值 0.5"）、§6 红线 3；`offline/verifier.ts`。
- **攻击论点**：v2 与系统设计文档都宣称"晋升阈值 0.5 统一，新候选与 dormant 复评同一阈值"。但 `sopsToStaged` 把 SOP 的 quality 硬编码为 **1**（"pre-vetted, enter at full quality"），`skillsToStaged` 用 skill_evolution 自己的 `utility` 指标（**另一个尺度**，非 verifier 0-1 偏好概率）作 quality。只有 EVIDENCE/ABILITY 卡走 verifier 的 0.5。三种类型三个晋升标准，红线 3"0.5 统一"名不副实；SOP 恒 quality=1 意味着它永久占据注入排序顶端（F4 的全局 top-N），且绕过了 F7 的空洞闸门。
- **支撑证据**：`verifier.ts sopsToStaged → quality: 1`；`skillsToStaged → quality: skill.utility`；`cardsToStaged → quality: entry.quality`。
- **设计方可能反驳**：SOP 生命周期管线已做 construction→merge→re-execution 预验证，等价于已过闸；SKILL 的 utility 是演化效用，与 verifier 尺度语义不同但都在 [0,1]。
- **追问**：即使语义不同，文档声称的"统一阈值"就是假的；且 SOP 预验证发生在 Python 侧（不可见、无 0.5 校验），quality=1 直接放行，与"晋升唯一通道=双阈值验证"的不变量（系统设计 L3）冲突。

---

## 附：问题聚类（供答辩优先排序）

| 聚类 | Findings | 一句话 |
|---|---|---|
| 指标可信 | F1, F2, F3 | 核心判据口径自相矛盾、无 CI、无法证伪 |
| 验证空洞 | F7, F17 | 0.5 闸门 vs strawman 近乎恒真，且 SOP 绕闸 |
| 学习回路断裂 | F8, F9, F10, F13 | 三路合并/局级触发/归因奖惩均未实现，active 卡无淘汰 |
| 注入可靠性 | F4, F5, F6, F15, F16 | 全局注入稀释、SOP 无执行器、user 角色污染、无语义检索 |
| 冷启动与退化 | F13, F14, F16 | 错误晋升无刹车、教师不示范、空库行为未声明 |
| 归因缺陷 | F11, F12 | credit assignment 未解 + 三层自评循环论证 |
