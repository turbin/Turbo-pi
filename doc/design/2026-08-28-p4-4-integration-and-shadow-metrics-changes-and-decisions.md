# P4-4 Phase 4 集成测试与 shadow 评估指标 — 决策记录

日期：2026-08-28  
上游计划：`doc/design/plans/2026-08-28-phase4-detector-teacher-plan.md`  
状态：P4-4 完成

## 本次变更

1. 在 `packages/agent-server/src/evolution/evidence-artifact-builder.ts` 中扩展 composite evidence artifact，使其可承载 P4-2 的 frozen shadow task-level detector snapshot：
   - `EvidenceArtifactInput` 新增可选字段 `detectorSnapshot`。
   - evidence payload 与 `manifest.evidence_refs` 中均加入 `detector_signals:${signals.length}`，与 coding-agent 的 `evidence-sink.ts` 保持结构对称。
   - 该字段为可选，不破坏已有 Phase 1/2/3 测试与 artifact 构建。

2. 新建 `packages/agent-server/src/evolution/detector-metrics.ts`：
   - 输入为 `(snapshot, taskFailed, teacherResult?)` 样本列表。
   - 输出 recall、false positive rate、miss rate、escalation cost count、dlp blocked count 及任务计数。
   - DLP 阻塞判定以 `teacherResult.rejected === true` 且 `findings.length > 0` 为准，与 aligner 的 DLP 拒绝语义一致。

3. 新增测试：
   - `packages/agent-server/test/evolution/phase4-integration.test.ts`：端到端模拟本地学生重复工具失败 → detector 触发 `repeatedToolFailure`/`escalationRecommended` → gateway escalation → 云教师纠正 → aligner 判定 outcome 改善且 DLP clean → 生成 `teacher_correction` ref → composite artifact 包含 detector snapshot、tool events、escalation join key、teacher correction ref，并验证可重建与 registry 回读。
   - `packages/agent-server/test/evolution/detector-metrics.test.ts`：覆盖完美分离、漏报、误报、空批次、DLP 阻塞等场景。

## 设计决策

- **D-01 证据构建器对称扩展**：agent-server 的 `evidence-artifact-builder.ts` 之前只支持 `teacherCorrectionRef`，P4-4 把它补齐为同时支持 `detectorSnapshot`，使同一 artifact 能同时收录 detector 信号与 teacher 回流信号。
- **D-02 指标不依赖 detector 自评失败**：`taskFailed` 由调用方（如 grader outcome / replay verdict）提供，避免用 detector 输出作为自身评估真值。
- **D-03 全 faux 数据**：integration test 使用硬编码 tool events、grader outcomes、gateway marker 和 cloud/local run，不访问任何真实模型或 gateway。
- **D-04 不触碰冻结面**：未修改 `agent-loop.ts`、`evaluation-kernel/`、`promotion-controller.ts` 或任何 frozen schema；仅在现有 builder 上追加可选字段。

## 验证结果

- `npx tsgo --noEmit`（repo root）：通过。
- `npm run check`（repo root）：通过（biome、pinned-deps、ts-imports、shrinkwrap、install-lock、tsgo、browser-smoke）。
- `packages/agent-server` 专项测试：
  - `phase4-integration.test.ts`：2/2 通过。
  - `detector-metrics.test.ts`：6/6 通过。
  - `evidence-artifact-builder.test.ts`、`teacher-correction-aligner.test.ts` 回归通过。
  - 全包 `npm test`：73 files / 609 tests 通过（含新增 8 条）。
- `./test.sh`：在 `packages/ai` 的 `test/fireworks-models.test.ts` 出现 1 条与 Fireworks 模型目录相关的既有失败，与本次 P4-4 改动无关；`agent-server` 与 `coding-agent`  suites 均通过。

## 遗留

- P4-4 本身无剩余 TODO；后续 S9（Phase 4 收尾）将统一更新 INDEX、归档决策记录并确认回归测试基线。
