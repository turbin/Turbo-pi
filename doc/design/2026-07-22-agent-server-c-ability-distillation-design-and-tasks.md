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

### 已知限制（评审确认，列入观察项）

- **type 变更产生并存行**：`contentHashFor` 的哈希输入含 `type`（`src/offline/canonicalize.ts:38`）。同一 card 在 C1 前以 `EVIDENCE` 入库、C1 后以 `ABILITY` 再晋升时哈希不同，`verifyAndCanonicalize` 的去重查不到旧行，会插入新 ABILITY 行而旧 EVIDENCE 行继续 active。结果：同一内容的 EVIDENCE（进证据池）与 ABILITY（进 Method/Guard 注入）并存。评估为无害冗余（证据池多一份文本、注入端多一份能力，各有上限保护），本期接受，不做迁移清理；C3 观察基线须统计并存行数量，作为后续是否立项清理的依据。

---

## TODO 任务清单（可分发给独立 agent 执行）

**通用约束**：完整约束见 `doc/design/2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，全部适用（改动仅限工程内、omlx 不可动、测试基线 20 文件/194 测试、tabs/行宽 120/erasable TS/无 inline import、每任务 1 提交 ≤3000 行、决策记录落 `doc/design/`（带前导空格）、提交信息带 conventional 前缀 + COMPLETED/TODO/Refer Spec）。

**测试要求（强制执行，2026-07-22 用户拍板补充，canonical 在工程根 `CLAUDE.md` 的 "Testing requirements" 一节）**：

1. **TDD 流程**：先写失败测试（红）→ 最小实现使其通过（绿）→ 重构。测试与实现必须在同一提交内，不允许只有实现没有测试的提交。
2. **全部 unit test 必须全绿**：包级 vitest 全量 + 根 `npm run check` 干净。禁止用 `.skip`、放宽既有断言等方式凑绿；既有断言确需修改的，必须在决策记录中说明理由。
3. **接口参数边界严格覆盖**：空/缺失/undefined 输入、阈值边界（恰好等于 vs 恰好低于 cutoff）、上限 off-by-one（恰好 N 条 vs N+1 条）、未知/非法枚举值，每项都必须有对应用例。
4. **异常设计与覆盖**：对非法输入定义显式行为（抛出 / 跳过 / 默认值），每条路径都要有测试覆盖；不允许静默吞掉，除非决策记录说明理由。
5. 验收时对照任务书中的用例表逐条检查测试存在性，不只看通过数。

### C1：cards 按 role 分流存 ABILITY

**预估：~120 行；token ~80k。依赖：无。**

- 背景：上文"关键事实"一节；读 `src/offline/verifier.ts`（重点 `cardsToStaged` 与 `StagedCard` 接口）、`src/offline/verifier.ts` 模块注释、`test/offline/verifier.test.ts`、`src/injection.ts` 的 ABILITY 消费方式（payload.role/procedure/boundary）。
- 实现要求：
  1. `cardsToStaged` 按 `card.role` 分流：`"Method"`/`"Guard"` → `type:"ABILITY"`（payload 保留五元组 + `text: trigger+procedure`，与现有 cards 映射一致）；其余（含 `"Workflow"`、缺失、未知值）维持 `type:"EVIDENCE"`。
  2. 模块注释更新：说明 Method/Guard 经 cards 五元组进入 ABILITY、仍无负面库。
  3. 同步修正受影响的既有测试断言（scheduler.test.ts 的 STAGED_CARDS 含 `role:"Method"`，晋升计数会变——这是预期变化，在决策记录中说明）。
- **TDD 测试用例表（先写这些测试并确认红，再实现）**：

| # | 输入 fixture | 预期断言 |
|---|---|---|
| 1 | card：`role:"Method"`, quality=0.7，五元组齐全 | `cardsToStaged` 产出 `type:"ABILITY"`；`payload.role==="Method"`；`payload.trigger/procedure/boundary/evidence` 与输入逐项相等；`payload.taskId===entry.taskId`；`text === trigger+"\n"+procedure`；`verifyAndCanonicalize` 后入库为 active |
| 2 | card：`role:"Guard"`, quality=0.6 | `type:"ABILITY"`；`payload.role==="Guard"`；入库 active |
| 3 | card：`role:"Workflow"`, quality=0.9 | 维持 `type:"EVIDENCE"`（边界：高分也不分流） |
| 4 | card：无 `role` 字段（undefined） | `type:"EVIDENCE"`，不抛异常 |
| 5 | card：`role:"UnknownRole"`（非法枚举值） | `type:"EVIDENCE"`，不抛异常 |
| 6 | card：`role:"Method"`, quality=0.5（恰好阈值） | ABILITY 且晋升 active（`>= PROMOTION_THRESHOLD`） |
| 7 | card：`role:"Method"`, quality=0.49（恰低于阈值） | 不晋升，不入库（阈值语义不变） |
| 8 | card：`role:"Method"`, quality 非 number（如字符串/缺失） | quality 按 0 处理（沿用现有 `typeof` 守卫），不晋升，不抛异常 |
| 9 | entry 无 `card` 字段（`card: null`/缺失） | 跳过该 entry（沿用现有 `continue`），不抛异常 |
| 10 | 混合数组：Method + Guard + Workflow + 无 role 各一条 | 分流后 ABILITY 恰 2 条、EVIDENCE 恰 2 条 |

- 验收：上表 10 条用例全部存在且通过；全套 vitest 通过 + 根 `npm run check` 干净。

### C2：注入端 Method/Guard 上限

**预估：~40 行；token ~40k。依赖：无（与 C1 文件不重叠，可并行；若并行，C1 先合并以免测试断言互相踩）。**

- 实现要求：`src/injection.ts` 增加 `METHOD_LIMIT = 5`、`GUARD_LIMIT = 5` 常量（风格对齐既有 `SKILL_CATALOG_LIMIT`/`SOP_SCHEMA_LIMIT`）；Method/Guard 的处理顺序必须固定为 **(a) 先按现有 typeof 守卫过滤掉空/非字符串 procedure/boundary → (b) 按 `r.experience.quality` 降序排序（并列保持稳定序）→ (c) 取前 N 条截断**；顺序不可颠倒（先截断再过滤会导致空条目占用名额）。其余注入逻辑不变。
- **TDD 测试用例表（先写这些测试并确认红，再实现）**：

| # | 输入 fixture | 预期断言 |
|---|---|---|
| 1 | 7 条 active ABILITY `role:"Method"`，quality 分别 0.95/0.9/0.8/0.7/0.6/0.55/0.5，乱序传入 | 注入消息恰好含 5 条 procedure，且为 quality 前 5（0.95..0.6），按降序排列；0.55/0.5 两条不出现 |
| 2 | 7 条 active ABILITY `role:"Guard"`，quality 梯度同上 | 注入恰好 5 条 `注意：<boundary>`，降序，截断最低 2 条 |
| 3 | 恰好 5 条 Method（off-by-one 边界） | 5 条全部注入，无截断 |
| 4 | 3 条 Method（不足上限） | 3 条全量注入 |
| 5 | 0 条 Method / 0 条 Guard（空输入） | 不产生 Method/Guard 块，合成消息不含空块 |
| 6 | Method 中存在 quality 并列（如两条 0.8） | 两者相对顺序稳定（排序稳定），总数仍 ≤5 |
| 7 | Method 条目 `payload.procedure` 为空字符串/非字符串 | 该条不进入注入（沿用现有 typeof 守卫），不占用 5 条名额 |
| 8 | dormant 状态的 Method 条目混入 | 被过滤（沿用 active 过滤），不计入 5 条 |
| 9 | 6 条 Method + 6 条 Guard 同时存在 | Method ≤5 且 Guard ≤5，互不挤占名额 |

- 验收：上表 9 条用例全部存在且通过；全套 vitest 通过 + 根 `npm run check` 干净。

### C3：live 验证 + 迭代观察基线

**预估：文档为主；token ~80k。依赖：C1、C2 合并后。**

- 方法参照 `doc/design/2026-07-22-agent-server-p2-live-verification.md`（MockLLM + 真实 `var/sessions` 跑 `runDailyEvolution`，再起 agent-server 发非流式请求）。
- **BDD 验收场景（每个场景都要在验证文档中给出实际执行结果与证据）**：

**场景 1：Method/Guard 以 ABILITY 入库**
- **Given** `var/sessions` 中有真实会话轨迹，离线管线产出含 `role:"Method"`/`role:"Guard"` 的 cards
- **When** 执行一次 `runDailyEvolution`
- **Then** SQLite 中存在 `type='ABILITY'` 且 `status='active'` 的新条目；复查命令（`quality` 是表列而非 payload 字段，直接选列）：
  `sqlite3 <db> "SELECT type, status, json_extract(payload,'$.role'), quality FROM experiences WHERE type='ABILITY' ORDER BY rowid DESC LIMIT 20;"`
  同时统计已知限制中的并存行（同 taskId 既有 EVIDENCE 又有 ABILITY 的数量）：
  `sqlite3 <db> "SELECT json_extract(a.payload,'$.taskId') FROM experiences a JOIN experiences e ON json_extract(a.payload,'$.taskId')=json_extract(e.payload,'$.taskId') WHERE a.type='ABILITY' AND e.type='EVIDENCE';"`

**场景 2：注入包含新 ABILITY 且受上限约束**
- **Given** 库中已有 active 的 Method/Guard ABILITY 条目（场景 1 产出）；**请求的用户消息必须手工构造为包含目标 card 的 trigger 关键词**（检索走 FTS5 bm25，查询不命中 trigger 文本则检索不到该条目，场景无法成立——构造后先直接用 `store.search` 或 SQL `experiences_fts MATCH` 验证能命中，再发请求）
- **When** 向 agent-server 发一条非流式 chat 请求
- **Then** 注入的合成 user 消息包含 ABILITY 的 procedure / `注意：<boundary>` 文本；Method 块 ≤5 条、Guard 块 ≤5 条；证据：server 侧落盘的 session JSONL 或注入日志截图/摘录。

**场景 3：迭代观察基线固化**
- **Given** 场景 1/2 已完成
- **When** 统计当前库状态
- **Then** 产出基线文档，含可复查 SQL/命令与结果：Method/Guard 各自库存量、quality 分布（分桶 0.5-0.6/0.6-0.8/0.8-1.0）、场景 2 中是否发生截断。该基线是"上线运行一段时间后迭代"的对照起点（元原则要求）。

- 验收：live 验证文档 + 观察基线文档落 `doc/design/`（带前导空格），3 个 BDD 场景逐一对应执行记录；同提交更新 `doc/design/INDEX.md`。

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| C1 cards role 分流 | ~120 | ~80k | 无 |
| C2 注入端上限 | ~40 | ~40k | 无（建议 C1 先合并） |
| C3 live 验证 + 观察基线 | 文档 | ~80k | C1+C2 |
| **合计** | **~160 行 + 文档 / 3 提交** | **~200k** | |

估算口径同 P2/P3。
