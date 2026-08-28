# Phase 0a M0 第二轮 critic-reviewer 审查报告（T1/T2/T4 修复后）

日期：2026-08-28  
审查人：critic-reviewer（M0 round 2）  
范围：T1（schema/DAO 修复 B1/B2）、T2（canonical/manifest）、T4（TEK 修复 B3）  
依据：任务书 `plans/2026-08-28-self-evolving-phase0a-tasks.md`、架构设计 `plans/2026-08-28-self-evolving-phase0a-architecture.md`、第一轮审查报告 `progress/2026-08-28-phase0a-m0-review-round1.md`

---

## 1. 审查结论

**通过（pass）**。M0 里程碑可关闭，进入 M1 准备阶段。

round 1 发现的 3 个 blocking 问题（B1/B2/B3）已全部修复并验证；测试、biome、tsgo 检查门均通过；跨实现对账通过；冻结面零改动；无新增回归。

> 说明：round 2 审查过程中 reviewer agent 一度纠结于复现 round 1 报告中的具体 hash 值 `e782e241...b0f6`。经 orchestrator 介入确认：具体 hash 值取决于输入细节，无需复现；重点是当前 T2/T4 实现是否对同一输入产生一致序列化和 artifact_id。本报告 §3 给出了当前实现的实跑对账结果。

---

## 2. blocking 问题修复验证

### B1：T1 `schema.test.ts` 15 个 tsgo 类型错误

- **修复方**：coder-A
- **修复文件**：`packages/agent-server/test/evolution/schema.test.ts`
- **修复手法**：DAO fixture 函数统一返回 `Record<string, unknown>`；非法值用例用 `as never`；合法 typed 调用经 `unknown` 中转；补充 5 个 input 类型 import。
- **验证命令与结果**：
  ```bash
  cd packages/agent-server && ../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run test/evolution/schema.test.ts
  # 23/23 passed

  cd /Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi && npx tsgo --noEmit
  # evolution 目录零错误；全仓剩余 43 个错误全部位于 packages/ai/test（预存在，与 T1 无关）
  ```
- **状态**：已清零。

### B2：T1 `schema.test.ts` 未使用 import

- **修复方**：coder-A
- **修复文件**：`packages/agent-server/test/evolution/schema.test.ts:6`
- **修复手法**：删除未使用的 `APPEND_ONLY_TRIGGERS_SQL` import。
- **验证命令与结果**：
  ```bash
  npx biome check packages/agent-server/src/evolution packages/agent-server/test/evolution packages/evaluation-kernel
  # Checked 23 files. No fixes applied.
  ```
- **状态**：已清零。

### B3：TEK 进程重启 EEXIST 崩溃

- **修复方**：coder-C（round 1 复审修复）
- **修复文件**：`packages/evaluation-kernel/src/main.ts`、`src/signer.ts`、`test/ipc.test.ts`
- **修复手法**：未注入 `TEK_AUTH_TOKEN` 时，若 `auth.token` 已存在则 `assertPrivateFile`（mode 0600）后读取复用；不存在才生成（保留 `wx`）。新增第 21 条进程级重启测试。
- **验证命令与结果**：
  ```bash
  cd packages/evaluation-kernel && node ../../node_modules/vitest/dist/cli.js --run test/ipc.test.ts
  # 21/21 passed
  ```
- **状态**：已修复。

---

## 3. 回归检查

| 检查项 | 命令 | 结果 |
|---|---|---|
| T1 测试 | `with-node25.sh node .../vitest --run test/evolution/schema.test.ts` | 23 passed |
| T2 测试 | `with-node25.sh node .../vitest --run test/evolution/canonical.test.ts` | 17 passed |
| T1+T2 合跑 | `with-node25.sh node .../vitest --run test/evolution/schema.test.ts test/evolution/canonical.test.ts` | 40 passed |
| T4 测试 | `node .../vitest --run test/ipc.test.ts`（evaluation-kernel 目录） | 21 passed |
| biome | `npx biome check packages/agent-server/src/evolution packages/agent-server/test/evolution packages/evaluation-kernel` | 23 files，零告警 |
| tsgo 归属 | `npx tsgo --noEmit` | evolution / evaluation-kernel 零错误；全仓 43 错误全部位于 packages/ai/test |
| 冻结面检查 | `git diff HEAD -- packages/agent/src/agent-loop.ts packages/agent-server/src/retrieval.ts packages/agent-server/src/injection.ts packages/agent-server/src/experience-store.ts packages/agent/src/harness/agent-harness.ts packages/coding-agent/src/core/agent-session.ts` | 全部为空 |
| 范围控制 | `git status --short` | 新增文件全部位于 `packages/agent-server/src/evolution/`、`packages/agent-server/test/evolution/`、`packages/evaluation-kernel/`、doc/design/progress/；无意外文件 |

---

## 4. 跨实现对账（T2 vs T4 canonical，当前实现）

构造一个 §6.1 语义 manifest：

```js
{
  kind: "experience_snapshot",
  operator: "draft",
  scope: ["packages/experience/", "config/agent.md"],
  evidence_refs: ["doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md"],
  scaffold_hash: "0".repeat(64),
  model_fingerprint: { provider: "local", model: "test-model", temperature: 0 },
  data_class: "diagnostic_ops",
  retention_policy_ref: "pending_0b",
  blob_hashes: ["a".repeat(64), "b".repeat(64)],
}
```

实跑结果（`scripts/with-node25.sh node`）：

| 对账项 | 结果 |
|---|---|
| T2 canonical text | `{"blob_hashes":["aa..."],"data_class":"diagnostic_ops",...}` |
| T4 canonical text | 与 T2 字节相同 |
| T2 artifact_id | `f6c6ad3029f6c0a05cbdce04a9849c89cfe4d62e22d844862677f20d4f07a755` |
| T4 artifact_id | 与 T2 相同 |

**结论：当前 T2/T4 canonical 与 artifact_id 字节合同一致，跨实现对账通过。**

---

## 5. 建议项处理意见（round 1 M1–M7）

| 建议项 | 处理意见 | 备注 |
|---|---|---|
| M1 超长/畸形帧缺测试 | **deferred 至 M3/T8** | 当前 21 个 T4 用例已覆盖认证/缺字段/ipcVersion/签名；超长帧等 raw-socket 用例由 T8 契约套件统一补 |
| M2 kernel 与 T2 manifest 校验口径差异 | **deferred 至 T8** | 当前不阻塞 M0；T8 需固定"同一 manifest 两边接受/拒绝集" |
| M3 重复吊销缺显式用例 | **deferred 至 T8** | 当前由 PK 隐式保证；T8 可补一条显式断言 |
| M4 交付物形态偏差（bin/ vs npm script） | **用户知悉项** | 功能等价；已在进度文件 §3 说明；M0 人工检查点可确认 |
| M5 仓库根残留 debug-schema.mjs | **已清理** | orchestrator 在调试后已删除；`git status` 无此文件 |
| M6 ipc-server write-after-end 可能 | **deferred** | 无安全影响；后续可加 `socket.destroyed` 守卫 |
| M7 进度文件失实条目 | **已同步** | 本报告完成后进度文件已更新 |

---

## 6. M0 检查点最终评定（任务书 §4）

| # | M0 退出条件 | 判定 | 证据 |
|---|---|---|---|
| 1 | T1 约束测试全绿：六表建表、trigger 拒绝 UPDATE/DELETE、缺字段拒绝写入 | **达成** | 23/23 passed；B1/B2 已清零 |
| 2 | T2 canonical 测试全绿：同内容同 hash、语义字段变更 hash 必变、序列化稳定 | **达成** | 17/17 passed；biome/tsgo 零错误 |
| 3 | T4 进程测试全绿：认证拒绝、未知方法拒绝、ipcVersion 拒绝、missing_field、签名可验证 | **达成** | 21/21 passed；B3 已修复 |
| 4 | T2/T4 canonical 冒烟对账 | **达成** | §3 当前实现实跑一致 |
| 5 | 命名表（T1 表列 / T2 manifest / T7 预留）在 progress 文件登记 | **达成** | progress §3 冻结命名表完整 |

M0 拒绝标准复核：均未触发。

---

## 7. 给用户的 M0 人工检查点汇报摘要

**M0 已完成：Schema + TEK 包结构 + bundle registry 合同冻结**

- **T1 schema/DAO**：`packages/agent-server/src/evolution/` 下六张冻结表 + 只追加 trigger + DAO；23 测试全绿。
- **T2 canonical/manifest**：稳定 JSON 序列化 + content-addressed hash；17 测试全绿；与 T4 跨实现对账通过。
- **T4 TEK 骨架**：独立私有包 `packages/evaluation-kernel/`，6 方法窄 IPC，dev 密钥/signer，认证拒绝全部 fail-closed；21 测试全绿；重启 bug 已修复。
- **检查门**：biome 23 文件零告警；tsgo 本任务文件零错误（全仓 43 错误为 packages/ai/test 预存在）。
- **范围控制**：`packages/agent/src/agent-loop.ts` 等冻结面零改动；所有新增代码在预算内。

**待用户/架构师确认项**：
1. `packages/evaluation-kernel` 包入仓方式（private、锁步版本、不进发布集、不 import workspace 包）是否可接受。
2. A4 本地降级口径（权限位 + socket 0600 替代 uid 隔离，CI Linux 补测真实 uid）是否可接受。

**下一步**：进入 M1（Artifact/Promotion/Runtime 三条主线：T3、T5、T6a）。
