# Task 7: Verifier 与 Canonicalize — 变更与决策记录

日期：2026-07-21
范围：`packages/agent-server/src/offline/verifier.ts`、`src/offline/canonicalize.ts`、`src/experience-store.ts`（+2 个方法）、`test/offline/verifier.test.ts`、`test/experience-store.test.ts`
引用：handoff SPEC.md §4.3/§6、` design/2026-07-19-agent-server-p1-spec.md` §3.1/§4.2/§5.2、` design/2026-07-19-agent-server-p1-plan.md` Task 7

## 背景

离线管线（Task 6 已提交）把三个 vendored Python 包的输出（skills.json / sops.json / cards.json）落到 outputDir。Task 7 负责把这些已打分的条目晋升（promote）进 ExperienceStore 为 active 经验，并做去重。

## 决策记录

### D1：连续分数的算法全部留在 Python，TS 只做阈值门控与入库

SPEC §4.3/§6 的 Verifier（TwoStageScorer、字母刻度期望化连续分、PPT 锦标赛）与 canonicalize（TF-IDF blocking θ=0.82 + 五 rubric LLM 裁决）已经在 vendored `verification_selection.pipeline` 内部执行，cards.json 直接携带 `quality` 连续分。仓库约束明确"不在 TS 重实现 Python 逻辑"。因此 TS 侧 `verifier.ts` 的职责收缩为：阈值过滤（quality ≥ 0.5）、类型/载荷映射、contentHash 去重、写库。理由：避免双实现漂移；Python 侧已有 41 个单测覆盖算法正确性。

### D2：阈值 0.5 取闭区间（quality >= 0.5）

SPEC §4.2 step 4 写"quality ≥ 0.5 才 active"，Python `select_experiences` 用 `q >= score_threshold`。TS 侧对齐为闭区间，`PROMOTION_THRESHOLD = 0.5` 导出为常量。低于阈值的条目直接丢弃（handoff 简化决策：不建 negative experience 库），不写库、不计数。

### D3：三种 staged 输出的 quality 来源分别处理

- cards.json：`quality` 字段 = Python verifier 连续分，直接采用。
- skills.json：无 quality 字段，用 evolution 的 `utility`（val ΔU 打分，SPEC §6 Stage 2a）作为 quality；utility < 0.5 的 skill 同样被门控掉。
- sops.json：无任何分数。SOP 在 Python `SopLifecycle` 内已经过了构造→合并→重执行→阈值剪枝，输出即"active SOP"，属于 pre-vetted。决策：固定 quality = 1.0 入库，理由是其质量门已在管线内完成，TS 侧无信息再打分；排名影响仅为 SOP 内部（`listActive("SOP", 15)`），与 SKILL/EVIDENCE 不混排。SPEC §6 Stage 3 的跨管线 TwoStageScorer 抽检属于后续 Python 侧工作，未在本次接线（见 TODO）。

### D4：经验卡（五元组）映射为 EVIDENCE 类型

ExperienceStore 的 type 枚举为 SKILL | SOP | ABILITY | EVIDENCE，没有 CARD。五元组经验卡（role: Method | Guard | Workflow）在在线注入路径（injection.ts）中就是按 EVIDENCE/Method/Guard 走 user 消息注入，因此落库为 EVIDENCE，role 保留在 payload 里供注入层区分。payload 额外带 `text = trigger + "\n" + procedure`，使 store.insert 的 FTS 索引能检索到卡片内容（与 ETL 候选的 `payload.text` 约定一致）。

### D5：canonicalize 去重策略 = contentHash 三层判定

TS 侧的 canonicalize（`canonicalize.ts`）是确定性的存储门，而非 SPEC 的 LLM 裁决（那在 Python）。`verifyAndCanonicalize` 对每条过阈值候选：

1. 批内去重：同一批次相同 contentHash 只保留第一条（`dedupeCandidates`，first wins）。
2. 库内已有同 hash 行且已 active：跳过（幂等，cron 重跑安全）。
3. 库内已有同 hash 行但为 dormant（ETL 候选）：原地晋升 `promoteToActive(id, quality)`，回写 quality，不产生重复行。

hash 计算：`sha256(canonicalJson({type, title, payload}))`，canonicalJson 递归排序对象 key，保证 key 顺序不影响 hash。理由：入库幂等是 cron 场景的硬需求（ETL 已有同款幂等设计）；用内容 hash 而非 id 是因为不同管线对同一内容会生成不同 id。

### D6：VerifyItem 支持调用方预计算 contentHash

ETL 候选的 contentHash 是 `sha256(text)`（直接对句子文本），与 D5 的 canonical JSON hash 不同 scheme。为支持"复核 ETL dormant 候选并原地晋升"这一 SPEC §6 Stage 3 流程，VerifyItem 允许传入 `contentHash` 覆盖默认计算；调用方知道目标行的 hash scheme 时（如按 ETL 规则重算 sha256(text)）可精确命中。未提供时用 D5 的 canonical hash。

### D7：ExperienceStore 只加两个最小方法

`getByContentHash(hash)` 与 `promoteToActive(id, quality)`。不新增通用 update 方法、不改 schema（content_hash 列已有，查询走主键外的等值查询，数据量为离线批规模，暂不加索引）。FTS 无需更新：dormant 行 insert 时已索引。

### D8：计数语义 = 本次调用变为 active 的条目数

`verifyAndCanonicalize` 返回新插入 + 由 dormant 晋升的条目数；跳过的（重复、已 active、低分）不计。与 plan 接口"returning number of active entries"一致且对运行报告（新增/合并条数）有用。

## 测试

- `test/offline/verifier.test.ts`：12 例——阈值闭区间、批内去重、库内去重、dormant 原地晋升、低分不动 dormant、canonicalize helper 稳定性、三个 mapper、promoteStagedOutputs 端到端（3 晋升 / 1 低分卡被门控）。
- `test/experience-store.test.ts`：+2 例（getByContentHash、promoteToActive）。
- 全量 agent-server 套件 93 例通过；`npm run check` 全绿。

## 遗留 / TODO

- SPEC §6 Stage 3 的跨管线 TwoStageScorer 抽检（reasoning_cache 复用）仍是 Python 侧能力，端到端未接线；当前 dormant ETL 候选只有在其内容被管线输出覆盖（hash 命中）时才会晋升。
- SOP 的 quality=1.0 是占位语义，待 Stage 3 抽检接线后应回写真实分数。
- checkpoint 写入与回滚（SPEC §6 Stage 5 后半）属于后续任务。
