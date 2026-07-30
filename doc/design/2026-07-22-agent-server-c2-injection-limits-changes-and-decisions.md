# Agent Server C2：注入端 Method/Guard 上限——改动与决策记录

日期：2026-07-22
任务：`doc/design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md` 的 "C2：注入端 Method/Guard 上限" 一节
状态：已完成（测试 20 文件 / 213 用例全绿）

## 改动文件

- `packages/agent-server/src/injection.ts`：`buildInjection` 增加 Method/Guard 上限逻辑与模块注释同步。
- `packages/agent-server/test/injection.test.ts`：新增 describe 块 `buildInjection Method/Guard quality caps`，9 条用例（与任务书用例表一一对应）。

## 决策记录

| # | 决策点 | 决定 | 理由 |
|---|---|---|---|
| 1 | 常量定义 | 新增 `METHOD_LIMIT = 5`、`GUARD_LIMIT = 5`，紧邻既有 `SKILL_CATALOG_LIMIT`/`SOP_SCHEMA_LIMIT`，注释风格一致 | 任务书明确要求；集中放置便于发现所有注入上限 |
| 2 | 处理顺序 | 固定为 **过滤（typeof 守卫）→ 按 quality 降序排序 → slice 截断** | 任务书硬约束；先截断再过滤会让空/非字符串 procedure/boundary 占用名额（用例 7 专测）。typeof 守卫沿用循环内既有写法，因此过滤自然发生在收集阶段（排序之前） |
| 3 | 排序稳定性 | 直接用 `Array.prototype.sort` 原数组排序，比较器 `(a, b) => b.quality - a.quality` | ES2019 起 `Array.prototype.sort` 规范保证稳定，quality 并列时保持传入（检索）顺序；Node ≥ 22 运行时必然满足，无需额外 tie-breaker |
| 4 | 收集容器形态 | Method/Guard 循环内收集 `{ quality, text }` 对象而非字符串，排序截断后再 `.map` 出文本 | 避免排序后再对 `payload.procedure` 做类型断言（`as string`）；typeof 收窄在收集点完成，类型安全且无 `any` |
| 5 | Guard 文本包装时机 | `` `注意：${boundary}` `` 在收集阶段（循环内）拼接 | 与现状一致，最小改动；排序键只有 quality，与文本无关 |
| 6 | EVIDENCE 池 / 块拼接 / 插入位置 / SKILL/SOP | 完全不动 | 任务书要求"其余注入逻辑不变" |
| 7 | 测试注入消息读取 | 测试 helper 取 `result.messages[length-2]`（最后一条真实 user 消息之前）并防御 `content` 非字符串返回 `""` | 沿用既有测试对注入位置的断言方式；`typeof` 守卫避免 `any` |
| 8 | 既有断言 | 未修改任何既有测试断言 | C2 是纯增量上限，不改变 5 条以下场景的行为 |

## 任务书用例表逐条对应

| # | 用例（任务书） | 测试（`test/injection.test.ts` → `buildInjection Method/Guard quality caps`） | TDD 红/绿 |
|---|---|---|---|
| 1 | 7 条 Method 乱序 → 前 5 降序，截断最低 2 条 | `caps Method entries at 5, keeping the highest qualities in descending order` | 红 → 绿 |
| 2 | 7 条 Guard 乱序 → 5 条 `注意：<boundary>` 降序 | `caps Guard entries at 5, keeping the highest qualities in descending order` | 红 → 绿 |
| 3 | 恰好 5 条 Method（off-by-one） | `injects all 5 Methods when exactly at the limit` | 绿（上限逻辑不改变恰好 5 条行为；用例用于守住边界） |
| 4 | 3 条 Method 不足上限全量注入 | `injects all Methods when below the limit` | 绿（同上，守边界） |
| 5 | 0 条 Method/Guard 不产生块 | `produces no Method/Guard block when there are none`（空输入不插入消息；仅 EVIDENCE 时无 Method/Guard 行、无 `注意：`） | 绿（守回归） |
| 6 | quality 并列保持相对稳定序，总数 ≤5 | `keeps a stable relative order for quality ties`（并列两条 tie-first/tie-second 断言相对顺序；6 条截断到 5） | 红 → 绿 |
| 7 | 空/非字符串 procedure 不占名额 | `filters malformed Method procedures before applying the limit`（0.99 空串 + 0.98 数字 + 5 条有效 → 5 条有效全部注入） | 绿（无上限时本就全注入；该用例真正约束力在于"过滤先于截断"的顺序——若实现先截断 5 条再过滤，只会剩 3 条有效，断言失败） |
| 8 | dormant Method 被过滤不计入 | `excludes dormant Method entries from the capped set`（dormant 0.99 + 4 条 active → 恰 4 条） | 绿（active 过滤是既有行为；守住"上限计数只含 active"） |
| 9 | 6 Method + 6 Guard 互不挤占 | `caps Method and Guard independently` | 红 → 绿 |

## 验证结果

- TDD：9 条用例先提交测试，4 条红（用例 1/2/6/9，即真正需要上限逻辑的部分），实现后全绿；用例 3/4/5/7/8 为边界/回归守护，实现前后均绿（理由见上表）。
- `cd packages/agent-server && node ../../node_modules/vitest/dist/cli.js --run`：**20 文件 / 213 测试全部通过**（基线 194 + 本任务 9 + 并行 C1 任务 10）。
- `npx biome check --write packages/agent-server/src/injection.ts packages/agent-server/test/injection.test.ts`：首次修复 1 处格式，复检 `No fixes applied`。
- `tsgo --noEmit`（packages/agent-server）：无错误。
- 未执行 git 操作；未跑根 `npm run check`（避免与并行 agent 冲突）；未改 `doc/design/INDEX.md`（由主协调统一更新）。

## 环境备注（阻塞及排除）

执行时发现 better-sqlite3 无可用 native binding：本机 Homebrew 默认 node 已升级为 v26.5.0（`/opt/homebrew/opt/node@25` 的符号链接也被改写指向 26.5.0），而 better-sqlite3 11.10.0 源码与 Node 26 的 V8 API 不兼容（`GetPrototype`/`GetIsolate`/`PropertyCallbackInfo::This` 已移除），且无 Node 26 预编译产物，仓库根 `npm rebuild better-sqlite3` 在默认 node 下失败。Cellar 中残留的 node 25.9.0_2 二进制因 llhttp 9.3→9.4.2 升级导致 dylib 缺失无法启动。

处置（未改动任何工程外状态）：下载官方 Node v25.9.0 tarball 到 `/tmp/node-v25.9.0-darwin-arm64`，用其 `PATH` 执行 `npm rebuild better-sqlite3`（binding 产物在工程内 `node_modules/better-sqlite3/build/Release/`，为 Node 25 ABI），并用该 node 跑全部测试与 tsgo。**后续在默认 node 26 下跑 vitest 仍会报 binding 错误**——要么用 Node 25 运行，要么升级 better-sqlite3 到支持 Node 26 的版本（涉及根 package.json/lockfile，超出本任务范围），请主协调裁决。`/tmp` 下的 node 与 `node25.tar.gz` 属临时文件，可删。
