# P5-3：隔离执行 runner（worktree + 评估报告）— 变更与决策

## 已完成

- 新增 `packages/agent-server/src/evolution/candidate-isolation-runner.ts`：
  - `applySourcePatch(worktreeRoot, diffText, whitelist)`：仅支持 v1 新增文件的 unified diff；拒绝修改/删除现有文件、拒绝白名单外路径。
  - `evaluateCandidate(input)`：从 registry 加载 `source_patch` artifact，校验 candidate manifest，在隔离 worktree 应用 diff，运行验证命令，返回 `CandidateEvaluationReport`。
  - `LocalSubprocessRunner`：`ExecRunner` 的默认本地子进程实现，带 timeout、stdout/stderr 捕获。
  - `CandidateIsolationError`：统一错误类型。
- 新增 `packages/agent-server/test/evolution/candidate-isolation-runner.test.ts`（9 项测试），覆盖成功/失败评估、白名单拒绝、现有文件修改拒绝、LocalSubprocessRunner。
- 更新 `doc/design/progress/2026-08-28-phase5-source-bootstrap.md` 与 `doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`。
- `packages/agent-server/test/evolution/` 全量 301 tests passed；`npm run check` 待执行。

## 设计决策

1. **runner 只负责评估，不晋升**  
   `evaluateCandidate` 返回报告对象，不写入 promotion 状态机、不 commit/push。原因：晋升是独立的人工门控步骤（P5-4），runner 保持纯函数式边界。

2. **v1 diff 仅允许新增文件**  
   `applySourcePatch` 只接受 `--- /dev/null ... +++ <path>` 形式的 hunk，其他形式（上下文行、删除行、已有文件修改）一律抛错。原因：与 P5-1 白名单和 P5-2 生成器对齐，确保候选不会悄然修改现有源码。

3. **路径白名单在写文件前校验**  
   所有 `+++` 路径在 `mkdirSync`/`writeFileSync` 之前先经过 `validateCandidatePath`。原因：fail-closed，避免 diff 中嵌套 `../` 或绝对路径逃逸。

4. **ExecRunner 可插拔**  
   提供 `ExecRunner` 接口，默认 `LocalSubprocessRunner` 用于本地/测试；生产可替换为 Docker/gVisor 容器 runner。原因：测试环境不一定有 Docker；把容器策略抽象到接口后，同一套评估逻辑可在不同隔离级别复用。

5. **worktree 由调用方提供**  
   `evaluateCandidate` 不创建/复制 repo，只使用传入的 `worktreeRoot`。原因：worktree 准备（git worktree、容器 volume mount、源码快照）属于部署细节，保持 runner 可测试且与具体 VCS 解耦。

6. **评估报告结构**  
   报告包含 `sourcePatchArtifactId`、`worktreeRoot`、`candidateManifest`、`appliedFiles`、`validationCommand`、`validationResult`、`passed`。原因：信息完整、可审计、可直接作为 P5-4 promotion 决策的输入。

## 遗留/待办

- P5-4：人工审查门与 promotion 状态机接入。
- P5-5：end-to-end 集成测试与 canary/rollback 演练。
- S10：Phase 5 收尾、决策记录与 INDEX 最终归档。

## 引用

- 计划：`doc/design/plans/2026-08-28-phase5-source-bootstrap-plan.md`
- P5-1 ABI：`doc/design/2026-08-28-p5-1-candidate-abi-changes-and-decisions.md`
- P5-2 generator：`doc/design/2026-08-28-p5-2-source-candidate-generator-changes-and-decisions.md`
- 上游 spec：`doc/design/plans/2026-08-27-self-evolving-engineering-design-plan.md` §11 Phase 5
