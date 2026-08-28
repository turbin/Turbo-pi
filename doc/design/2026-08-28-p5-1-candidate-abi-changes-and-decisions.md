# P5-1：candidate-extension ABI 与 capability-limited 白名单 — 变更与决策

## 已完成

- 在 `packages/agent-server/src/evolution/candidate-abi/` 新建 P5-1 模块：
  - `manifest.ts`：candidate-extension manifest schema、能力白名单、fail-closed 校验。
  - `transform.ts`：纯转换函数签名 `transform(input, context) => output`。
  - `whitelist.ts`：默认路径白名单与路径校验。
  - `source-patch-builder.ts`：`source_patch` artifact 构造器（blob[0]=diff，blob[1]=manifest）。
  - `index.ts`：统一导出。
- 新增契约测试 24 项，覆盖 manifest 校验、路径白名单、artifact 构建与 registry 回读。
- 更新 `doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md` 与 `doc/design/INDEX.md`；新增 `doc/design/progress/2026-08-28-phase5-source-bootstrap.md`。
- 通过 `npm run check`（biome、pinned deps、ts imports、shrinkwrap、install-lock、tsgo、browser smoke）。
- 使用 `scripts/with-node25.sh` 通过 candidate-abi 测试（24 passed）。

## 设计决策

1. **ABI 与现有 extension API 不重叠**  
   candidate-extension 是 capability-limited 子集，单独 schema、单独路径、单独加载/执行入口，不继承 `packages/coding-agent/src/core/extensions/` 的 `ExtensionAPI`/`ExtensionContext`。原因：现有 extension 运行在与 pi 同进程且拥有用户权限，直接用于自举风险过高。

2. **v1 能力白名单**  
   首批仅开放：
   - `declarative/tool-prompt`
   - `declarative/system-guideline`
   - `declarative/replacement`
   - `transform/text`
   - `transform/json`
   不开放网络、文件系统写（除 runner 指定输出目录）、子进程、`eval`、动态 import、任意 tool/command 注册。

3. **manifest 校验 fail-closed**  
   未知字段、缺失字段、不支持 capability、声明 transform 但缺少 `entry` 均直接拒绝，避免“宽松解析”导致的能力漂移。

4. **默认路径白名单**  
   候选 source patch 只能创建/修改：
   - `.pi/candidate-extensions/`
   - `packages/coding-agent/src/core/extensions/candidate-policies/`
   禁止触碰 evaluator、held-out manifest、preflight、budget、rollback、M0 冻结面或用户数据。

5. **`source_patch` artifact 布局**  
   - blob[0]：unified diff 文本。
   - blob[1]：candidate manifest 的 canonical JSON。
   - `data_class` 设为 `diagnostic_ops`（内部自举诊断产物，不含用户内容），`retention_policy_ref` 保持 `pending_0b`。

6. **隔离执行与 candidate generator 后置于 P5-2/P5-3**  
   P5-1 只定义契约与校验；执行沙箱、worktree + 容器 runner、失败簇 → patch 生成器在后续任务实现，避免一次提交引入未经验证的运行时能力。

## 遗留/待办

- P5-2：实现失败簇聚合与 `source-candidate-generator`。
- P5-3：实现隔离 runner，加载 candidate transform 并执行于受限上下文。
- P5-4：接入 promotion 状态机与人工审查门。
- P5-5：end-to-end 集成测试与 canary/rollback 演练。
- S10：Phase 5 收尾、决策记录与 INDEX 最终归档。

## 引用

- 计划：`doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- 上游 spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5
- 上游约束：`doc/design/2026-08-27-self-evolving-engineering-design-changes-and-decisions.md` SE-01~SE-28
