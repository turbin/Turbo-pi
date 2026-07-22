# Agent Server P2 Task 2：retrieval status 过滤 + content_hash 索引——变更与决策

日期：2026-07-22
范围：`packages/agent-server/src/experience-store.ts`、`packages/agent-server/test/experience-store.test.ts`
来源：P1 最终评审 Important #2（dormant 行污染 FTS 检索候选）+ 低优先级 follow-up（content_hash 无索引），见 ` design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md`

## 变更

1. `ExperienceStore.search` SQL 增加 `AND e.status = 'active'`：FTS 检索只返回 active 行，dormant/removed 行不再挤占 bm25 top-24 候选。
2. schema 增加 `idx_exp_content_hash` 索引：`getByContentHash`（verifier 晋升去重、后续 dormant 重评分）从全表扫描变为索引查询。
3. 新增测试：dormant 行不出现在 FTS search 结果中。

## 决策

| 决策 | 理由 |
|---|---|
| status 过滤下推到 SQL（`search`）而非 TS 侧事后过滤 | bm25 top-24 是限量候选集，事后过滤会让 dormant 行先挤占名额再被丢弃，召回率下降；SQL 过滤保证 top-24 全是可注入的 active 行。 |
| 过滤放在 `ExperienceStore.search` 而非 `retrieve` | search 是唯一的 FTS 入口，单点过滤覆盖所有调用方（当前 retrieve + 未来调用）。`listActive` 已有 status 条件，不受影响。 |
| 索引在本任务提前（原属低优先级 follow-up） | P2 Task 6（dormant 闭环）的晋升去重依赖 `getByContentHash`，dormant 行增长后 O(n) 扫描会成为实测瓶颈；索引创建是幂等 DDL，成本为零。 |
| 索引名 `idx_exp_content_hash` | 沿用既有 `idx_exp_type_status` / `idx_exp_quality` 命名。 |

## 验证

- `test/experience-store.test.ts` + `test/retrieval.test.ts` 通过（13 tests）。
- `npm run check` 干净。
