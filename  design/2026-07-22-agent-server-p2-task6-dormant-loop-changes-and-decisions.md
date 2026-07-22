# Agent Server P2 Task 6：dormant ETL 候选完整闭环——变更与决策

日期：2026-07-22
范围：`packages/agent-server/python/verification_selection/pipeline.py`、`src/offline/pipeline.ts`、`src/offline/scheduler.ts`、`src/experience-store.ts`、对应测试
来源：P1 最终评审 Important #2（dormant EVIDENCE 无消费路径、行数无界增长），spec §5.2/§6 Stage 3，见 ` design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` P2 事项 1

## 变更

1. Python `verification_selection.pipeline` 新增 `--rescore` 模式：输入 `[{task, text, content_hash}]`，输出 `[{content_hash, quality}]`；空候选输出 `[]` 退出 0；默认模式不变。
2. TS `runDormantRescore`（offline/pipeline.ts）：复用 runPython/PYTHONPATH/timeout 机制 spawn rescore CLI，返回 contentHash→quality Map，空列表短路。
3. `runDailyEvolution` 新增两个 stage（完整流程：ETL → pipeline → promoteStagedOutputs → **dormant 重评分** → **dormant 清理** → checkpoint）：
   - stage 4：`listDormant("EVIDENCE", rescoreLimit=200)`（最老优先）→ rescore → `verifyAndCanonicalize`（传原有 contentHash，≥0.5 原地晋升，低分/未评分保持 dormant）。
   - stage 5：`removeDormantBefore(cutoff, cap)`：TTL（默认 30 天，`AGENT_SERVER_DORMANT_TTL_DAYS` 可调）先行，cap（默认 10000）兜底删最老。
   - checkpoint metric 改为 `promoted + promotedFromDormant`，snapshot 增加 rescored/promotedFromDormant/removedDormant。
4. `ExperienceStore.removeDormantBefore(cutoffIso, cap?)`：TTL UPDATE + cap 超额删最老；FTS 无需处理（search 已过滤 active，测试证明）。
5. 测试：scheduler（高分晋升/低分留存/snapshot 统计/TTL 清理/无 dormant 时静默跳过）、pipeline（fake spawn 校验 CLI 契约 + 真实 Python MockLLM e2e）、experience-store（TTL/cap/active 不动/removed 不进 FTS）。

## 决策

| 决策 | 理由 |
|---|---|
| rescore 打分通路 = 主管线单轨迹 vs_reference 口径（Verifier.score_pair vs REFERENCE_TRAJECTORY 的 Bradley-Terry 偏好概率） | 与主管线 quality 完全同口径同量纲，0.5 晋升阈值语义一致；不引入新打分框架。 |
| rescore 位于 promoteStagedOutputs 之后、cleanup 之前 | 与另一验证/晋升步骤相邻（同属 spec §6 Stage 3 机制）；行先评分再清理，被 removed 的行不会进 rescore spawn。 |
| ETL 当轮新插入的 dormant 行当轮即可参与 rescore | 无理由延迟一个周期；最坏情况是当轮低分留下轮重试。 |
| 低分行保持 dormant 下轮重试，TTL/cap 兜底清理，而非首次低分即删 | 评分器会随 LLM 配置演进，一次低分不代表永久无价值；TTL+cap 已保证行数有界。 |
| checkpoint metric 改为 promoted + promotedFromDormant | metric 语义是"本轮激活条目数"，dormant 晋升同为激活；snapshot 保留分项可区分来源。 |
| rescore 走与主管线相同的 pythonBin/pythonDir/timeoutMs/spawnFn 注入模式 | 配置一致性 + 测试可注入。 |

## 遗留（转 Task 7）

- 既有 bug（非本次引入）：默认 CLI 真实 LLM 路径 `OpenAICompatClient(role="student")` 传了不存在的 `role` 参数，会 TypeError；rescore 路径已用正确的无参构造。Task 7 一并修复默认 CLI。

## 验证

- agent-server 全套 137 测试通过。
- `npm run check` 干净（根 tsgo --noEmit 通过）。
- Python 真实 CLI smoke（mock LLM）：3 候选得分 good 0.653 > neutral 0.552 > bad 0.435；空输入 → []。
