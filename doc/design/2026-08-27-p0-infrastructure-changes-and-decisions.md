# P0 基础设施实施决策记录

日期：2026-08-27

引用：`plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`、`2026-08-19-run-batch-preflight-checklist.md`、`issue-023`

## 完成内容

本次提交完成 P0 实验基础设施，使 E0（机械臂等价性审计 / T9-R2）可以在不污染确认集、不共享工作区、可追踪臂/条件的前提下启动。

1. **issue-023 judge 适配器（judge_adapter.py）**
   - 401/402/403 账户类错误立即失败；其他瞬时错误 capped 指数退避（封顶 10 min）。
   - 连续失败超过阈值写 sentinel 文件并抛 `JudgeConsecutiveFailureError`。
   - `campaign.py` 在每次 `grade()` 入口调用 `patch_lib_grading()`，覆盖所有评分路径（含 `rerun_audit.py`、`pilot_9b.py` 通过 `safe_grade` 复用）。

2. **独立工作区与残留断言**
   - `campaign.setup_workspace()` 改为：目标目录已存在时直接抛 `FileExistsError`，复制不再使用 `dirs_exist_ok=True`。
   - `rerun_audit.py` 每任务每次重复使用独立 `workspaces/<task-id>/repeat-N/<task-id>` 目录。

3. **确认集 denylist（confirm-task-manifest.json + confirm_tasks.py）**
   - 从 `results/campaign-20260819/run.jsonl` 实测未覆盖的 20 个任务生成 manifest，带任务文件 SHA256。
   - `campaign.py`、`rerun_audit.py`、`pilot_9b.py` 在启动前调用 `assert_no_confirm_tasks()`，命中即失败，防止 E0–E3 污染 E4 确认集。

4. **canonical request hash + arm/condition trace 标记**
   - `campaign.py` 每次请求计算 model/messages/tools/temperature 的规范化 SHA256，写入 `run.jsonl.canonical_request_hashes`。
   - 同一 hash 通过 `extra_body.canonical_request_hash` 透传到 agent-server，写入 `request_traces.canonical_request_hash`。
   - `arm` 与 `condition` 通过 `extra_body` 透传，agent-server 写入 `request_traces.arm/condition`，并加入 session header metadata。
   - agent-server schema 增加 `arm TEXT`、`condition TEXT`、`canonical_request_hash TEXT`，并通过 `ALTER TABLE` 兼容旧库。

5. **测试与 preflight**
   - `test.sh` 自动使用 repo-local Node 25 工具链，解决 Homebrew Node 26 导致 better-sqlite3 绑定失败的问题。
   - 修复 `packages/coding-agent/test/model-runtime-cloudflare-compat.test.ts`（模型目录漂移）与 `packages/coding-agent/test/package-manager.test.ts`（用户 `.agents/skills` 泄漏进测试）。
   - pi-ai 当前仍有 14 个与模型目录漂移相关的预存测试失败，不阻塞 P0/E0；`2026-08-19-run-batch-preflight-checklist.md` G1 已更新说明。

## 决策

### P0-01：judge 修复放在本地 runner 层，不改 vendored QCB 副本

`eval/qcb/` 整体 gitignore，只改 `lib_grading.py` 会在 reference copy 丢失修复。通过 `judge_adapter.patch_lib_grading()` 在运行时 monkey-patch，修复保留在版本控制本地代码中并配回归测试。

### P0-02：workspace 存在性断言而非覆盖

`dirs_exist_ok=True` 在重跑/断点续跑时会把上一次产物合并进新运行，导致臂间污染。改为断言目录不存在；campaign 本身通过 `completed_keys` 断点续跑，不会重复创建。

### P0-03：确认集由实际 run.jsonl 生成，而非任务计划理论分片

计划中的分片不等于实际暴露。使用 `campaign-20260819` 实测覆盖 79/99 任务，剩余 20 任务作为严格确认集；任务文件 SHA256 一并冻结，便于 E4 前校验未被改动。

### P0-04：canonical request hash 排除 runner 归因字段

hash 输入包含 model、messages、tools、temperature，不包含 arm/condition/injection/task_id/domain。这样同一 prompt 在不同臂下 hash 相同，可用于 E0.2 的逐字节等价性比较。

### P0-05：arm/condition 进 request_traces，不进 gateway model_runs

gateway 按合同只看单请求响应，无法承载实验归因。agent-server 的 `request_traces` 已关联 session/task，新增 arm/condition/canonical_request_hash 即可满足 E0–E4 的 treatment-compliance 对账，不需要改 gateway schema。

### P0-06：测试门控按风险域分离

`./test.sh` 继续作为全量门控运行，但 P0 跑批只要求 agent-server/agent-gateway/eval 全绿。pi-ai 的模型目录相关失败是上游目录漂移造成，修复属于独立维护项；开跑前只需确认这些失败没有因 P0 改动而扩大。

## 未完成 / 待用户批准

- E0 实际执行仍需用户逐项通过 `2026-08-19-run-batch-preflight-checklist.md` 七类核验。
- `max_tokens` 是否显式固定及具体值：当前仅显式固定 `temperature=0.0`；`max_tokens` 仍走 provider 默认，需在 E0 采样合同里按支持矩阵标为 unsupported 或补充固定值。
- B7（gateway 云端升级腿配置）是否完全匹配 9B 实验设计，仍需用户确认。
