# P5-2：源码候选 generator（失败簇 → patch）— 变更与决策

## 已完成

- 新增 `packages/agent-server/src/evolution/source-candidate-generator.ts`：
  - `discoverFailureClusters(registry, options)`：扫描 `composite` evidence artifact，按 `(category, detector_signal, toolName, error)` 聚类。
  - `generateSourceCandidate(input)`：选择最大失败簇，生成 capability-limited candidate extension manifest + unified diff，并存为 `source_patch` artifact。
- 新增 `packages/agent-server/test/evolution/source-candidate-generator.test.ts`（7 项测试），覆盖聚类、阈值、类别过滤、自动/手动簇选择、lineage 记录、无簇情况。
- 更新 `doc/design/progress/2026-08-28-phase5-source-bootstrap.md` 与 `doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`。
- `packages/agent-server/test/evolution/` 全量 292 tests passed；`npm run check` 全绿。

## 设计决策

1. **聚类维度**  
   使用 `failure-classifier.ts` 输出的 taxonomy category 加上 detector snapshot 的 `signal.name`，并以首个带 `error` 的 tool event 的 `toolName`/`error` 作为子维度。原因：直接复用已有分类器和 P4-2 detector 信号，无需新增启发式；同时保留足够粒度区分“read_file 反复失败”和“write_file 反复失败”。

2. **候选生成不调用模型**  
   generator 完全基于规则模板，不调用 LLM、不使用 API key。原因：P5-2 的核心是闭环 plumbing，模型生成 patch 的可靠性尚未在隔离 runner 中验证；先确保失败簇到可审计 artifact 的链路正确。

3. **信号 → 策略的硬编码映射**  
   - `repeatedToolFailure` + `toolName` → `declarative/tool-prompt`：提醒重试前检查参数与 cwd。
   - `deliveryMissing` → `declarative/system-guideline`：要求交付具体产物。
   - `progressStalled` → `declarative/system-guideline`：重复无进展时请求澄清。
   - `escalationRecommended` → `declarative/system-guideline`：本地信号弱时走 gateway 并保留 join key。
   - 其他 → 通用 `declarative/system-guideline`。
   原因：v1 ABI 只支持这些声明式能力；映射是显式的、可审计的，不是让模型自由决定。

4. **Diff 只创建新文件**  
   生成的 unified diff 仅向 `.pi/candidate-extensions/<clusterId>/policy.json` 添加文件，不修改现有源码。原因：与 P5-1 白名单一致，保持变更面最小、可回滚。

5. **自动选择最大簇，但允许调用方覆盖**  
   `generateSourceCandidate` 默认选择样本数最多的簇；也可通过 `input.cluster` 传入预选择簇。原因：方便测试和人工指定；后续 P5-4 人工门可基于 generator 输出做选择。

6. **Lineage 记录**  
   对每个 `parentIds` 用 operator `draft` 记录 lineage edge，diffSummary 包含 cluster 标识。原因：与现有 scaffold/experience candidate generator 保持一致，支持谱系审计。

## 遗留/待办

- P5-3：隔离 runner（worktree + 容器 + TEK IPC 评估）。
- P5-4：人工审查门与 promotion 状态机接入。
- P5-5：end-to-end 集成测试与 canary/rollback 演练。
- S10：Phase 5 收尾、决策记录与 INDEX 最终归档。

## 引用

- 计划：`doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- P5-1 ABI：`doc/design/2026-08-28-p5-1-candidate-abi-changes-and-decisions.md`
- 上游 spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5
