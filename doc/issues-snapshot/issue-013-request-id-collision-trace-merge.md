# issue-013: requestId 碰撞致 request_traces 跨日静默合并（C 库 D2-D7 检索记录全失）

- 状态：fixed（2026-08-14 F0 批次实施完成，待观察；closed 判定需一个发布周期无复发）
- 报告：2026-08-14（对抗式审查 round-1 F-1，审查员与答辩方双侧独立复核一致）
- 影响面：`packages/agent-server` request_traces 表及派生看板（hit-rate `/api/stats/hit-rate`、stats 页）；凡依赖 request_traces 的归因分析

## 现象

C 终态库 request_traces 共 860 行，ts 全部 ∈ {2026-08-09(491), 2026-08-10(369)}，D2-D7（08-11~08-13）零行；hit=1 仅 4 行；request_id 860 distinct 且为 req-10..req-z 单计数器序列。D3/D6 归档 session 的 requestId 与库中既有行全部重叠（抽 20 个 id 全命中）。

## 根因

requestId 取自 Fastify 每进程 base-36 计数器（`src/server.ts:165` `String(request.id)`），实例重启即重置、8789/8790 双实例同日各自从 1 起；`recordRequestTrace` 为两阶段 upsert，`ON CONFLICT(request_id) DO UPDATE` 只更新 completion 字段（finish_reason/tokens/latency/error），ts/retrieved_ids/hit 永久保留首写值（`src/experience-store.ts:386-397`）——跨日/跨实例请求被静默合并成一行，检索记录永久丢失。

## 边界声明（防过度回溯）

C 判据结论不受污染：升级率口径为 gateway model_runs 全量 + x-gateway 标记（红线 6），+10.3pp 归因用 run.jsonl 臂×日分数，D3 注入审查用 session tar——三者均不经 request_traces。受污染面仅限 request_traces 表本身及其派生看板，F0 修复前此类数据标记不可信。

## 修复（F0 批次，统一修改方案 §1）

1. requestId 改 randomUUID；2. 落实际注入集（injected_ids）；3. task_id 透传（harness→session 头→request_traces）；4. 既有数据处置声明；5. `/api/stream` 路径处置（当前不写 trace，纳入落库或显式豁免，实施时定案写决策记录）。

## 回归测试

`packages/agent-server/test/regressions/issue-013-request-id-collision.test.ts`（7 例，先红后绿，2026-08-14 F0 实施落地）：requestId 唯一性/非计数器序列、两阶段 upsert 不覆盖 retrieved/injected 字段、同 id 冲突阶段一字段保持首写（合并哨兵）、真实链路 injected_ids ⊆ retrieved_ids、task_id 透传（session 头 + trace 行，可空）、/api/stream 纳入 trace 落库、旧库迁移补列。实现与决策详见 `doc/design/2026-08-14-m1-t0-t1-changes-and-decisions.md`。

Refer：doc/design/reviews/2026-08-14-fix-batch-adversarial/round-1.md F-1；doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md §1；doc/design/2026-08-14-m1-t0-t1-changes-and-decisions.md
