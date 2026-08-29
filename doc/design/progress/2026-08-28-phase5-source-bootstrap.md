# Phase 5 受限源码级自举 — 进度与交接

状态：进行中  
任务书：[plans/2026-08-28-phase5-source-bootstrap-plan.md](../plans/2026-08-28-phase5-source-bootstrap-plan.md)  
最近更新：2026-08-28T11:32:23+08:00 by Kimi Code CLI

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| P5-1 定义 candidate-extension ABI 与 capability-limited 白名单 | done | Kimi Code CLI | 2026-08-28 | `packages/agent-server/src/evolution/candidate-abi/`，24 项契约测试通过 |
| P5-2 实现源码候选 generator（失败簇 → patch） | done | Kimi Code CLI | 2026-08-28 | `packages/agent-server/src/evolution/source-candidate-generator.ts`，7 项测试通过 |
| P5-3 构建隔离执行 runner（worktree + 容器 + 评估 artifact） | done | Kimi Code CLI | 2026-08-28 | `packages/agent-server/src/evolution/candidate-isolation-runner.ts`，9 项测试通过 |
| P5-4 人工审查门与 promotion 状态机接入 | pending | | | |
| P5-5 Phase 5 end-to-end 集成测试与 canary/rollback 演练 | pending | | | |
| S10 Phase 5 收尾 | pending | | | |

## 2. 交接信息

- **2026-08-28**: 用户批准进入 Phase 5 实施。
- **2026-08-28**: P5-1 产出 ABI v1：
  - 能力白名单：`declarative/tool-prompt`、`declarative/system-guideline`、`declarative/replacement`、`transform/text`、`transform/json`。
  - 默认路径白名单：`.pi/candidate-extensions/`、`packages/coding-agent/src/core/extensions/candidate-policies/`。
  - `source_patch` artifact 布局：blob[0] = unified diff，blob[1] = canonical candidate manifest；`data_class: diagnostic_ops`，`retention_policy_ref: pending_0b`。
  - manifest 校验为 fail-closed，transform capability 必须提供 `entry`。
- **2026-08-28**: 测试基线：候选 ABI 测试 24 passed；`npm run check` 全绿（tsgo、biome、deps、shrinkwrap、browser smoke）。

## 3. 断点恢复指引

如果从零接手：
1. P5-1 已完成，代码在 `packages/agent-server/src/evolution/candidate-abi/`。
2. 下一步启动 P5-4：将候选评估报告接入 promotion 状态机与人工审查门（canary_pending_approval / canary / active_pending_approval / active），消费 archive/detector 信号/teacher correction 生成失败簇并输出 `SourcePatchArtifactInput`。
3. 验证命令：
   ```bash
   cd /Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi
   scripts/with-node25.sh node packages/agent-server/../../node_modules/vitest/dist/cli.js --run packages/agent-server/test/evolution/
   npm run check
   ```
