# D 阶段后续实验流程对抗审查记录

日期：2026-08-27 ｜ 状态：**5 轮完成，已收敛** ｜ 上限：5 轮

角色：

- Kimi：只读搜索工程目录，补充代码、配置、数据和历史决策证据；不修改文件。
- Codex：对实验可识别性、独立性、统计功效、停止规则和结论边界进行批判审查，并作最终裁决。

审查对象：`plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`

## 轮次记录

| 轮次 | Kimi 工程调查主题 | Codex 对抗问题 | 裁决 | 状态 |
|---|---|---|---|---|
| 1 | harness/工作区/注入路径可实现性 | E0 能否真正隔离重复与臂条件？ | **5 个致命缺口成立；E0 改为先补 harness/参数合同/指纹，再运行** | 完成 |
| 2 | 数据、任务池、泄漏与统计实现 | E1–E4 是否有足够样本并避免旧题污染？ | **接受 runner/统计缺口；驳回“无未见任务”，实测封存 20 个未执行任务** | 完成 |
| 3 | evolution/verifier/卡片 schema | E2/E3 的质量闸能否落到现有代码？ | **接受交付对齐/派生库/剂量缺口；驳回必须先改生产 schema** | 完成 |
| 4 | gate/judge/观测与事故链 | E5、issue-023 和审计证据是否足够？ | **任务级 gate 改为轨迹层 shadow；纠正 judge/cost 两项事实错误** | 完成 |
| 5 | 全方案反例与最小可行路线 | 是否仍有致命混杂或不必要成本？ | **接受 10 项实施阻断并削减无条件实验；驳回两项错误时序建议** | 完成 |

## 最终裁决

**设计通过，真实跑批暂不通过。** 新方案已经消除原草案中最关键的可识别性错误，可以进入 P0 + E0 实施准备；但现有工程尚不具备直接跑 E0/E1 的条件，必须先补独立 workspace、P0–P4 注入探针、arm/block/condition trace、canonical request hash、确认集 denylist、真实 token 计量、统计脚本和 issue-023。

批准边界：本次只完成方案和审查，不授权改代码或启动跑批。下一授权点是 P0 + E0 实施包；E0 验收后再批准 E1。

## 第 1 轮详细裁决

### Kimi 查到的工程事实

1. `rerun_audit.py` 三次重复复用同一目录；`setup_workspace` 仅合并复制，不清理旧产物。
2. 当前请求只支持 `injection: boolean`，没有空内容、中性内容、固定卡片覆盖接口。
3. 即使 experience 检索为空，注入开启仍可能加入 Skill catalog 与 SOP tool schema，不能把它叫作纯 wrapper 臂。
4. campaign 未显式传采样参数；链路只部分转发，`seed/top_p` 缺合同，trace 表也不记录完整参数。
5. 8789 preflight 未强制校验 injection 期望值与快照配置；完整增强 prompt 和检索集合需要跨 session/DB 取证，`run.jsonl` 不自包含。
6. `injected_tokens` 是字符数启发式估计，不能直接用于严格的等剂量匹配。

### Codex 批判与裁决

- **接受**以上六项工程事实；原草案 E0 不具备直接执行条件。
- **不接受**把所有内容覆盖能力继续加入 `rerun_audit.py`。T9-R2 只修独立重复；另建 eval-only 注入探针，降低正式 runner 被实验专用开关污染的风险。
- P1 必须同时关闭 experience、Skill 和 SOP，才能接近纯 wrapper；新增 P2 单测 Skill/SOP 通道。
- 采样参数只记录实际生效值；未支持字段必须先补合同，不允许以默认值猜测。
- `task_00002` 的目标从“必须明确定位”改为“按预注册条件复现并分级归档”，避免不可证伪的硬门。

### 本轮对方案的修改

- E0 由“直接跑探针”改成“先补可观测性与评估 harness，再跑探针”。
- P0–P3 扩为 P0–P4，拆开 wrapper、Skill/SOP、剂量与真实内容。
- 剂量计量改用目标 tokenizer 或真实 prompt token 差，不再依赖 `injected_tokens`。

## 第 2 轮详细裁决

### Kimi 查到的工程事实

1. 现有 runner 只硬编码 x1–x4，没有 P0–P4、D0–D4、S0–S4、多 top-k 或 block-day 合同。
2. 现有统计脚本没有 power、非劣、Holm 或综合 Go/No-Go 实现；`metrics_v2.py` 主要读取 penalized `score`，不能直接承担 E4 的 `score_simple` 主分析。
3. `request_traces` 缺少 arm/block/condition，现有 TreatmentCompliance 以 task_id 粗连接，多臂条件下会混 trace。
4. active 906 卡来源高度集中；按 Kimi 的解析，top 4 来源任务约占 68%，E2 必须按来源和复用权重分层。
5. issue-023 尚未修复，任何依赖 judge 的 E0–E4 都有再次挂起风险。
6. Kimi 判断“QCB 已无完全未见任务”，理由是 79 个 new 被 daily_batch 计划覆盖。

### Codex 批判与裁决

- **接受**1–5：计划必须显式包含 runner、schema、统计和 judge 基础设施实现，不得把设计文本当成已具备能力。
- **驳回**第 6 项。实际 `run.jsonl` 只覆盖 79/99 个 unique task；D2/D7 四臂日没有执行其 new slice，因此有 20 个任务从未运行。任务计划“理论上被分片”不等于实际暴露。
- 原 8 个 held-out 虽未进入 evolution，但已在 D7 x2/x3 执行，不能作为严格首次暴露确认集。
- 两个 block 日重复同一批任务不能把独立任务样本从 20 变成 40；否则是伪重复。样本不足时必须新增任务，而不是重复计数。
- E4 中“最低实用收益”和“非劣界”原表述混杂，已拆成独立参数并要求先做配对功效分析。

### 本轮对方案的修改

- 立即冻结 20 个实际未运行任务，禁止在 E0–E3 中使用。
- issue-023 提升为所有新真实运行（包括 E0）的前置。
- E4 明确独立样本单位为任务；跨日用于复现/日漂移，不增加任务 n。
- TreatmentCompliance 必须能按 arm/block/condition 对账。

## 第 3 轮详细裁决

### Kimi 查到的工程事实

1. 当前 schema 只有 Experience type 与 Method/Guard/Workflow role，没有 E2 的风险类别、标注者或裁决字段。
2. 抽取 prompt 有 `deliverables/trigger/boundary/task_pattern`，但 deliverables 由模型自报；没有官方交付规范 manifest 或任务文件指纹。
3. verifier 默认 criteria 没有独立的交付一致性、跨任务适用性与可执行性维度。
4. v1/v2 没有可复现过滤库 builder；当前只能加载单库或只读 snapshot。
5. top-k、真实 token 剂量、中性 padding、新 wrapper 和多条件 trace 均缺实现。
6. 新卡 promotion threshold 固定 0.5，confidence 默认 0.5；现有归因不能替代五臂学生效用实验。

### Codex 批判与裁决

- **接受**2–6。尤其“卡上有 deliverables”不等于“与官方交付要求一致”；v2 必须以任务/grader 真值为准。
- **部分驳回**第 1 项的工程结论。E2 类别首先是实验标注，不需要立即写进生产数据库；sidecar 更容易版本化、双盲和撤销，也避免 schema 污染。
- v2 派生库必须由 frozen v1 快照自动构建并哈希，不能手工复制后直接改 SQLite。
- E3 原文“固定剂量”与裸 S0 矛盾。裁决为 S1–S4 固定剂量，S0 保持裸基线；产品效应与组件效应分开解释。
- 三教师比较继续后置：先冻结 schema/manifest/质量闸，再比较教师，否则比较的是对旧缺陷的语言拟合能力。

### 本轮对方案的修改

- 新增版本化 sidecar 标注和 `deliverable_manifest`。
- 新增可复现 v2 派生库 builder 契约。
- 明确 S0 不做 padding，S1–S4 才做剂量匹配，并分离两个 estimand。

## 第 4 轮详细裁决

### Kimi 查到的工程事实

1. gateway `quality.py` 明确只处理单请求可观察信号，无法识别跨回合无进展。
2. 当前没有任务级 shadow detector；request trace 也没有回合进展、工具失败和交付物状态。
3. preflight 没有余额探针和 run.jsonl 停滞检查；issue-023 回归测试不存在。
4. gateway 已有出云前 DLP，但没有按 task/run/arm 统计 finding。
5. Kimi 声称 judge retry 代码在仓库外、云升级没有成本字段。

### Codex 批判与裁决

- **接受**1–4。任务级 gate 不应破坏 request-level gateway 的既有合同；先做离线轨迹 detector，在线干预以后落在 agent/harness 层。
- **驳回**第 5 项的两部分：`lib_grading.py` 实际位于工程内的 `eval/qcb/harness-ref/`，只是 `eval/qcb/` 被 gitignore；`model_runs` 已有 `cost_micro_usd`。真正的问题分别是修复不能可靠提交、成本不能按实验归因。
- judge 修复应位于受版本控制的本地 adapter/runner，不只改 gitignored vendored 文件。
- shadow detector 采用 task-level split：D1–D6 开发、D7 验证、E4 前瞻测试；增加“80% 回合预算前及时召回”。
- 未来云介入只发送最小化脱敏状态摘要，不默认发送完整 transcript。

### 本轮对方案的修改

- 明确 E5 的层级、数据切分、及时召回、DLP 和成本归因口径。
- issue-023 实现位置改为 tracked judge adapter/runner。

## 第 5 轮详细裁决

### Kimi 查到的工程事实与反例

1. `rerun_audit.py` 仍复用 workspace，P0–P4 注入覆盖接口也不存在。
2. 当前采样合同、trace 和运行 manifest 不足以证明臂等价；`arm/block/condition` 仍未落盘。
3. issue-023、真实 token 计量、可复现 v2 builder、功效/非劣/Holm 脚本和 task-level shadow detector 均未实现。
4. 20 个确认任务目前只有流程性封存，没有 runner 级技术阻断。
5. 200–500 张起步标注和 E1/E3 全臂无条件执行，成本可能高于获得的信息量。
6. Kimi 建议按最短路径收敛，并提出“只有内容效应为正才做 E2/E3”“E4 后再训练 E5”。

### Codex 批判与裁决

- **接受 1–4**：这些是从设计进入执行前的真实阻断项，但不是继续增加实验文档的理由；统一收敛为 P0 实施包。
- **接受第 5 项**：E2 改为 120 张序贯标注，证据不足才扩至 200/500；E3 是否跑完整五臂由 E1 的预注册分支决定。
- **驳回“只有内容效应为正才做 E2/E3”**。真实内容比等剂量中性内容更差，恰恰是内容治理最强的触发条件；无收益且无伤害时才允许直接 No-Go 并停止探索。
- **驳回“E4 后再训练 E5”**。那会让 E4 失去前瞻测试资格；正确时序是 E5a 用 D1–D7 开发/冻结，E5b 随 E4 只做 shadow 计分。
- E1 原 top-2/top-4/top-8 不能独立分离内容与剂量，改成裸基线加低/高剂量 × 中性/真实内容的 2×2。
- 确认集增加机器 manifest 和 E0–E3 runner denylist；仅靠文档承诺不足以防止误读或误跑。
- P0/P1 等价由 canonical gateway-bound request 的机械相等判定，不用 8–10 题行为差推断统计等价。

### 本轮对方案的修改

- 流程改为 P0 → E0 → E1 → 结果分支 → E5a → E4+E5b，不再无条件串行跑完 E2/E3/E5。
- E1 改为可识别的内容×剂量设计；E2 改为序贯标注；E3 允许按 E1 裁剪。
- E4 冻结共同主效用/主安全指标和检验层级；20 题功效不足时必须补新任务或判证据不足。
- 最终结论收敛为：**方案设计通过；工程实现和真实跑批仍 blocked，等待用户批准 P0 + E0。**
