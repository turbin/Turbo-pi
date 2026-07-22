# Agent Server P3 候选任务分解（可分发给独立 agent 执行）

日期：2026-07-22
来源：` design/2026-07-22-agent-server-p2-closeout.md` 的 P3 候选清单。
状态：**未立项**。本文档是任务书草案，供用户审阅后分发给其他 agent 执行。每个任务书自包含（零上下文 agent 可直接执行）。

## 通用约束（所有任务适用）

- 仓库：pi-monorepo，工作范围限 `packages/agent-server`（另有说明除外）。
- Node：arm64 Node ≥ 22（当前 Homebrew v25.9.0 已验证）。首次 `npm install --ignore-scripts` 后需 `npm rebuild better-sqlite3`（Node 25 无预编译产物；头文件下载超时可用 `npm_config_dist_url=https://npmmirror.com/mirrors/node`）。
- 测试：从 `packages/agent-server` 运行 `node ../../node_modules/vitest/dist/cli.js --run`（全套，当前基线 148 通过）；单文件加路径参数。**不要**直接跑根 `npm test`。
- 代码改动后跑根目录 `npm run check`（完整输出，修到干净）。
- 代码风格：tabs（宽 3）、行宽 120（biome）、erasable TS syntax only、禁止 inline `await import()`、top-level imports only、最小改动。
- 每个任务 = 1 个提交（实现 + 测试 + 决策记录文档），单提交 ≤ 3000 行。决策记录落 ` design/<date>-agent-server-p3-task<N>-*-changes-and-decisions.md`（注意目录名带前导空格）。
- 提交信息格式（用户约定，不得更改）：
  ```text
  COMPLETED：<描述完成的任务>
  TODO：<描述待完成的任务>
  Refer Spec：<本次修改引用的 spec>；<本次所有决策引用的 spec 与决策记录文档>
  ```
- git 纪律：只 `git add` 显式路径、只提交本会话改动的文件；禁止 `git add -A`、`git reset --hard`、`git stash`、`git commit --no-verify`。

## 现状速览（所有任务共享的背景）

- 在线路径：`src/server.ts`（Fastify，`/v1/chat/completions` 两个分支：`stream:true` 走 raw OpenAI SSE 透传 + session 落盘；非流式走 `handleStream`）→ `src/proxy-handler.ts`（检索/注入/SSE 转换/toolCall 校验/session 落盘）。
- session 记录：`src/session-writer.ts`（pi-native v3 JSONL：header、message tree entry、custom entry）。
- 离线路径：`src/offline/scheduler.ts`（runDailyEvolution：ETL → pipeline → promote → dormant rescore → dormant cleanup → checkpoint）。
- Python vendored 管线：`python/skill_evolution/`、`python/sop_lifecycle/`、`python/verification_selection/`（均有 CLI，MockLLM 回退；真实 LLM 走 `LLM_BASE_URL` + `LLM_MODEL`/`TEACHER_MODEL` env）。
- 存储：`src/experience-store.ts`（better-sqlite3，experiences + FTS + checkpoints）。

---

## P3-1：真实 LLM 打分路径 live 验证

**预估：改动 ~50 行（文档 + 可能的小修复）；token ~80k。**

### 背景

三条 Python CLI 的真实 LLM 路径（`OpenAICompatClient` / `teacher_from_env`）在 P2 Task 7 修复了构造参数 bug，但只有代码审查与单测覆盖，从未用真实端点跑过。MockLLM 路径不能证明真实打分质量。

### 目标

用真实 OpenAI 兼容端点（本机 omlx 即可：`http://127.0.0.1:8000/v1`，api_key 见 `~/.omlx/settings.json`，模型 `gemma-4-12B-it-4bit`）跑通三条 CLI 与 `--rescore`，确认真实 LLM 路径无运行时错误、输出结构正确、分数有区分度。

### 步骤

1. 环境：确认 omlx 在 8000 运行（`curl -H "Authorization: Bearer <key>" http://127.0.0.1:8000/v1/models`）。
2. 构造小输入：2-3 条 trajectories.json / candidates.json（参照 `python/*/pipeline.py` CLI 注释的输入契约）。
3. 设 `LLM_BASE_URL=http://127.0.0.1:8000/v1`、`LLM_MODEL=gemma-4-12B-it-4bit`、`TEACHER_MODEL=gemma-4-12B-it-4bit`，依次跑：
   - `PYTHONPATH=python python3 -m verification_selection.pipeline --input ... --output ...`
   - `PYTHONPATH=python python3 -m verification_selection.pipeline --rescore --input ... --output ...`
   - `PYTHONPATH=python python3 -m sop_lifecycle --input ... --output ...`
   - `PYTHONPATH=python python3 -m skill_evolution.pipeline --input ... --output ... --benchmark packages/agent-server/benchmark/benchmark.example.json`
4. 记录每条命令的输出结构、耗时、失败堆栈；有 bug 就修（最小修复 + 测试）。
5. 产出验证文档 ` design/<date>-agent-server-p3-real-llm-verification.md`。

### 验收

- 四条 CLI 真实 LLM 路径退出码 0，输出 JSON 结构符合各自契约。
- 发现的所有运行时 bug 已修复并有对应测试；全套 vitest 仍通过，`npm run check` 干净。
- 验证文档含每条命令的完整命令行、输出摘要、结论。

### 注意

- omlx api_key 是本机密钥：命令行可用，但不要写进入库文件（文档中脱敏）。
- 真实 LLM 调用慢且可能超时：CLI 调用加足 timeout，样本保持 2-3 条。

---

## P3-2：benchmark 自动从 session 派生

**预估：改动 ~400 行；token ~200k。**

### 背景

P2 Task 5 接入的 benchmark 是用户手工维护的 JSON（`benchmark/benchmark.example.json`，契约见 `python/skill_evolution/pipeline.py` CLI 注释：`{initial_skill, samples:[{id, concept, question, solvable?}], iterations?}`）。手工维护不可持续——skill 进化的训练任务集应能从历史会话自动派生。

### 目标

新增一个派生器：从 `var/sessions/*.jsonl`（或 ETL 产出的 dormant EVIDENCE 候选）生成 benchmark.json，并提供 CLI/脚本入口；`runDailyEvolution` 在未显式配置 benchmark 时可选用派生结果（**这是一个需要用户拍板的行为决策**，见下）。

### 要求

1. 新模块 `src/offline/benchmark.ts`（或 `scripts/` 下脚本，二选一并在决策记录中说明理由）：
   - 输入：session 目录；输出：benchmark.json（符合上述契约）。
   - `question`：取 session 首个 user 消息文本（ETL 已有同款提取逻辑，见 `src/offline/pipeline.ts` 的 `collectTrajectories`/`parseSessionFile`）。
   - `concept`：从 question/回复中抽取关键概念（规则化即可——如提取主题词/技术名词；**不要用 LLM**，保持离线确定性，理由写进决策记录）。
   - `solvable`：默认 true；有明确失败信号的 session（error custom entry、无 assistant message）置 false 或跳过。
   - 去重（同 question 不重复入样）、上限（如 50 条，参数可调）。
2. 接线决策（**先问用户再动手**）：(a) 仅生成文件，仍由用户显式配置 `AGENT_SERVER_BENCHMARK`；(b) 未配置时 scheduler 自动派生。默认建议 (a)，(b) 会改变离线运行行为。
3. 测试：fixture session 文件 → 输出 benchmark 的结构/去重/上限/solvable 判定；空目录输出空 samples。
4. 端到端：用派生的 benchmark 跑一次 `runDailyEvolution`（MockLLM），确认 skill 管线消费正常。

### 验收

- 全套 vitest 通过 + `npm run check` 干净。
- 派生的 benchmark.json 能驱动 skill_evolution pipeline 产出非空结果（MockLLM 下验证链路，不证明增益）。

---

## P3-3：流式路径 toolCall 出站校验

**预估：改动 ~250 行；token ~150k。**

### 背景

`handleStream`（非流式）用 `validateToolCallStream`（`src/toolcall-validator.ts`）对模型输出 toolCall 做出站校验（对照注入后的 tools 列表，含 SOP schema）。但 `server.ts` 的 `stream:true` 分支（Kimi Code 实际走的路径）是 raw OpenAI SSE 裸透传，**不过任何校验**——模型若编造 SOP 工具或乱造参数，客户端会直接执行。

### 目标

流式分支对 OpenAI SSE chunk 中的 `delta.tool_calls` 做校验，行为与 `validateToolCallStream` 的语义对齐（对照注入后 tools 白名单 + 参数 JSON 合法性）。

### 关键设计决策（**先问用户再动手**）

raw SSE 透传契约不能像 handleStream 那样重写事件流。两种方案：

- **方案 A（observe-only，推荐）**：tee 中解析并累积 tool_calls，校验结果记录到 session（新 custom entry，如 `toolcall_validation`）+ stderr 日志；违规不阻断转发。优点：契约零风险；缺点：客户端仍会执行坏 toolCall。
- **方案 B（阻断式）**：缓存含 tool_calls 的尾部 chunk，流末组装校验，违规时改发错误 chunk/截断。优点：真正拦截；缺点：改动 SSE 字节流，时序复杂，客户端兼容性风险。

推荐 A 起步，B 作为后续增强；若用户选 B，需补充分的 Kimi 端兼容性测试。

### 要求

1. 复用 `toolcall-validator.ts` 的校验逻辑（tool 白名单、参数 schema 校验），不要复制实现；如需要，把可复用部分提取成对两种事件形态（pi-ai StreamEvent / OpenAI chunk）都适用的核心函数。
2. 校验上下文：`buildInjection` 返回的 injected.tools（与非流式路径同一白名单来源）。
3. 测试（`test/server.test.ts`）：合法 tool_calls 透传且记录校验通过；未知工具名/非法参数被记录为违规（方案 A）或拦截（方案 B）；多 tool_calls 按 index 组装的边界。
4. 更新 `src/server.ts` 流式分支注释与 P2 文档中"裸透传"的描述。

### 验收

- 全套 vitest 通过 + `npm run check` 干净。
- live 冒烟：Kimi 流式请求正常（校验不改变正常路径字节）。

---

## P3-4：agent-server package 级 tsconfig 解析修复

**预估：改动 ~20 行；token ~40k。**

### 背景

`packages/agent-server/tsconfig.json` 直接 `extends ../../tsconfig.base.json` 且 `moduleResolution: Bundler`，但缺少根 `tsconfig.json` 里的 `paths` 映射（`@earendil-works/*` → `packages/*/src`）。在包目录下跑 `tsgo --noEmit` 报 15+ 个错误（TS2307 `Cannot find module '@earendil-works/pi-ai'` 及连带 TS7006/TS2339）。根目录 `npm run check` 的 tsgo 用根 config 是干净的，所以这是包级开发体验问题（IDE/包内命令报错）。

### 目标

包目录下 `../../node_modules/.bin/tsgo --noEmit` 干净，且不破坏根 config 与 vitest/tsx 运行。

### 要求

1. 先读根 `tsconfig.json`（第 7 行起有 `paths` 映射）与 `tsconfig.base.json`。已核实：**其他包（agent/ai/coding-agent/tui/orchestrator）都没有 package 级 tsconfig.json**，agent-server 是唯一有的——所以两条路：(a) 给 agent-server/tsconfig.json 补上与根一致的 `baseUrl`/`paths` 映射；(b) 直接删除该文件让根 config 统一管理。先确认该文件是否被某处引用（`grep -rn "tsconfig" packages/agent-server --include='*.json' --include='*.ts' | grep -v node_modules`、根 package.json scripts、vitest.config.ts），无引用则 (b) 更简；有引用则 (a)。选择写进决策记录。
2. 修复后验证：包级 tsgo 干净；根 `npm run check` 干净；agent-server 全套 vitest 通过。
3. 若发现错误里有真实代码问题（被 paths 缺失掩盖的类型错误），一并修掉并在决策记录中说明。

### 验收

- `cd packages/agent-server && ../../node_modules/.bin/tsgo --noEmit` 退出码 0。
- 根 `npm run check` 干净，148+ 测试不 regress。

---

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 依赖 |
|---|---|---|---|
| P3-1 真实 LLM live 验证 | ~50 | ~80k | 无（需本机 omlx 环境） |
| P3-2 benchmark 自动派生 | ~400 | ~200k | 有一个行为决策需用户拍板 |
| P3-3 流式 toolCall 校验 | ~250 | ~150k | 有一个方案决策需用户拍板（推荐 A） |
| P3-4 tsconfig 修复 | ~20 | ~40k | 无 |
| **合计** | **~720 行 / 4 提交** | **~470k** | P3-1 与 P3-4 可立即并行；P3-2/P3-3 待决策 |

估算口径同 P2（subagent 上下文装载 + 实现 + 评审 + 修复 + 决策文档）。

## 分发建议

- P3-4 最小、无依赖，适合作为第一个分发的任务验证流程。
- P3-1 依赖本机 omlx 环境（含密钥），只能分给能在本机执行的 agent。
- P3-2 与 P3-3 各有一个悬而未决的决策点，分发前请用户先拍板（任务书中已标注推荐方案）。
