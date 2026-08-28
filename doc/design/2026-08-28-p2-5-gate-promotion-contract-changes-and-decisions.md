# P2-5 review round 2：gate-to-promotion 契约固化 — 变更与决策

日期：2026-08-28
范围：`packages/agent-server`（evolution 模块）
Refer Spec：`doc/design/plans/2026-08-28-phase2-orchestration-plan.md`（T26/T27/T28）；T27 目标「不信任测量时拒绝进入 shadow」

## 问题

P2-5 round 2 review：`phase2-integration.test.ts` 第三条用例（untrusted measurement path）只断言 `gateShadowPromotion(staleReplay) === false` 与 `countSlotEvents(SHADOW_SLOT) === 0`，从未真正调用 `promoteToShadow`——gate 的阻断力没有在真实晋升入口上被验证。

## 决策

1. **在 `promoteToShadow` 入口强制执行 T27 gate**（`src/evolution/shadow-promoter.ts`）。
   理由：仅改测试无法让断言成立——原实现只检查 verdict 与 candidateId，stale pass 会真的晋升。T27 的任务目标就是「不信任测量时拒绝进入 shadow」，gate 必须焊在晋升入口而非只靠调用方自觉（fail closed，A8）。gate 判定使用 `gateShadowPromotion(replayResult, replayResult.baselineId, candidateId)`；`baselineId === null` 的 replay 无法核验，同样 fail closed。原 verdict!=="pass" 检查被 gate 子句涵盖，删除；并发的 candidateId 一致性检查保留（显式快速失败）。
2. **集成测试第三条用例补真实调用**（`test/evolution/phase2-integration.test.ts`）。
   在 gate 断言之后，直接用 staleReplay 调 `promoteToShadow`，断言 `promoted === false`、`eventId === null`，随后再断言 shadow slot 零事件。正向 contrast（fresh replay 过 gate）保持原样，不新增晋升调用以避免引入全局 seq 编排噪音。
3. **T26 单测 helper 升级为「可信测量」**（`test/evolution/shadow-promoter.test.ts`）。
   理由：promoter 现在过 gate，原 helper 的 null metrics（E0 缺测量）与 2023 固定时间戳（E1 stale）会让所有 pass 用例被 gate 阻断。helper 改为完整 SnapshotMetrics + 实时时间戳，让单测聚焦 verdict 维度；reject/inconclusive/mismatch 用例行为不变。
4. **新增单测钉住入口级 gate 阻断**：pass verdict + stale 时间戳 → `promoted: false`、无事件。
   理由：行为变更必须有单元级回归钉，不能只靠集成测试。

## 验证

- `test/evolution/phase2-integration.test.ts`：3/3 绿（node25 + vitest）。
- 全量 `test/evolution/`：22 文件 223 用例全绿。
- `npx biome check` 三个改动文件：clean。
- `npx tsgo --noEmit`：agent-server 零错误（packages/ai 的 model-catalog 报错为并行的其他会话在制工作，与本改动无关）。

## 备注

- 本文件按惯例应随 commit 登记 `doc/design/INDEX.md`；本次未 commit（未获指示），INDEX 登记留给汇总提交。
