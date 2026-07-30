# Agent Server A2 + B3 任务书（可分发给独立 agent 执行）

日期：2026-07-22
来源：P3 验收遗留（A2）+ 离线调度定时化讨论（B3，方案 A+ 已经用户批准）。
状态：**已立项（2026-07-22 用户批准方案 A+）**。每个任务书自包含（零上下文 agent 可直接执行），文件不重叠，可并行分发。

## 通用约束

完整通用约束见 `doc/design/2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，**全部适用**，要点重述：

- 改动范围仅限当前工程（pi-monorepo）内；工程外（用户配置、omlx、crontab、launchd、系统状态）一律不得改动——**B3 的 install/uninstall 命令本身以写系统位置为目的，但执行 agent 只实现并用 dry-run 测试，不得真跑 install**（见 B3 要求 4）。
- 测试基线：agent-server 全套 **18 文件 / 175 测试**（从 `packages/agent-server` 跑 `node ../../node_modules/vitest/dist/cli.js --run`）；代码改动后跑根 `npm run check` 修到干净。
- 代码风格：tabs、行宽 120、erasable TS only、无 inline import、最小改动。
- 每任务 = 1 个提交（实现 + 测试 + 决策记录文档，≤3000 行）；决策记录落 `doc/design/<date>-agent-server-<任务号>-*-changes-and-decisions.md`（目录名带前导空格）。
- 提交信息格式（用户约定）：`COMPLETED：… / TODO：… / Refer Spec：…`，**加 conventional 前缀**（如 `feat(agent-server): …`，P3 遗漏此前缀，已记录为瑕疵，勿重复）。

## 现状速览

- 离线进化核心：`packages/agent-server/src/offline/scheduler.ts` 的 `runDailyEvolution(store, options)`（ETL → pipeline → promote → dormant rescore → cleanup → checkpoint，返回 checkpoint id）。模块注释声明"触发外部化（cron 或手动），故意不接入 server 启动"——**B3 全程不得推翻此决策**。
- checkpoint：`src/offline/checkpoint.ts` 的 `writeCheckpoint(store, {kind, epoch, metric, snapshot})`；`ExperienceStore.getLatestCheckpoint(kind)` 可读最近一条。
- server：`src/server.ts`（Fastify），已有 `/api/stream` 与 `/v1/chat/completions` 两个端点；store 在 `createServer` 内构造。
- 环境事实：系统 python3 带 pytest 7.4.3；`packages/agent-server/python/` 下**没有**测试基础设施（无 pyproject、无 tests 目录）；Python 包以 `PYTHONPATH=packages/agent-server/python` 方式导入。

---

## A2：verifier 文本回退补单测

**预估：改动 ~150 行；token ~60k。**

### 背景

P3-1 为 `python/verification_selection/verifier.py` 新增了无 logprobs 时的文本回退（`_extract_scores_from_text`，正则提取 `<score_A>`/`<score_B>`）和 `extract_tag_distribution` 的 dict/list 入参兼容。该代码只有真实端点 live 验证背书，无自动化测试；它是真实 LLM 路径（如 MLX 后端不支持 logprobs）的关键回退，回归代价高。

### 目标

为这些回退路径建立 Python 单测，并给出一个可重复运行的测试入口。

### 要求

1. 先读 `python/verification_selection/verifier.py`（重点：`Verifier.score_pair` 的双通路逻辑、`_extract_scores_from_text`、`extract_tag_distribution`）和 `python/verification_selection/testing.py`（既有 mock 工具，尽量复用）。
2. 新建 `packages/agent-server/python/tests/test_verifier_fallback.py`（pytest 风格，系统 python3 已有 pytest 7.4.3，**不要新增任何依赖**）。覆盖：
   - `<score_A>`/`<score_B>` 文本解析：正常值、边界值（量程端点）、缺失/畸形标签时的行为（以实现的实际语义为准并在测试中固化，若发现实现缺陷先报告再修）；
   - `score_pair` 回退路径：logprobs 为空 list → 走文本回退；logprobs 为 dict 包装但 content 为空 → 走文本回退；logprobs 正常 → 走期望值路径（不触发回退）；
   - `extract_tag_distribution` 的 dict/list 两种入参兼容。
3. 测试运行方式：`cd packages/agent-server && PYTHONPATH=python python3 -m pytest python/tests/ -v`。在 `packages/agent-server/package.json` 加一个 `test:python` script 固化该命令（scripts 区既有模式照抄）；根 CI 不跑 Python 测试，在决策记录中注明这一点。
4. 不得改动被测实现（除非发现真实 bug——先停下报告，用户确认后再修）。

### 验收

- `PYTHONPATH=python python3 -m pytest python/tests/ -v` 全绿。
- agent-server 全套 175 测试不 regress；根 `npm run check` 干净。

---

## B3：离线调度定时化（方案 A+）

**预估：改动 ~350 行 + 测试；token ~150k。**

### 背景

`runDailyEvolution` 只能被代码调用，无独立触发入口。P1 决策：触发外部化（cron/手动），server 不背定时职责——本任务在此约束下把"每天自动跑"落地。方案 A+ 已获用户批准，四个组件：CLI 入口、失败 checkpoint、状态端点、安装助手 + 部署文档。

### 要求

1. **CLI 入口 `src/offline/run-evolution.ts`**（`npx tsx` 直接执行，`process.argv` 解析照抄 `src/offline/benchmark.ts` 的入口模式）：
   - 默认：初始化 ExperienceStore（路径解析与 `src/server.ts` 一致：`EXPERIENCE_STORE_PATH` env，缺省 `./var/experience.db`）→ 调 `runDailyEvolution`（透传 `AGENT_SERVER_BENCHMARK` 等既有 env）→ 打印 checkpoint id/metric/snapshot。
   - `--status`：读 `getLatestCheckpoint("evolution")`，打印上次运行时间、metric、snapshot 各阶段统计；从未跑过给出明确提示。
   - `--loop`：循环模式（跑 → sleep → 再跑），间隔取 `AGENT_SERVER_EVOLUTION_INTERVAL_HOURS`（缺省 24），供容器 sidecar 使用；单次失败不退出循环（记录后继续）。
   - **失败 checkpoint**：默认模式捕获异常 → 写 `kind:"evolution"`、`metric:0`、`snapshot:{"error": "..."}` 的失败记录 → 以非零码退出。使"没跑过"与"跑挂了"可区分。
2. **状态端点**：`createServer` 增加 `GET /api/evolution/status`，返回最新 evolution checkpoint 的 JSON（无则 404 或 `{status:"never_run"}`，二选一在决策记录中说明）。补 `test/server.test.ts` 测试。
3. **安装助手 `src/offline/schedule.ts`**：`install` / `uninstall` / `doctor` 三个子命令：
   - macOS：写 `~/Library/LaunchAgents/` plist；Linux：写 crontab 条目（`crontab -l` 合并去重）；全部**幂等**。
   - `doctor`：检查定时是否已安装、入口命令可执行、必需 env 是否就绪，缺什么打印修复命令。
   - **必须有 `--dry-run`**：打印将执行的写操作但不执行。
4. **执行 agent 的红线**：实现与测试只用 `--dry-run` 和临时 HOME（测试里把 HOME 指向 mkdtemp，launchd/crontab 写入都落在临时目录）；**不得真跑 install/uninstall**（那会动工程外系统状态，违反通用约束）。
5. **部署文档**：新建 `packages/agent-server/docs/offline-evolution-scheduling.md`（该包无 docs 目录，新建），覆盖：本机 cron/launchd（推荐 install 命令）、Kubernetes CronJob YAML 片段、docker-compose sidecar（`--loop`）片段、状态查询（`--status` 与 `/api/evolution/status`）与失败排查（checkpoint 表）。
6. 测试：CLI 默认/失败 checkpoint/--status（注入 store 与 runDailyEvolution 替身）；`--loop` 不测无限循环本身，测单次迭代逻辑；schedule.ts 在临时 HOME 下 install→doctor→uninstall 全链路 + 幂等（二次 install 无重复条目）+ dry-run 零写入。

### 验收

- 全套 vitest 通过 + 根 `npm run check` 干净。
- 手动 smoke（允许在本机执行，不涉及工程外写入）：`npx tsx src/offline/run-evolution.ts --status` 对真实 `var/experience.db` 输出最近一次 checkpoint；`schedule.ts doctor --dry-run` 输出检查报告。
- 决策记录含：失败 checkpoint 的 snapshot 契约、404 vs never_run 的选择、--loop 的间隔语义。

---

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| A2 verifier 回退单测 | ~150 | ~60k | 无 |
| B3 定时化（方案 A+） | ~350+测试 | ~150k | 无 |
| **合计** | **~500 行 / 2 提交** | **~210k** | 文件不重叠，可并行 |

估算口径同 P2/P3（上下文装载 + 实现 + 评审 + 修复 + 决策文档）。

## 分发建议

- 两个任务文件零重叠（A2 纯 Python + package.json scripts；B3 纯 TS + docs），可并行分发。
- B3 务必在分发 prompt 中强调红线：install/uninstall 只实现 + dry-run 测试，不得真跑。
