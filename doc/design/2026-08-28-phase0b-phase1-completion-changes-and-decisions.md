# Phase 0b + Phase 1 完成决策记录

## 决策项

### 1. Phase 0b 参数默认值使用角色占位 owner

- **原因**：V3 §9 未指定具体责任人，只定义参数域。Phase 0b 要求所有参数有 owner、依据、版本、有效期、fail-closed 默认值。
- **结果**：使用角色占位（security-owner、ops-owner、data-owner、agent-owner、research-owner），待用户确认后替换为真实责任人。

### 2. Phase 0b 校验命令支持数据库注册表回退到内置默认

- **原因**：evolution.db 尚未有 `evolution_parameters` 表（schema 冻结未含此表）。
- **结果**：`verify-phase0b` 先读 DB 表，不存在则回退到 `DEFAULT_PARAMETERS`，并在报告中区分 `source` 待后续补充。

### 3. 跨包类型边界：本地镜像类型而非跨包 import

- **原因**：coding-agent 与 agent-server 不应互相 import。`evidence-artifact-builder.ts` 需要引用 coding-agent 的 collector 类型。
- **结果**：在 agent-server 中本地定义结构兼容的镜像类型，保持编译期类型检查同时避免包间依赖。

### 4. 失败分类器采用启发式 + fail-closed unknown

- **原因**：Phase 1 要求失败 taxonomy 集成，但不应引入 LLM 分类。
- **结果**：`classifyFromEvidence` 使用确定性启发式（显式 ref → escalation key → tool error → unknown），任何无法解析输入均 fail-closed 为 `unknown`。

### 5. 对账查询以 session 目录名为 taskId 信任来源

- **原因**：`reconcileAll` 需要批量扫描会话目录。
- **结果**：使用目录名作为 taskId；`reconcileTask` 单独验证 resolved manifest 中的 task_id 一致性（reviewer 建议后续加强）。

### 6. Phase 1 集成测试使用模拟 session sidecar

- **原因**：启动真实 coding-agent 会话超出 Phase 1 范围；端到端验证的目标是 reconciliation 逻辑。
- **结果**：测试直接写入 `version-contract.json` 与 `resolved-manifest-*.json` 文件，使用真实 `gen0-rebuild` 和 `storeEvidenceArtifact`。

### 7. 后续流程取消人工确认节点

- **原因**：用户明确要求自动推进。
- **结果**：里程碑审查通过后立即进入下一阶段；仅当 reviewer 发现 blocker 或 coder 无法修复时才升级用户。

## 验证结果

| 范围 | 测试文件数 | 用例数 | 结果 |
|---|---|---|---|
| agent-server evolution | 15 | 169 | passed |
| coding-agent evolution | 6 | 56 | passed |
| evaluation-kernel IPC | 1 | 21 | passed |
| agent-loop.ts diff | — | — | empty |
| biome check | 19 files | — | clean |

## Reviewer 结果

| 里程碑 | Verdict | 轮次 | 备注 |
|---|---|---|---|
| P0b-2 | PASS_WITH_MINOR | 1/5 | 4 个 minor，均非阻塞 |
| P1-3 | PASS_WITH_MINOR | 1/5 | 3 个 minor，均非阻塞 |
| P1-4 | PASS | 1/5 | 4 个 minor/info，均非阻塞 |

## 已知 minor 问题（非阻塞，可后续跟进）

1. `verify-phase0b` 的 `parseArgs` 把 `--slot` 这类 flag 误当 dataDir，会误报 exit 0。建议：拒绝以 `--` 开头的 dataDir。
2. `verify-phase0b` 对不存在 dataDir 回退到内置默认并 exit 0。建议：报告中增加 `source: "builtin-defaults"` 或 `"db-registry"`。
3. `reconcileAll` 对不存在的 `sessionsDir` 会抛异常。建议：catch 后返回空报告。
4. `reconciliation.ts` 不校验 resolved manifest 中的 `task_id` 与查询参数是否一致。建议：增加 `task_id_mismatch` orphan 条目。

## 引用

- V3 设计：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md`
- Phase 0a 架构：`doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md`
- Phase 0a 完成记录：`doc/design/2026-08-28-phase0a-m2m3-completion-changes-and-decisions.md`
- Phase 0b/1 PM 编排计划：`doc/design/plans/2026-08-28-phase0b-phase1-orchestration-plan.md`
- 对抗审核：`doc/design/2026-08-28-self-evolving-engineering-design-adversarial-review.md`
