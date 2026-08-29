# Phase 5 受限源码级自举 — 完成报告

## 已完成

- P5-1：`candidate-extension` ABI v1 与 capability-limited 白名单。
- P5-2：失败簇聚合 + 源码候选 generator。
- P5-3：隔离执行 runner（worktree diff 应用 + 可插拔 `ExecRunner` + 评估报告）。
- P5-4：人工审查门 + promotion 状态机接入（`CandidatePromoter`）。
- P5-5：端到端集成测试与 canary/rollback 演练。
- S10：决策记录、INDEX 更新、进度文件收口。

新增/修改文件：
- `packages/agent-server/src/evolution/candidate-abi/*`（manifest、transform、whitelist、source-patch-builder、index）
- `packages/agent-server/src/evolution/source-candidate-generator.ts`
- `packages/agent-server/src/evolution/candidate-isolation-runner.ts`
- `packages/agent-server/src/evolution/candidate-promoter.ts`
- `packages/agent-server/test/evolution/candidate-abi/*.test.ts`
- `packages/agent-server/test/evolution/source-candidate-generator.test.ts`
- `packages/agent-server/test/evolution/candidate-isolation-runner.test.ts`
- `packages/agent-server/test/evolution/candidate-promoter.test.ts`
- `packages/agent-server/test/evolution/phase5-integration.test.ts`
- `doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- `doc/design/progress/2026-08-28-phase5-source-bootstrap.md`
- `doc/design/INDEX.md`
- 5 份分任务决策记录 + 本完成报告

## 测试基线

- `packages/agent-server/test/evolution/`：**308 tests passed**（新增 47 项）。
- `npm run check`：biome、pinned deps、ts imports、shrinkwrap、install-lock、tsgo、browser smoke 全绿。
- 使用 `scripts/with-node25.sh` 运行测试（better-sqlite3 兼容 Node 25.9.0）。

## 关键设计决策（最终归档）

1. **candidate-extension ABI 是现有 extension API 的严格子集**  
   原因：现有 extension 运行在与 pi 同进程且拥有用户权限，直接用于自举风险过高。v1 只开放声明式策略和纯转换。

2. **v1 能力白名单**  
   `declarative/tool-prompt`、`declarative/system-guideline`、`declarative/replacement`、`transform/text`、`transform/json`。不开放网络、文件系统写（除 runner 指定输出）、子进程、`eval`、动态 import。

3. **manifest/diff 校验 fail-closed**  
   未知字段、缺失字段、不支持 capability、transform 缺 `entry`、diff 修改现有文件、路径逃逸 一律拒绝。

4. **默认路径白名单**  
   `.pi/candidate-extensions/`、`packages/coding-agent/src/core/extensions/candidate-policies/`。禁止触碰 evaluator、held-out manifest、preflight、budget、rollback、M0 冻结面或用户数据。

5. **source_patch artifact 布局冻结**  
   blob[0] = unified diff，blob[1] = candidate manifest canonical JSON，`data_class: diagnostic_ops`，`retention_policy_ref: pending_0b`。

6. **generator 模型-free**  
   失败簇聚合和策略映射均基于规则，不调用 LLM。原因：先保证闭环 plumbing 正确，再考虑模型生成 patch。

7. **runner 可插拔隔离**  
   默认 `LocalSubprocessRunner` 用于本地/测试；生产可替换为 Docker/gVisor 容器 runner，同一评估逻辑复用。

8. **promotion 复用现有状态机**  
   `CandidatePromoter` 直接复用 `PromotionController` + `CanaryManager`，不引入新状态；审查门在 `requestCanary` 前拦截。

9. **不自动批准、不自动合并**  
   `canary` / `active` 必须经外部显式人工批准触发；系统只输出 review bundle 与评估报告。

## 遗留与后续

- 本次 Phase 5 为源码级自举的首次闭环，候选能力限于声明式策略；后续若需开放 transform 执行，需补充 V8/vm 沙箱与容器 runner。
- TEK IPC 评估签名、Docker/gVisor 容器 runner、真实 worktree 准备（git worktree / 快照）可在后续迭代中接入，不改变当前 ABI 与状态机。
- 所有新增 artifact 的 `data_class` 与 `retention_policy_ref` 保持 `pending_0b`，等待 Phase 0b 最终裁决。

## 引用

- 计划：`doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- 上游 spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5
- 分任务决策记录：
  - `doc/design/2026-08-28-p5-1-candidate-abi-changes-and-decisions.md`
  - `doc/design/2026-08-28-p5-2-source-candidate-generator-changes-and-decisions.md`
  - `doc/design/2026-08-28-p5-3-isolation-runner-changes-and-decisions.md`
  - `doc/design/2026-08-28-p5-4-candidate-promoter-changes-and-decisions.md`
