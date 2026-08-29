# P5-4：人工审查门与 promotion 状态机接入 — 变更与决策

## 已完成

- 新增 `packages/agent-server/src/evolution/candidate-promoter.ts`：
  - `CandidatePromoter`：包装现有 `PromotionController` + `CanaryManager`，提供 candidate 专用的 `shadow` / `requestCanary` / `approveCanary` / `requestActive` / `approveActive` / `reject` / `quarantine` / `rollback` 方法。
  - `assertCandidateReviewable`：fail-closed 审查门，只有 `passed: true` 且确实应用了文件的候选才能进入 `canary_pending_approval`。
  - `buildReviewBundle`：从 registry 读取 source_patch artifact 与 evaluation report，生成人类可读的审查包（diff、manifest、验证结果）。
- 新增 `packages/agent-server/test/evolution/candidate-promoter.test.ts`（5 项测试），覆盖完整 promotion 路径、审查门拒绝失败候选、reject、rollback、review bundle 构建。
- 更新 `doc/design/progress/2026-08-28-phase5-source-bootstrap.md` 与 `doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`。
- `packages/agent-server/test/evolution/` 全量 306 tests passed。

## 设计决策

1. **复用现有 promotion 状态机，不新增状态**  
   `CandidatePromoter` 直接复用 `PromotionController` 与 `CanaryManager`，不引入新的 event type 或 slot 语义。原因：保持状态机单一 canonical；candidate 与普通 artifact 走同一套审计链。

2. **审查门在 `requestCanary` 前拦截**  
   `requestCanary` 必须先传入 `CandidateEvaluationReport`，且报告必须 `passed` 且 `appliedFiles.length > 0`。原因：把“技术预审”与“人工批准”解耦；系统保证只有验证通过的候选才呈现在人类面前。

3. **人工身份记录在 `operator` 字段**  
   所有 promotion 事件的 `operator` 要求传入非空字符串（生成器/审查者/批准者身份）。原因：append-only 审计需要明确责任人。

4. **不自动批准、不自动合并**  
   `approveCanary` / `approveActive` 必须由外部调用方（人类或等价授权流程）显式触发。原因：符合 Phase 5 计划“不自动 commit/push/active”约束。

5. **Review bundle 只读聚合**  
   `buildReviewBundle` 从 registry 聚合 diff、manifest、验证输出，不写入新 artifact。原因：审查视图是派生只读数据，不应改变 artifact 或事件流。

## 遗留/待办

- P5-5：end-to-end 集成测试与 canary/rollback 演练。
- S10：Phase 5 收尾、决策记录与 INDEX 最终归档。

## 引用

- 计划：`doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- P5-3 runner：`doc/design/2026-08-28-p5-3-isolation-runner-changes-and-decisions.md`
- 上游 spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5
