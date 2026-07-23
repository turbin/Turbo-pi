# Agent-Server R 任务书：真实化里程碑（真实 LLM teacher 验证 / 对照评估与切换 / C-重评审）

日期：2026-07-23
状态：**已立项（2026-07-23 用户拍板 A 组：真实化）**
背景：C 方案与 Post-C 运维化已收口（agent 侧）。观察基线（` design/2026-07-23-agent-server-c3-observation-baseline.md` §8.1/§8.4）指出当前离线进化在 MockLLM 路径下存在结构性失真：quality 评分由关键词驱动、role 分布偏 Workflow、ABILITY 产量不代表真实水平。本里程碑切换到真实 LLM teacher 验证全链路，并基于真实数据评审 C-重立项。
进度跟踪：` design/progress/2026-07-23-r-real-teacher.md`（**认领/完成/中断都必须更新该文件**，纪律见 ` design/progress/README.md`）。

---

**通用约束**：完整约束见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，全部适用（改动仅限工程内、omlx 不可动、tabs/行宽 120/erasable TS/无 inline import、每任务 1 提交、决策记录落 ` design/`（带前导空格）、提交信息带 conventional 前缀 + COMPLETED/TODO/Refer Spec）。**progress 文件随工作同提交更新**。

**测试要求（强制执行）**：canonical 在工程根 `CLAUDE.md` 的 "Testing requirements" 一节，要点：

1. TDD：先写失败测试（红）→ 最小实现（绿）→ 重构；测试与实现同一提交。
2. 包级 vitest 全量全绿 + 根 `npm run check` 干净；禁止 `.skip`/放宽既有断言凑绿；既有断言确需修改的，在决策记录中说明理由。
3. 边界覆盖：空/缺失/undefined、阈值边界、上限 off-by-one、非法枚举，逐项有用例。
4. 验收时对照任务书用例表逐条检查测试存在性。

**执行环境备忘**：

- Node 必须走 `scripts/with-node25.sh`（25.9.0）；测试从 `packages/agent-server` 跑：`../../scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run [文件]`。
- 当前基线：21 测试文件 / 225 测试全绿。
- omlx 在 127.0.0.1:8000（模型 gemma-4-12B-it-4bit，要 api_key）；gateway 8787（channel key `lobster-local-key`）；agent-server 8788。**omlx 不可动**。
- 进化 CLI（从 `packages/agent-server` 执行）：`EXPERIENCE_STORE_PATH=./var/experience.db AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json PYTHONPATH=python ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts`。
- LLM 切换机制（`src/offline/pipeline.ts:18-20`）：子进程 env 透传，`LLM_BASE_URL` + `LLM_MODEL`/`TEACHER_MODEL` 设置后走真实 OpenAI 兼容端点，否则回退确定性 MockLLM。
- 运行前备份：`cp var/experience.db var/experience.db.r1-pre-real-teacher-backup`。

---

## R1：真实 LLM teacher 全链路 E2E 验证（含 rescore 超时治理）

**预估：验证为主 + 可能的超时治理小改；token ~120k。依赖：无（omlx 运行中，已在产线使用）。**

### 背景

- P3-1（` design/2026-07-22-agent-server-p3-task1-real-llm-verification.md`）验证了单条 CLI 的真实 LLM 路径：verification 主管线 / sop_lifecycle / skill_evolution 退出码 0、分数有区分度；但 **rescore 模式超时**（gemma-4-12B 在 120s 内未完成 3 标准 × 4 次 = 12 次 LLM 调用，退出码 124）。当时结论为"真实 LLM 延时问题而非代码 bug"，未治理。
- TS 侧 `timeoutMs` 已参数化（`src/offline/pipeline.ts:57-58`，默认 300_000），但真实 LLM 下完整 `runDailyEvolution`（ETL → 三管线 → verifier → rescore → 清理 → checkpoint）**从未端到端跑过**。
- MockLLM 路径的失真见基线 §8.1/§8.4：quality 由 `keyword_quality_index` 关键词驱动；role 分流靠 `extract_handler` 关键词门控，轨迹不含门控关键词则全部产 Workflow。

### 实现要求

1. 备份经验库后，以真实 LLM env（`LLM_BASE_URL=http://127.0.0.1:8000/v1`、`LLM_MODEL`/`TEACHER_MODEL=gemma-4-12B-it-4bit`、`LLM_API_KEY=<omlx key>`）跑完整 `runDailyEvolution`，逐 stage 记录耗时与产出。
2. **rescore 超时治理**（如实测仍超时，按需选做，每处改动必须在决策记录中写原因并配 TDD 测试）：
   - `timeoutMs` 环境变量化（如 `AGENT_SERVER_PIPELINE_TIMEOUT_MS`），风格对齐既有 env 配置；
   - 或 rescore 分批/限次（单轮 rescore 候选数上限）；
   - 不允许静默跳过 rescore 失败——失败语义写入 checkpoint snapshot（对齐 B3 三态语义）。
3. 验证产物：新 checkpoint 的 snapshot 各字段非零路径真实；新晋升条目的 quality 分数**不再集中于关键词档位**（对照基线 §3 的 0.552438/0.578298/0.603735 档）。
4. 数据红线：只许动 `EXPERIENCE_STORE_PATH` 指向的库与 `var/sessions/`；omlx 配置不可动。

### 验收

- 决策记录 ` design/<date>-agent-server-r1-real-teacher-e2e-changes-and-decisions.md`：逐 stage 耗时表、checkpoint 证据、新条目 quality/role 与 Mock 基线的差异、超时治理改动及原因。
- 若有代码改动：TDD 用例覆盖（env 缺失/非法值回退默认、超时行为），包级 vitest 全量全绿 + 根 `npm run check` 干净。

---

## R2：Mock vs 真实对照评估与 teacher 切换建议

**预估：文档为主；token ~60k。依赖：R1 完成（需要真实 run 的数据）。**

### 实现要求

1. **对照评估报告**：用基线文档 §1（库存）/§3（quality 分布）/§5（截断）的 SQL 集，对 R1 真实 run 后的库出数，与 Mock 基线逐项对照：role 分布是否仍偏 Workflow、quality 分布是否展宽、ABILITY 自然产量。
2. **切换建议**：给出日常进化切换到真实 teacher 的配置方案——LaunchAgent plist 需添加的 `EnvironmentVariables`（`LLM_BASE_URL`/`LLM_MODEL`/`TEACHER_MODEL`/`LLM_API_KEY`）与超时项；**只交付指令与 dry-run 级审查，实际安装/修改 plist 是用户动作**（同 N3 红线）。密钥不得写入决策记录，plist 指令中用占位符。
3. **基线刷新**：更新观察基线文档为"真实 teacher 版"（保留 Mock 基线数字作历史对照，标注口径变化），runbook 的对照 SQL 不变。
4. 评估真实 teacher 的日常运行成本（单轮 LLM 调用次数 × 频率），写进报告供用户决策。

### 验收

- 对照评估报告落 ` design/`（可并入 R1 决策记录或独立文档，独立则命名 ` design/<date>-agent-server-r2-mock-vs-real-evaluation.md`）。
- 刷新后的基线文档与切换指令；progress 文件状态更新。

---

## R3：C-重 Go/No-Go 评审

**预估：评审文档；token ~40k。依赖：R2 的对照数据。**

### 背景

C 决策 1（` design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`）：提炼通路走 C-轻（cards role 分流，零新 LLM 调用），观察项为"Method/Guard 每轮产量、质量分布；若产量不足再立项 C-重（独立 LLM 提炼管线）"。runbook 动作表触发条件："ABILITY 自然产量连续 4 周为 0 → 评审 C-重"。R1/R2 提供了提前评审所需的真实 teacher 数据。

### 实现要求

1. 基于 R2 对照数据做 Go/No-Go 评审：
   - **No-Go**（真实 teacher 下 ABILITY 产量/质量达标）：记录数据支撑的理由，关闭该项，runbook 触发表维持原观察节奏。
   - **Go**（产量仍不足）：产出 C-重方案设计（独立提炼管线的输入/输出、与 verification_selection 的关系、成本估算）+ 任务分解，提交用户拍板后再执行。
2. 评审结论写入决策记录，C 决策 1 的观察项状态同步更新到 ` design/INDEX.md` 决策时间线。

### 验收

- 评审报告 ` design/<date>-agent-server-r3-c-heavy-review.md`：Go/No-Go 结论 + 数据依据 +（如 Go）方案设计与任务分解。
- INDEX.md 时间线更新；progress 文件状态更新。

---

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| R1 真实 teacher E2E + 超时治理 | 验证 + ~60 治理改动 | ~120k | omlx 运行 |
| R2 对照评估 + 切换建议 | 文档 | ~60k | R1 |
| R3 C-重 Go/No-Go 评审 | 文档 | ~40k | R2 |
| **合计** | **3 提交 + progress 更新** | **~220k** | |

估算口径同 P2/P3/C/Post-C。

## 里程碑外（不立项，仅记录）

- 观察期周报到节奏（runbook §1）按周执行，不占本里程碑任务位。
- B 组（toolCall 阻断模式、SOP 真实评分、benchmark 接线）与 C 组（并存行清理、Method 合并）维持触发式立项，触发条件见 runbook §3 动作表。
