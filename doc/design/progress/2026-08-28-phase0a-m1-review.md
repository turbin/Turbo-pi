# Phase 0a M1 审查报告

日期：2026-08-28
审查对象：M1 — Artifact/Promotion/Runtime 三条主线可独立跑通
审查人：orchestrator（本 session 自审）
状态：**通过，里程碑可关闭**

## 1. 审查范围

M1 包含任务：
- T3：bundle builder / artifact registry（含 generation-0 构建）
- T5：Promotion Controller 骨架与 deployment_event_stream
- T6a：slot 解析与 resolved manifest 记录
- T7：evidence plane 结构化字段扩展（与 T3 并行，计入 M1 执行）

## 2. 退出条件 checklist

| 检查项 | 状态 | 证据 |
|---|---|---|
| CAS 冲突拒绝 + 冲突事件入库（A6） | 通过 | `registry.test.ts` "refuses CAS conflict" + "records a committed conflict event" |
| gen0 bundle 机械构建并加载成功（A6） | 通过 | `registry.test.ts` "gen0 bundle blobs are deterministic and loadable" + `build-gen0.ts` CLI 可执行 |
| 状态机非法跳转 / 重复 seq / previous_event_id 不匹配拒绝（A8） | 通过 | `promotion.test.ts` 对应用例 |
| slot 派生视图正确、无 status 列（D4） | 通过 | `PromotionController.resolveSlotState` 只查 `deployment_event_stream`；schema 无 status 列 |
| 断号 fail-closed 检出（A8） | 通过 | `promotion.test.ts` "detects seq gap" + `resolver.test.ts` "rejects resolving a slot with a seq gap" |
| resolveSlot 只消费事件流 + 内容寻址 bundle（C7） | 通过 | `runtime-resolver.ts` 不读工作树，只查 DB + `registry.fetchBundle` |
| blob 校验失败拒绝加载（C7） | 通过 | `resolver.test.ts` "rejects loading when blob sha256 does not match" |
| recordResolvedManifest 幂等 + FK 拒绝（C8） | 通过 | `resolver.test.ts` 对应用例 |
| T5 联调完成：artifact 存在性校验走 T3 registry | 通过 | `promotion.test.ts` 通过 registry 预存 artifact 后再 emit event |
| recordEvidence 字段级拒绝 + taxonomy 冻结（T7） | 通过 | `evidence-schema.test.ts` |

## 3. 测试与检查汇总

- evolution 测试：`packages/agent-server/test/evolution/` 6 文件 76 用例全绿。
- TEK 测试：`packages/evaluation-kernel/test/ipc.test.ts` 21/21 绿（M0 结果，M1 未改动）。
- biome：`packages/agent-server/src/evolution`、`packages/agent-server/test/evolution`、`packages/evaluation-kernel` 零告警。
- tsgo：`evolution` / `evaluation-kernel` 零错误；全仓剩余 43 个 `packages/ai/test` 预存在模型 ID 错误，与 Phase 0a 无关。

## 4. 新增/修改文件清单

- `packages/agent-server/src/evolution/artifact-registry.ts`
- `packages/agent-server/src/evolution/bundle-builder.ts`
- `packages/agent-server/src/evolution/fingerprint.ts`
- `packages/agent-server/src/evolution/build-gen0.ts`
- `packages/agent-server/src/evolution/promotion-controller.ts`
- `packages/agent-server/src/evolution/audit-writer.ts`
- `packages/agent-server/src/evolution/runtime-resolver.ts`
- `packages/agent-server/src/evolution/record-resolved.ts`
- `packages/agent-server/src/evolution/evidence-schema.ts`
- `packages/agent-server/src/evolution/taxonomy.ts`
- `packages/agent-server/test/evolution/registry.test.ts`
- `packages/agent-server/test/evolution/promotion.test.ts`
- `packages/agent-server/test/evolution/resolver.test.ts`
- `packages/agent-server/test/evolution/evidence-schema.test.ts`
- `doc/design/progress/2026-08-28-phase0a-progress.md`（状态更新）

## 5. 已知限制与待确认事项

- `ArtifactRegistry.storeArtifactWithId` 仅用于测试/内部 CAS 冲突路径，不暴露给生产调用；生产调用必须走 `storeArtifact` 以确保 artifact_id 由 manifest 计算。
- `build-gen0.ts` 目前不连接真实 TEK（T9 集成验收脚本负责）；它机械构建 bundle 并输出 JSON 报告。
- T7 只冻结字段合同与 taxonomy，未实现真实采集 hook（明确属于 Phase 1）。
- A4 的 OS 身份真实隔离仍只在 CI Linux 容器执行；本地以凭据目录 mode 0700/文件 0600/socket 0600 降级验证。

## 6. 结论

M1 退出条件全部满足，里程碑可关闭。下一步进入 M2：T6b（coding-agent agent-session 在线版本合同注入）。
