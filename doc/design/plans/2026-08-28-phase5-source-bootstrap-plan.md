# Phase 5 实施计划：受限源码级自举

日期：2026-08-28  
状态：已获 Go Gate 批准，P5-4 已完成，P5-5 待启动  
上游约束：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5

## 1. 目标

在不改变“不微调”约束、不自动写入主分支的前提下，完成一次真实的“失败簇 → 源码候选 → 隔离验证 → 批准或拒绝裁决”闭环。首批源码候选仅限于 capability-limited candidate extension ABI 内的声明式策略与纯转换，不开放现有 `.pi/skills`、`.pi/extensions` 任意代码。

## 2. 进入门控（Go/No-Go）

Phase 5 启动前必须满足：

- Phase 2–4 达到预注册的效用、安全、成本、统计功效与尾部上界稳定门。
- TEK、rollback、confirmation 集无阻断问题。
- 发布周期数仅作观察窗口，不替代量化门。
- 用户明确批准本计划并授权进入实施。

## 3. 范围

### 3.1 在范围内

- 新建 `candidate-extension` ABI：声明式策略文件（如 JSON/YAML schema）和纯转换函数（无网络、无文件系统写、无 exec）。
- 失败簇 → candidate generator：从 archive / detector 信号 / teacher correction 中提取重复失败模式，生成候选 patch。
- 隔离执行环境：每候选独立 worktree + 容器，完整评估 artifact。
- 人工审查门：diff 审查、人工 canary、人工 merge；系统仅输出 patch 与评估报告，不自动 commit/push。
- 声明的 model/domain scope 验证：候选只能在白名单模型/域上运行。
- 将源码候选接入现有 promotion 状态机：shadow → canary_pending_approval → canary → active_pending_approval → active，与 Phase 3 scaffold 状态机一致。

### 3.2 不在范围内

- 不修改模型权重，不建设 RL/SFT 集群。
- 不自动合并主分支、自动 push、自动发布或自动修改线上数据库。
- 不开放现有 `.pi/skills`、`.pi/extensions` 任意代码修改。
- 候选不得修改 evaluator、held-out manifest、preflight、DLP、预算器和回滚器。

## 4. 任务拆分

| 编号 | 任务 | 预计工期 | 依赖 | 验收点 |
|---|---|---|---|---|
| P5-1 | 定义 `candidate-extension` ABI 与 capability-limited 白名单 | 1–2 天 | Phase 3/4 状态机、scaffold config | ✅ ABI schema 与示例通过契约测试 |
| P5-2 | 实现源码候选 generator（失败簇 → patch） | 2–3 天 | P5-1、archive、detector metrics | ✅ 对模拟失败簇生成可审计 patch |
| P5-3 | 构建隔离执行 runner（worktree + 容器 + 评估 artifact） | 2–3 天 | P5-1、TEK IPC、bundle-builder | ✅ runner 可加载候选并输出完整评估报告 |
| P5-4 | 人工审查门与 promotion 状态机接入 | 1–2 天 | P5-3、promotion-controller | ✅ 候选只能经人工批准进入 canary/active |
| P5-5 | Phase 5 end-to-end 集成测试与 canary/rollback 演练 | 2–3 天 | P5-1~P5-4 | 完整闭环：失败簇 → 候选 → 隔离验证 → 批准/拒绝 → 人工 canary → rollback |
| S10 | Phase 5 收尾：决策记录、INDEX 更新、基线归档 | 0.5 天 | P5-5 | 文档与测试归档 |

## 5. 关键设计决策

### 5.1 candidate-extension ABI

- 格式：声明式 JSON/YAML + 可选纯转换函数（TypeScript，单文件，无顶层 await，无 import 运行时模块）。
- capability 白名单：只读访问自身目录、标准输入输出、受限 console；禁止网络、文件系统写（除指定输出目录）、子进程、eval、动态 import。
- 转换函数签名固定：`transform(input: unknown, context: CandidateContext) => unknown`。

### 5.2 隔离执行

- 每候选独立 git worktree，初始树与父版本一致；不一致时拒绝开始。
- 容器化运行，与 host 共享只读源码 mount，输出目录单独 volume。
- 评估核（TEK）通过窄 IPC 验证 bundle、签名 attestation、确认 denylist。

### 5.3 人工门控

- 系统输出：patch diff、评估 artifact、metrics、 detector 信号、成本。
- 人工操作：review → approve canary → canary → approve active → active。
- 拒绝候选：保留为 `rejected` artifact，不删除原始内容以便审计。

### 5.4 数据分级

- 新增 artifact 继续使用 `data_class: "pending_0b"` / `retention_policy_ref: "pending_0b"`，等待 Phase 0b 裁决。

## 6. 风险与约束

- **M0 冻结**：不得修改 `packages/agent/src/agent-loop.ts`、`packages/evaluation-kernel/`、`packages/agent-server/src/evolution/promotion-controller.ts`、`bundle-builder.ts`、`artifact-registry.ts` 等；候选 generator 和 runner 作为新模块存在。
- **TEK 边界**：所有 attestation/bundle/verify 调用通过 `packages/evaluation-kernel/src/ipc/contract.ts` 窄 IPC。
- **append-only**：已有 manifest/artifact 不可修改，新候选以新 artifact 追加。
- **未授权不干预**：候选在人工批准前不得改变 active 版本、用户输出或线上数据。
- **确认集隔离**：held-out manifest 与 grader 不得被候选或 generator 访问/修改。

## 7. 变更登记

本计划创建/修订时同步更新 `doc/design/INDEX.md`。
