# Phase 2 完成决策记录

## 决策项

### 1. T22/T24 快照格式并存，T25 解析器兼容两者

- **原因**：T22 与 T24 由不同 coder 并行开发，blob 结构略有差异（T22 为 `{entry_count, source_db_sha, entries}`，T24 为 `{format, entries}`）。
- **结果**：`replay-validator.ts` 统一解析两种格式；后续阶段可收敛为单一格式。

### 2. 候选生成器使用确定性 mock 而非真实 LLM 管线

- **原因**：Phase 2 目标是验证 artifact/lineage/promotion 管道，而非真实 LLM 质量。
- **结果**：draft/improve/consolidate 使用确定性规则（去重、重排、合并），保证测试可复现。

### 3. shadow 晋升与 measurement gate 分离

- **原因**：T26 与 T27 并行开发，promoter 不直接调用 gate。
- **结果**：round 2 已在 `promoteToShadow` 增加 candidateId 绑定检查；gate 调用仍由上层组合。

### 4. lineage edge 时间戳参与 edgeId

- **原因**：需要唯一性，允许同一 (parent, child, operator) 多次生成。
- **结果**：edgeId = sha256(parentId + childId + operator + createdAt)，重复生成产生不同 edgeId。

### 5. data_class 统一为 `user_content`

- **原因**：reviewer round 1 发现 snapshot builder 与 candidate generator 不一致。
- **结果**：round 2 修复 candidate-generator.ts 为 `user_content`。

## 验证结果

| 范围 | 测试文件数 | 用例数 | 结果 |
|---|---|---|---|
| agent-server evolution | 22 | 221 | passed |
| coding-agent evolution | 6 | 56 | passed |
| evaluation-kernel IPC | 1 | 21 | passed |
| agent-loop.ts diff | — | — | empty |
| biome check | — | — | clean |

## Reviewer 结果

| 里程碑 | Verdict | 轮次 | 关键发现 |
|---|---|---|---|
| P2-1/P2-2 | PASS_WITH_MINOR | 1/5 | data_class 不一致（round 2 已修复） |
| P2-3/P2-4 | PASS_WITH_MINOR | 1/5 | promoter 未绑定 candidateId（round 2 已修复） |
| P2-5 | PASS_WITH_MINOR | 1/5 | untrusted 路径测试可加强（非阻塞） |

## 引用

- V3 设计：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 2
- Phase 2 编排计划：`doc/design/plans/2026-08-28-phase2-orchestration-plan.md`
- 对抗审核：`doc/design/2026-08-28-self-evolving-engineering-design-adversarial-review.md`
