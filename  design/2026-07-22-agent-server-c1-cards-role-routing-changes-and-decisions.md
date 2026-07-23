# Agent Server C1：cards 按 role 分流存 ABILITY——改动与决策记录

日期：2026-07-22
任务：` design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md` 的 "C1：cards 按 role 分流存 ABILITY" 一节
实现者：子 agent（C1 任务）

## 改动清单

- `packages/agent-server/src/offline/verifier.ts`
  - `cardsToStaged`：`type` 由一律 `"EVIDENCE"` 改为按 `card.role` 分流——`"Method"`/`"Guard"` → `"ABILITY"`，其余（`"Workflow"`、role 缺失、未知值）→ `"EVIDENCE"`；payload 字段（name/trigger/procedure/boundary/role/evidence/taskId/text）与 `sourceEntryId` 映射规则不变。
  - 模块头注释：在晋升门规则列表中补充 Method/Guard 经 cards 五元组进入 ABILITY、Guard 只来自验证通过 cards 的 boundary（维持"无负面经验库"原则）；`cardsToStaged` 的 JSDoc 同步说明分流规则。
- `packages/agent-server/test/offline/verifier.test.ts`
  - 新增 describe "cardsToStaged role routing (C1)"：10 条用例（见下方对应表）。
  - 修正 2 处既有断言（预期破坏，见下）。
- `packages/agent-server/test/offline/scheduler.test.ts`
  - 修正 1 处既有断言（预期破坏，见下）。

## 决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | 分流判断用 `card.role === "Method" \|\| card.role === "Guard"` 的精确等值匹配，其余一律落 EVIDENCE | 任务书要求未知/非法枚举值维持 EVIDENCE 且不抛异常；精确匹配天然覆盖缺失（undefined）、未知值、大小写变体，无需显式白名单校验或默认值分支。 |
| 2 | payload 完全沿用现有 cards 映射（含 `text: trigger+"\n"+procedure` 的 `filter(Boolean).join("\n")` 规则），不随 type 变化 | 任务书明确"payload 保留现有 cards 映射的全部字段，不变"；`buildInjection` 读的是 `payload.role/procedure/boundary`，与 type 无关。 |
| 3 | 不新增常量/辅助函数（如 `ABILITY_ROLES` 集合） | 只有两个字面量，一次三元表达式即可表达；引入抽象是过度设计，与"最小改动"约束一致。 |
| 4 | 沿用 0.5 阈值，Guard 不提阈值 | 任务书决策表第 2 条（暂定沿用 0.5，上线后观察 Guard 误伤再提）。 |
| 5 | 非 number quality（字符串/缺失）按 0 处理、被门槛挡掉，不抛异常 | 沿用现有 `typeof entry.quality === "number"` 守卫语义（任务书用例 8 明确此预期）。 |
| 6 | `card` 缺失/null 的 entry 静默跳过（`continue`） | 沿用现有行为（任务书用例 9 明确此预期）；管线输出的 cards.json 由 Python 侧保证结构，缺失 card 视为空槽而非错误。 |

## 既有断言修正说明（预期破坏）

1. `test/offline/verifier.test.ts` "maps cards.json entries to ..."：fixture card 为 `role:"Method"`，C1 后入库类型由 EVIDENCE 变为 ABILITY。断言由 `type==="EVIDENCE"` 改为 `type==="ABILITY"`，用例名同步更新。其余断言（title/quality/payload.role/payload.taskId）不变。
2. 同文件 "promoteStagedOutputs reads staged ..."：fixture card t-1 为 `role:"Guard"`、quality 0.8，C1 后以 ABILITY 入库。断言由"EVIDENCE 恰 1 条且 title 为 card one"改为"EVIDENCE 0 条、ABILITY 恰 1 条且 title 为 card one"。**晋升总数不变**（仍 3 = skill + sop + 1 card；0.1 分 card 仍被门槛挡掉）。
3. `test/offline/scheduler.test.ts` "runs ETL, pipeline and promotion ..."：STAGED_CARDS 的 t-1 为 `role:"Method"`、quality 0.8，C1 后以 ABILITY 入库。断言由在 EVIDENCE 中查 "isolate before retry" 改为在 ABILITY 中查。**晋升计数不变**：`checkpoint.metric` 与 `snapshot.promoted` 仍为 3，无需修改计数断言——分流只改 type，不改晋升门（阈值、去重、计数）语义。

## 与任务书用例表逐条对应

| 任务书 # | 测试（verifier.test.ts, describe "cardsToStaged role routing (C1)"） | 覆盖点 |
|---|---|---|
| 1 | "routes Method cards to ABILITY with the full tuple payload, promoted active above threshold" | type/payload.role/trigger/procedure/boundary/evidence 逐项相等、taskId、`text === trigger+"\n"+procedure`、verifyAndCanonicalize 后 active |
| 2 | "routes Guard cards to ABILITY and stores them active" | Guard → ABILITY、payload.role、入库 active |
| 3 | "keeps Workflow cards as EVIDENCE even at high quality" | quality 0.9 仍 EVIDENCE（高分不分流边界） |
| 4 | "keeps cards without a role field as EVIDENCE without throwing" | role 缺失 → EVIDENCE、不抛异常 |
| 5 | "keeps cards with an unknown role value as EVIDENCE without throwing" | 非法枚举值 → EVIDENCE、不抛异常 |
| 6 | "promotes a Method card at exactly the threshold as active ABILITY" | quality=0.5 恰好阈值，ABILITY 且晋升 active |
| 7 | "does not promote a Method card just below the threshold" | quality=0.49 不晋升、不入库 |
| 8 | "treats non-number quality as 0: gated out without throwing" | 字符串 quality 与缺失 quality 各一条，均按 0 处理、不晋升、不抛异常 |
| 9 | "skips entries without a card without throwing" | `card` 缺失与 `card: null` 各一条，均跳过、不抛异常 |
| 10 | "routes a mixed batch: exactly 2 ABILITY and 2 EVIDENCE" | Method+Guard+Workflow+无 role 混合数组，ABILITY 恰 2、EVIDENCE 恰 2，顺序断言 |

TDD 流程：先写上述 10 条并跑红（6 条因 type 断言失败而红；用例 3/4/5/9 断言的是维持不变的既有行为，首次即绿，作为防回归护栏），再实现 `cardsToStaged` 分流使全绿。

## 验证结果

- `cd packages/agent-server && node ../../node_modules/vitest/dist/cli.js --run`：20 文件 / 213 测试全部通过（含并行 C2 任务合入后的注入端用例）。
- `npx biome check --write`（仅本任务改动的 3 个文件）：无修复、无诊断。
- 根 `npx tsgo --noEmit`：0 错误。
- 未跑根 `npm run check`（并行任务约束，biome --write 会踩注入相关文件）；biome 已按文件粒度单独验证。

## 环境备注（非本任务改动，供后续任务参考）

本机 Homebrew Node 已升级为 v26.5.0，而 `better-sqlite3@11.10.0` 无法在 Node 26 上编译（V8 `GetPrototype` API 移除），其 prebuild 也无 Node 26 产物。测试需用 Node 25 跑：本次将 Node v25.9.0 解压至 `/tmp/node-v25.9.0-darwin-arm64`（用后应删除），并用该二进制执行 node-gyp 重建了 `node_modules/better-sqlite3` 的 Release binding（module version 141）。`npm rebuild better-sqlite3` 在 Node 26 下会先删除旧 binding 再编译失败，切勿再跑。
