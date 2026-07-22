# Agent Server C：ABILITY 提炼通路——决策、方案设计与 TODO 任务清单

日期：2026-07-22
状态：**已立项（2026-07-22 用户拍板全部按推荐）**
**元原则（用户指示）：本文件所有决策均为暂定，上线运行一段时间后根据观察数据迭代更新，不作为最终结论。**

## 关键事实（方案的地基）

Python `verification_selection` 管线的 cards 本就是五元组（trigger/procedure/boundary/role），`role ∈ {Method, Guard, Workflow}`（`python/verification_selection/experience.py:29`）。但 TS 晋升层 `cardsToStaged`（`src/offline/verifier.ts:174`）一刀切存为 `type:"EVIDENCE"`，而 `buildInjection`（`src/injection.ts:36-40`）只从 `type:"ABILITY"` 条目读 Method/Guard——**提炼产物在生产，但存错类型，注入器看不见**。C 任务的主体是接通这个错位，不是新建管线。

## 决策记录（2026-07-22 用户拍板）

| # | 决策点 | 决定 | 理由 | 上线后观察项 |
|---|---|---|---|---|
| 1 | 提炼通路 | **C-轻**：promote 阶段按 card.role 分流，Method/Guard → `type:"ABILITY"`，Workflow 暂存 EVIDENCE；不新建 LLM 管线 | cards 已带五元组与 verifier 连续分，零新 LLM 调用即可接通；独立提炼管线与现有能力重叠，等产量/质量数据再评估 | Method/Guard 的每轮产量、质量分布；若产量不足再立项 C-重 |
| 2 | 质量门槛 | Method 与 Guard 均**暂沿用 0.5 阈值**（与 cards 一致） | 与现有晋升语义一致，避免未经验证的差异化；Guard 误伤代价高，但作为暂定值先跑 | Guard 误伤案例（模型被错误约束）；若出现再提 Guard 阈值 |
| 3 | Guard 与"无负面经验库" | **维持 P1 原则**：Guard 只来自验证通过的 cards 的 boundary 字段，不从失败轨迹反推 | 不推翻既有架构原则 | 若 Guard 产量过低，再讨论是否开负面路径（需显式推翻 P1 原则） |
| 4 | 注入端上限 | **加上限**：Method/Guard 各取 quality 最高 5 条 | ABILITY 有持续产出后合成消息会膨胀；十几行的防护 | 截断是否发生（达到上限的频率）、被截掉的是否可惜 |
| 5 | 重复 Method 合并 | **本期不做**，容忍近似重复（content_hash 挡完全相同） | 合并（spec §7 edges）是独立大功能，不掺入本期 | 近似重复 Method 的堆积速度，作为 edges 立项依据 |

## 方案设计

### 数据流（改动后）

```
verification_selection pipeline → cards.json [{taskId, quality, card:{name,trigger,procedure,boundary,role,...}}]
  → cardsToStaged（改动点 1：按 card.role 分流）
      role=Method/Guard → VerifyItem{type:"ABILITY", title: card.name, quality, payload:{...五元组, text: trigger+procedure}}
      role=Workflow/其他 → 维持 type:"EVIDENCE"（现状）
  → verifyAndCanonicalize（不变，≥0.5 晋升 active）
  → buildInjection（改动点 2：Method/Guard 各按 quality 取前 5 条，再拼块）
```

### 改动点

1. `src/offline/verifier.ts` 的 `cardsToStaged`：按 `card.role` 分流 type；ABILITY 条目的 `sourceEntryId`、`text` 字段沿用现有 cards 映射规则。
2. `src/injection.ts` 的 `buildInjection`：active 检索结果中 Method/Guard 分别按 `r.experience.quality` 降序取前 5 条（常量 `METHOD_LIMIT = 5`、`GUARD_LIMIT = 5`，与既有 `SKILL_CATALOG_LIMIT`/`SOP_SCHEMA_LIMIT` 风格一致），超出截断；其余注入逻辑不变。
3. 文档/注释同步：`verifier.ts` 模块注释（"无负面经验库"段）、`injection.ts` 模块注释、spec 相关段落如涉及时更新。

### 明确不做（本期）

- 不从失败轨迹反推 Guard；不实现 edges/合并；不改 verifier 的 0.5 阈值；不动 Python 侧。

---

## TODO 任务清单（可分发给独立 agent 执行）

**通用约束**：完整约束见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，全部适用（改动仅限工程内、omlx 不可动、测试基线 20 文件/194 测试、tabs/行宽 120/erasable TS/无 inline import、每任务 1 提交 ≤3000 行、决策记录落 ` design/`（带前导空格）、提交信息带 conventional 前缀 + COMPLETED/TODO/Refer Spec）。

### C1：cards 按 role 分流存 ABILITY

**预估：~120 行；token ~80k。依赖：无。**

- 背景：上文"关键事实"一节；读 `src/offline/verifier.ts`（重点 `cardsToStaged` 与 `StagedCard` 接口）、`src/offline/verifier.ts` 模块注释、`test/offline/verifier.test.ts`、`src/injection.ts` 的 ABILITY 消费方式（payload.role/procedure/boundary）。
- 要求：
  1. `cardsToStaged` 按 `card.role` 分流：`"Method"`/`"Guard"` → `type:"ABILITY"`（payload 保留五元组 + `text: trigger+procedure`，与现有 cards 映射一致）；其余（含 `"Workflow"`、缺失、未知值）维持 `type:"EVIDENCE"`。
  2. 模块注释更新：说明 Method/Guard 经 cards 五元组进入 ABILITY、仍无负面库。
  3. 测试：Method card → ABILITY 类型且 ≥0.5 晋升 active；Guard card 同理；Workflow/无 role → 仍为 EVIDENCE；<0.5 的 Method card 不晋升（阈值沿用）。同步修正受影响的既有测试断言（scheduler.test.ts 的 STAGED_CARDS 含 `role:"Method"`，晋升计数会变——注意这是预期变化，在决策记录中说明）。
- 验收：全套 vitest 通过 + 根 `npm run check` 干净。

### C2：注入端 Method/Guard 上限

**预估：~40 行；token ~40k。依赖：无（与 C1 文件不重叠，可并行；若并行，C1 先合并以免测试断言互相踩）。**

- 要求：
  1. `src/injection.ts`：`METHOD_LIMIT = 5`、`GUARD_LIMIT = 5` 常量（风格对齐既有 LIMIT 常量）；Method/Guard 收集时按 `r.experience.quality` 降序取前 N 条。
  2. 测试：构造 7 条 Method（不同 quality）→ 只注入前 5 且顺序正确；Guard 同理；不足上限时全量注入。
- 验收：全套 vitest 通过 + 根 `npm run check` 干净。

### C3：live 验证 + 迭代观察基线

**预估：文档为主；token ~80k。依赖：C1、C2 合并后。**

- 要求：
  1. 真实环境跑一次 `runDailyEvolution`（MockLLM + 真实 `var/sessions`，参照 ` design/2026-07-22-agent-server-p2-live-verification.md` 的方法）：确认 cards 中的 Method/Guard 以 `type:"ABILITY"` 入库且 active。
  2. 起 agent-server 发非流式请求（参照 P2 live 验证），确认注入的合成消息包含新产出 ABILITY 的 procedure/boundary，且条数 ≤5。
  3. 产出 live 验证文档 + **迭代观察基线文档**：记录当前 Method/Guard 库存量、质量分布、注入截断发生与否，作为"上线运行一段时间后迭代"的对照基线（元原则要求）。
- 验收：验证文档落 ` design/`；观察基线含可复查的 SQL/命令。

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| C1 cards role 分流 | ~120 | ~80k | 无 |
| C2 注入端上限 | ~40 | ~40k | 无（建议 C1 先合并） |
| C3 live 验证 + 观察基线 | 文档 | ~80k | C1+C2 |
| **合计** | **~160 行 + 文档 / 3 提交** | **~200k** | |

估算口径同 P2/P3。
