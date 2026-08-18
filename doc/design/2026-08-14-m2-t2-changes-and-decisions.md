# M2（T2）开发决策记录：F1 卡片交付物维度（issue-010 主体）

日期：2026-08-14
状态：**已实施，测试全绿（TS 295 + Python 57 + eval 54）**
依据：`plans/2026-08-14-post-c-unified-fix-batch-plan.md` v5（§2 F1，落点已按对抗审查 F-4/F-5 修正）；`plans/2026-08-14-fix-batch-dev-tasks.md`（T2 行、§2 TDD 协议、§4 环境约束）；`doc/issues-snapshot/issue-010-card-guided-execution-crowds-out-deliverable.md`

## 1. TDD 过程记录（先红后绿）

### TS 侧（`test/regressions/issue-010-card-deliverable-gate.test.ts`，11 例）

先写断言后实现，首跑 8 红 3 绿（红因：cardsToStaged 不映射 deliverables、无闸门）：

1. **cardsToStaged 映射交付物**（红因：payload 无 deliverables 键）
2. **Method 卡缺 deliverables → 不晋升**（红因：旧代码照常映射）
3. **Method 卡空数组 / 非数组 / 含空串项 → 不晋升**
4. **Guard 卡缺 deliverables → 不晋升**
5. **闸门拦截后 verifyAndCanonicalize 零晋升**
6. **SOP/SKILL 无交付物概念照常晋升**（豁免路径）
7. **Workflow 卡（EVIDENCE）缺 deliverables 照常晋升**（豁免路径）
8. **raw EVIDENCE 照常晋升**（豁免路径）
9. **promoteStagedOutputs 集成：cards.json 旧模板 Method 卡被拦、新模板 Guard 卡晋升**

实现后全绿；随后更新既有旧契约测试（`test/offline/verifier.test.ts` 8 处 + `test/offline/scheduler.test.ts` 1 处 fixtures 补 deliverables——旧契约"无交付物 Method 卡可晋升"正是 issue-010 要修的缺陷，fixture 更新即契约更新）。

### Python 侧（`python/tests/test_issue010_deliverable_check.py` 12 例 + `test_issue010_restill.py` 4 例）

首跑 2 收集期 ImportError（`deliverables`/`restill` 模块不存在）全红：

1. CARD_SCHEMA required 含 deliverables；空数组 / 空串项 / 非字符串项拒绝
2. ExperienceCard 严格校验路径（from_dict strict / validate_strict）拒绝缺 deliverables 卡；to_dict 往返保留
3. EXTRACTION_PROMPT 含交付物提取要求（模板回归哨兵）
4. **打分封顶哨兵**：无交付轨迹 verifier 高分（0.672）仍被封顶 0.49、accepted=False
5. **阈值无关性**：score_threshold 下调到 0.2 仍不放行（物理拦截语义）
6. 有交付轨迹不受影响（保持原始分、过闸）
7. PPT 组按条封顶（组内一条封顶不影响另一条）
8. select_experiences 对封顶轨迹给"交付检查"跳过原因、不抽卡
9. **豁免路径**：--rescore（dormant EVIDENCE 通道）无交付文本不封顶（质量保持 0.672）
10. restill 冒烟：源定位（trace_span_ref 去歧义）/ 有交付源重蒸成功含 deliverables / 无交付源 rejected_no_deliverable / 断点 resume 幂等（journal 不翻倍、产物逐位一致）/ 缺源与 EVIDENCE 豁免路径

既有 M1 测试影响：`make_trajs()`（两文件）好轨迹补 bash 写文件标记——否则交付检查把全部轨迹封顶，`test_score_threshold_not_part_of_hash` 的 `any(accepted)` 断言必红；CLI e2e 也会退化为空 cards 的空断言。坏轨迹（"Guess the answer directly..."、task-a 首条分析式轨迹）**保持无交付标记**——在新语义下它们本就该被封顶，测试顺带覆盖该路径。

## 2. 设计决策（每条附理由）

### T2-1 deliverables schema 三处落点（审查 F-4/F-5 修正版，勿改回 skill_evolution）

- `python/verification_selection/pipeline.py` EXTRACTION_PROMPT：显式要求提取"任务最终必须产出什么"（文件/产物/状态，非空字符串列表），自检加"最后一步 procedure 必须产出 deliverables（任务在交付物存在前不算完成）"；
- `python/verification_selection/experience.py` CARD_SCHEMA：required 增加 `deliverables`，properties 定义为 `{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}`；校验器补 `minItems` 关键字（stdlib 子集，`items` 原本已支持）；
- `src/offline/verifier.ts` cardsToStaged：payload 映射携带 `deliverables`。

理由：Method 卡提取在 verification_selection（对抗审查 F-4 修正落点），不在 skill_evolution；三处分别覆盖"模板产字段 / schema 强制字段 / 存储映射字段"，缺一处链条即断。

### T2-2 deliverables 形态 = 非空字符串数组

理由：比单字符串更结构化——TS 侧可做"非空数组"的确定性校验（`Array.isArray && length>0 && 每项非空字符串`）；未来注入渲染（Method 块附交付清单）可逐条呈现。空数组与缺失同义（无交付物维度），均拒绝。

### T2-3 交付检查双闸：Python 打分侧物理拦截 + TS 闸门二次校验

- **Python 打分侧**（`score_trajectories_with_checkpoint`）：轨迹无交付物产出 → quality 封顶 `DELIVERY_CAP_QUALITY = 0.49`（严格低于 0.5 晋升阈值），且 `accepted` 强制 False——**下调 score_threshold 也无法放行**（物理拦截，阈值与拦截正交，测试 5 断言）。封顶在断点复用路径同样执行（幂等）。
- **TS 闸门**（`cardsToStaged`）：Method/Guard（ABILITY）卡 deliverables 缺失/空/畸形 → 不晋升（防御：手写 cards.json、旧管线产物、管线 bug 的兜底）。

理由：Python 侧持有完整轨迹（检测依据），TS 侧持有最终存储契约（非空校验）——两层各自独立可测；单层会留盲区（旧产物直喂 store、或检测器被绕过）。

### T2-4 豁免边界（写死进决策记录）

- **SOP**：quality=1 预验证通道（sops.json 经 SOP 生命周期管线预筛），不动；
- **SKILL**：utility 分通道（skills.json），不动；
- **EVIDENCE**：无交付物概念，不动——含两条路径：a) ETL 直插 EVIDENCE（不经本管线）；b) `--rescore` dormant EVIDENCE 重打分（`_rescore_cli` 不打交付检查）；
- **Workflow 卡**：Python 侧封顶对所有角色生效（角色由 LLM 在抽取时决定，打分时不可知）；TS 侧 Workflow→EVIDENCE 豁免非空校验（与 EVIDENCE 同类处理）。

理由：issue-010 机制是"照 Method 卡执行挤占交付"，SOP/SKILL/EVIDENCE 是独立通道或独立概念；Python 侧角色不可知故全角色封顶，代价是"无交付轨迹也不出 Workflow/Guard 卡"——保守方向（此类轨迹教的流程本就缺交付 grounding），TS 侧按角色精确豁免。

### T2-5 交付检测器 = 保守启发式（确定性、零 LLM）

`has_deliverable(trajectory_text)` 四组 marker：a) bash 命令行写文件操作（`>`/`>>`/`tee`/heredoc → 带扩展名工作区文件）；b) 交付声明（"written/wrote/saved ... to `path.ext`"）；c) "Files Created" 类总结；d) "output written to"。**C 语料实证**（208 session 全量）：高分（≥0.5）轨迹 4/98 无 marker 被保守误封顶（task_00017 API 执行、task_00043 内联摘要、task_00067 SPARQL 内联、task_00066 边缘分——非文件型交付任务）；issue-010 靶例 task_00091 D3/D4/D5（score 0.0）全部正确判无交付、D1/D2/D6（高分）正确判有交付。

理由：物理拦截语义要求确定性、零 LLM 调用（额外 LLM 判断 = 又一次"自评通过≠行为效用"）；检测器误判方向安全（误杀新卡产出，不放过已入库坏卡——坏卡淘汰由重蒸 + 双闸完成）。非文件型交付任务的误封顶代价小（该类任务恰是交付物模糊、issue-010 警示的类别）。

### T2-6 DELIVERY_CAP_VERSION 纳入打分指纹

`prompt_fingerprint` 增 `extra` 参数（默认 ""，向后兼容既有调用），`_prompt_fingerprint` 传 `DELIVERY_CAP_VERSION="v1"`——检测器/封顶语义变化时递增版本，既有 ScoreJournal 缓存全部失效重打。

理由：封顶是打分产物的一部分；journal 存的是封顶后的 quality，若检测器变化而不失效缓存，resume 会复用旧语义产物（脏复用）。M1 指纹设计（T1-2）已确立"打分参数任一变化即全量失效"原则，本版本号是该原则的扩展。

### T2-7 存量卡重蒸脚本 `restill.py`（只交付脚本 + 冒烟，不执行全量重蒸）

- 输入：active 卡导出（store 行格式，backup/c-campaign-20260814/cards/active-cards.json）+ sessions-dir（eval/sessions-synth）；
- 范围：仅 ABILITY（Method/Guard）卡（C 库 83 条；EVIDENCE 837 条豁免）；按 payload.evidence.task_id 定位源 session，多日/多臂同名文件用 `trace_span_ref` 前缀匹配去歧义（实测 83/83 源全部定位成功）；
- 流程：还原轨迹（与 TS collectTrajectories 同语义）→ 断点重打分（复用 `score_trajectories_with_checkpoint` + ScoreJournal，`--run-dir` resume 幂等）→ 交付检查（无交付源 rejected_no_deliverable）→ 新模板重蒸馏（rejected_extract_failed 兜底 SchemaError）；
- 输出：与主管线 cards.json 同构的 staged 输出（直喂 TS cardsToStaged）+ 逐卡 report（old_id → 新卡/淘汰原因）；
- **不执行全量重蒸**：排期属实验阶段，需用户确认时机（任务书明确）。

理由：否决 LLM 批量补字段（方案 §2-3 定案：回填无验证通道、质量不可控）；重蒸即旧卡自然淘汰通道——"分析完整但无交付"源的旧卡重蒸后被交付检查拒绝，无需手工甄别；断点复用 M1 模块避免重复造轮子。

### T2-8 冒烟实测（mock LLM，真实 C 库导出）

83 ABILITY 卡 → 41 restilled（全含非空 deliverables）、6 rejected_no_deliverable（含 task_00067/00066/00021/00077 等无写文件标记源）、36 rejected_low_quality（mock 关键词打分伪低分——真实 LLM verifier 分数分布不同，非脚本缺陷）、0 缺源；50 个打分组落盘，resume 二次运行零追加、产物逐位一致。

### T2-9 注入渲染不消费 deliverables（明确不做，留待后续批次）

buildInjection 的 Method 块仍只渲染 procedure 文本。理由：方案 §2 F1 改动点清单不含注入渲染（schema 三处 + 检查两处 + 重蒸）；渲染格式（是否附"交付清单"小节、对 prompt 长度与行为的影响）需要独立测量，列入后续批次（F2 前后）评估。交付保证现阶段靠：新卡 procedure 含交付步骤（prompt 自检）+ 无交付卡无法入库 + 存量坏卡重蒸淘汰。

## 3. 边界与遗留风险

1. **存量 83 条 ABILITY 卡仍 active**：重蒸排期未定，旧卡（无 deliverables）在重蒸完成前继续被检索注入——修复对新卡生效、对存量卡是渐进替换。TS 闸门不拦已入库行（`verifyAndCanonicalize` 对既有 active 行按 contentHash 跳过）。
2. **检测器误封顶非文件型交付任务**（实测 4/98 高分轨迹）：该类任务不再产出新卡（安全方向）；如需覆盖（内联答案/API 执行型交付）需扩展 marker 并重测误报率，列入后续。
3. **检测器是"交付证据"而非"交付证明"**：声明类 marker（"written it to ..."）可被模型声称未写而绕过——启发式边界，重蒸 + 双闸是主防线。
4. **重蒸 extraction 阶段不在断点范围**（沿用 M1 决策 T1-5：打分最贵阶段优先）：重蒸中断会重跑抽取（分数复用）。
5. **mock 冒烟中 rejected_low_quality 占比高**（36/83）：mock 关键词打分与真实 verifier 分布不同，真实重蒸的淘汰分布需按实际 LLM 重跑后评估。
6. **`check:pinned-deps` 失败 pre-existing**（eval/results 下 campaign 工件），与 M1 同口径，本次不修；`npm run check` 其余阶段（biome/ts-imports/shrinkwrap/install-lock/tsgo/browser-smoke）全过。

## 4. 测试与检查结果

- TS：`packages/agent-server` 全包 **295 通过**（32 文件；含新增 issue-010 主回归 11 例；verifier.test.ts 26 例与 scheduler.test.ts 契约更新后全绿）；Node 25 经 `scripts/with-node25.sh`。
- Python：`python/tests/` **57 通过**（含新增 issue-010 交付检查 12 例 + restill 冒烟 4 例；M1 断点测试 9 例轨迹补交付标记后全绿）；eval `tests/` **54 通过**（未受影响）。
- `npx tsgo --noEmit` 0 错误；biome 0 问题（1 条 pre-existing info：web-monitor.test.ts:107，非本次文件）；ts-imports/shrinkwrap/install-lock/browser-smoke 全过。
- 唯一 check 失败项：`check:pinned-deps`（pre-existing，见 §3-6）。
- 冒烟：`python -m verification_selection.restill` 对真实 C 库导出（83 ABILITY 卡）mock 全链路通过，resume 幂等（§2-8）。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§2 F1）；plans/2026-08-14-fix-batch-dev-tasks.md（T2）；doc/issues-snapshot/issue-010-card-guided-execution-crowds-out-deliverable.md；doc/design/2026-08-14-m1-t0-t1-changes-and-decisions.md（T1-2/T1-5 先例）
