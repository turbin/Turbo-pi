# Agent-Server Post-C 任务书：N1 FTS 修正 / N2 Docker 构建验证 / N3 上线观察期启动

日期：2026-07-23
状态：**已立项（2026-07-23 用户拍板全部三项）**
背景：C 方案（ABILITY 提炼）已于 2026-07-23 全部收口（C1/C2/C3 + 场景 1 follow-up 完整 PASS）。本任务书是 C 之后的运维化里程碑，三项任务分发给独立 agent 执行。
进度跟踪：` design/progress/2026-07-23-post-c-operations.md`（**认领/完成/中断都必须更新该文件**，纪律见 ` design/progress/README.md`）。

---

**通用约束**：完整约束见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，全部适用（改动仅限工程内、omlx 不可动、tabs/行宽 120/erasable TS/无 inline import、每任务 1 提交、决策记录落 ` design/`（带前导空格）、提交信息带 conventional 前缀 + COMPLETED/TODO/Refer Spec）。新增：**progress 文件随工作同提交更新**（` design/progress/README.md` 更新纪律第 4 条）。

**测试要求（强制执行）**：canonical 在工程根 `CLAUDE.md` 的 "Testing requirements" 一节，要点：

1. TDD：先写失败测试（红）→ 最小实现（绿）→ 重构；测试与实现同一提交。
2. 包级 vitest 全量全绿 + 根 `npm run check` 干净；禁止 `.skip`/放宽既有断言凑绿；既有断言确需修改的，在决策记录中说明理由。
3. 边界覆盖：空/缺失/undefined、阈值边界、上限 off-by-one、非法枚举，逐项有用例。
4. 验收时对照任务书用例表逐条检查测试存在性。

**执行环境备忘**（细节见 progress 文件交接信息）：

- Node 必须走 `scripts/with-node25.sh`（25.9.0）；测试从 `packages/agent-server` 跑：`../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run [文件]`。
- 当前基线：20 测试文件 / 213 测试全绿。

---

## N1：FTS tokenizer 修正（拉丁整词 + CJK bigram + FTS 重建 CLI）

**预估：实现 ~80 行 + 测试；token ~100k。依赖：无。**

### 背景

C3 follow-up（` design/2026-07-23-agent-server-c3-followup-natural-method-changes-and-decisions.md` 决策 4）发现：`tokenizeForFts`（`packages/agent-server/src/experience-store.ts:69-83`）对**非 CJK 字符也逐字拆开**写入 `search_text`，导致 FTS5 词查询对拉丁正文永不命中；词查询实际只命中 `title` 列（INSERT 语句 `SELECT rowid, title, ?` 中 title 从 experiences 原样取，未经 tokenizer）。实证：`MATCH 'jitter'`（仅存在于 card 正文）0 命中，`MATCH 'flaky'`（title 内）命中。后果：**英文 session 的 ETL EVIDENCE 正文、ABILITY 的 trigger/procedure 正文均无法被检索**，检索召回实质退化到"只搜标题"。中文正文靠 char/bigram 不受影响。

### 实现要求

1. **重写 `tokenizeForFts`**（`src/experience-store.ts`）：
   - 拉丁/数字连续段（`[a-zA-Z0-9]+`）保留为整词 token；
   - CJK（`[一-鿿]`）维持现状：单字 + 相邻 bigram；
   - 混合文本逐段处理；空白/标点为天然分段；
   - 行为对齐 `src/retrieval.ts` 的 `tokenize()`（retrieval.ts:65+，已是"拉丁整词 + CJK char/bigram"）——两侧分词口径必须一致，否则查询侧与索引侧错位。
2. **FTS 重建 CLI**：新增 `src/offline/rebuild-fts.ts`（standalone CLI，风格对齐 `schedule.ts` 的 CLI dispatch）：`DELETE FROM experiences_fts` 后按新 tokenizer 从 experiences 全量重插（`search_text` = `title + " " + (payload.text ?? "")`，与 `ExperienceStore.insert()` 现行构造一致），打印处理行数。必须支持 `--dry-run`（只打印将重建的行数，不写）。**红线：dry-run 之外只许动 EXPERIENCE_STORE_PATH 指向的库文件，不碰其他任何状态。**
3. **不自动迁移**：server 启动、run-evolution 均不自动重建；重建是手动一次性动作，写进决策记录。

### TDD 测试用例表（先写这些测试并确认红，再实现）

| # | 输入 fixture | 预期断言 |
|---|---|---|
| 1 | 插入 EVIDENCE：title="Note"，payload.text 含英文词 `idempotent`（title 中不含） | `store.search('"idempotent"', 10)` 命中该行（修复前必红） |
| 2 | 插入 ABILITY：payload.text 含 `backoff`/`jitter`（title 不含） | 两词各自 MATCH 均命中 |
| 3 | 中文正文："量子计算是……"（title 不含"量子"） | 查询"量子"命中（既有行为不回归） |
| 4 | 混合正文："使用 backoff 策略处理 flaky API" | `"backoff"`、`"flaky"`、`"策略"`（CJK 前缀查询）均命中 |
| 5 | payload.text 缺失/空字符串/纯标点 | 插入不抛异常；空查询词不命中 |
| 6 | `tokenizeForFts` 单测：`"Bounded Exponential-Backoff"` | 输出含整词 `Bounded`、`Exponential`、`Backoff`（连字符分段），无单字拆 |
| 7 | `tokenizeForFts` 单测：`"量子计算"` | 输出含 `量`、`量子`、`子`、`计算`、`算`（char + bigram，与现状一致） |
| 8 | 重建 CLI：先用**旧格式**（手工 SQL 往 FTS 插拆字文本）造一行，跑重建 | 重建后该正文词可词查询命中；experiences 行数不变；FTS 行数 = experiences 行数 |
| 9 | 重建 CLI 跑两次 | 第二次后状态与第一次完全一致（幂等） |
| 10 | 重建 CLI `--dry-run` | 库文件 mtime 不变 / 无写入（可用临时库断言行数不变） |

### 验收

- 上表 10 条用例全部存在且通过；包级 vitest 全量（213 + 新增）通过；根 `npm run check` 干净。
- live  sanity（写入决策记录）：对 `var/experience.db` 先备份再跑重建 CLI，之后 `MATCH 'jitter'` 命中自然 Method card（修复前 0 命中的对照）。

---

## N2：Docker 镜像首次构建验证

**预估：验证为主（文档 + 可能的 Dockerfile 小修）；token ~80k。依赖：无（前置：colima 运行）。**

### 背景

` design/2026-07-22-agent-server-infra-node-pinning-and-container-changes-and-decisions.md` 交付了 `packages/agent-server/Dockerfile`（基础镜像 `node:25.9.0-bookworm-slim`）与 `docker-compose.yml`（主服务 + `agent-server-evolution` sidecar，`--loop` 模式），但**从未实际构建**（当时 colima 未运行，避免工程外状态变更）。

### 前置红线

`colima status` 检查：未运行则**停止并向用户报告**，由用户启动或明确授权后再继续——启动 VM 是工程外系统状态变更（通用约束）。`docker build` 需要拉基础镜像（网络），属正常构建动作。

### 步骤

1. `colima status` → 未运行按红线处理。
2. `docker build` 构建镜像（tag 如 `agent-server:local`），记录构建日志关键段（Node 版本、better-sqlite3 编译/预装、镜像大小）。
3. 单容器冒烟：启动容器，验证健康/状态端点可达（如 `/api/evolution/status` 或 server 实际提供的路由，以代码为准），记录响应。
4. `docker compose up` 双服务：主服务 + evolution sidecar；sidecar `--loop` 首轮立即执行一次进化——挂卷 `/data` 放入 2-3 个 session（可复用 `var/sessions/` 样本），确认 checkpoint 产生（`--status` 或容器日志）。
5. `docker compose down` 清理；镜像保留与否在决策记录中说明。
6. 若构建失败需要改 Dockerfile/compose：允许，属工程内文件；每处修改必须在决策记录中写原因。

### 验收

- 验证文档 ` design/<date>-agent-server-docker-build-verification.md`：构建日志摘要、冒烟响应、compose 双服务运行证据（日志/checkpoint）、发现的问题与修复。
- 决策记录（可与验证文档合并）：` design/<date>-agent-server-n2-docker-build-changes-and-decisions.md`。
- progress 文件状态更新。

---

## N3：上线观察期启动（dry-run 审查 + 安装指令交付 + 观察 runbook）

**预估：文档为主；token ~60k。依赖：无（"实际安装"是用户动作）。**

### 背景

- B3（` design/2026-07-22-agent-server-b3-evolution-scheduling-changes-and-decisions.md`）：方案 A+，触发外部化；`schedule.ts` 已实现 `install`/`uninstall`/`doctor` + `--dry-run`，红线：测试沙箱外禁止无 `--dry-run` 跑 install/uninstall。
- C 元原则：全部决策暂定，上线运行后按观察基线迭代。基线：` design/2026-07-23-agent-server-c3-observation-baseline.md`（2026-07-23 follow-up 刷新版）。

### 子任务

1. **dry-run 审查**：跑 `npx tsx src/offline/schedule.ts doctor --dry-run` 与 `install --dry-run`，把将写入的 plist/crontab 内容、路径、命令行完整摘录进决策记录，确认无误（工作目录、Node 路径是否走 `with-node25.sh`、env 是否含 `EXPERIENCE_STORE_PATH`/`AGENT_SERVER_BENCHMARK`/`PYTHONPATH`——**这是重点审查项**，调度环境下没有交互 shell 的 env）。
2. **安装指令交付**：为用户写出逐条可复制的安装/卸载/自查命令（含每条命令的预期输出）。**agent 不执行实际 install**，由用户运行或明确授权。
3. **观察 runbook**：新增 ` design/<date>-agent-server-observation-runbook.md`，内容：
   - 观察周期与评审节奏（建议：每周一次对照基线，跑满 4 周出第一份迭代评估）；
   - 对照 SQL 集：直接引用基线文档 §1/§3/§4/§5/§6 的 SQL，逐条给出"关注什么变化"（自然 Method/Guard 产量、quality 分布展宽、并存行、截断触发、checkpoint metric 趋势）；
   - 触发评审的动作表：如"Method/Guard 库存 ≥6 → 评审截断"「Guard 误伤案例出现 → 评审 Guard 阈值」「并存行 >0 → 评审清理立项」「ABILITY 产量持续为 0 → 评审 C-重立项」（对应 C 方案 5 项决策的观察项）；
   - 日常使用接线说明：客户端（pi/Kimi Code）如何指向 agent-server（8788）以积累真实 session（以 `packages/agent-server` README/代码为准写，不要臆造配置项）。
4. 观察期的第一份周报模板（放 runbook 附录）。

### 验收

- 决策记录 ` design/<date>-agent-server-n3-go-live-changes-and-decisions.md`：dry-run 输出审查结论 + 安装指令 + 未执行 install 的说明。
- runbook 文档落 ` design/`。
- progress 文件状态更新。

---

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| N1 FTS tokenizer 修正 | ~80 + 测试 | ~100k | 无 |
| N2 Docker 构建验证 | 文档为主 | ~80k | colima（用户配合） |
| N3 上线观察期启动 | 文档为主 | ~60k | install 是用户动作 |
| **合计** | **3 提交 + progress 更新** | **~240k** | |

估算口径同 P2/P3/C。
