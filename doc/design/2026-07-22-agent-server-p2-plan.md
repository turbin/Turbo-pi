# Agent Server P2 开发方案（任务划分 + token 评估）——已执行完毕存档

> 存档说明：本方案于 2026-07-22 在 plan mode 批准，同日全部 8 个任务执行完毕（11 个提交）。
> 执行结果见 `doc/design/2026-07-22-agent-server-p2-closeout.md`；各任务决策记录见
> `doc/design/2026-07-22-agent-server-p2-task{1..7}-*-changes-and-decisions.md`。

来源：`doc/design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` 的 P2 立项事项（5 项）+ 低优先级 follow-up 清单。

## 已确认的方向决策

| 事项 | 决策 | 依据 |
|---|---|---|
| dormant ETL 闭环 | **完整接线**（用户确认）：dormant 行送入重评分（Python `verification_selection` TwoStageScorer），retrieval 加 status 过滤，dormant 行定期清理 | 补齐 spec §5.2 闭环 |
| custom_message | **实现**（用户未作答，按推荐）：session JSONL 增加注入后消息条目，重放反映模型真实上下文 | finding 23 |
| benchmark 接线 | **手动文件 + 接线**（用户未作答，按推荐）：benchmark.json 用户维护，经 env/配置接入 scheduler → pipeline `--benchmark` | Python 侧 CLI 已支持，接线量最小 |

## 提交约束

- 每个任务 = 1 个提交（实现 + 测试 + 决策记录文档），单提交预估 80–800 行，全部远低于 3000 行审阅上限。
- 提交信息沿用用户约定格式（COMPLETED/TODO/Refer Spec），决策记录落 `doc/design/<date>-agent-server-p2-task<N>-*.md`。
- 执行方式沿用 P1：subagent-driven（实现 → 评审 → 修复循环），最终整体评审一次。
- 环境注意：node 命令须用 arm64 Node ≥ 22。

## 任务划分（按依赖排序）

### Phase 0 — 基础修复（先行，后续任务依赖）

**Task 1：server.ts 遗留清理**
- 移除 `/v1/chat/completions` 的 `/tmp/agent-server-request.json` 落盘（或加 `AGENT_SERVER_DEBUG_DUMP` 开关，默认关）；消除 4 处 inline `await import()` 改为顶层 import。
- 文件：`src/server.ts`，必要时补测试断言 debug dump 默认关闭。
- 预估：改动 ~40 行；token ~60k。

**Task 2：retrieval status 过滤 + content_hash 索引**
- `ExperienceStore.search` SQL 加 `AND e.status = 'active'`，止住 dormant 行污染 FTS top-24；schema 加 `idx_exp_content_hash` 索引（follow-up 项提前，Task 6 依赖它做 O(1) 查询）。
- 补测试：dormant 行不出现在 retrieve 结果。
- 文件：`src/experience-store.ts`、`test/experience-store.test.ts`/`test/retrieval.test.ts`。
- 预估：改动 ~50 行；token ~50k。

### Phase 1 — 在线路径（session 记录完整性）

**Task 3：流式路径 session JSONL 落盘**
- `/v1/chat/completions` 的 `stream:true` 分支是裸转发 raw OpenAI SSE，不写 session。方案：保持 raw OpenAI SSE 转发契约不变，在转发 tee 中解析 OpenAI SSE chunk，复用 SessionWriter 记录请求消息 + 重建 assistant message。
- 文件：`src/server.ts`、`src/session-writer.ts`、`test/session-writer.test.ts`、`test/server.test.ts`。
- 预估：改动 ~250 行；token ~120k。

**Task 4：custom_message 实现**
- proxy-handler 在注入后写一条 `custom_message` 条目（注入后的 messages + 注入 payload 摘要），与既有 `experience_injection` 条目并列；更新 SessionWriter 文档注释与 spec §6 记录格式说明。
- 文件：`src/proxy-handler.ts`、`src/session-writer.ts`、`test/proxy-handler.test.ts`。
- 预估：改动 ~120 行；token ~80k。

### Phase 2 — 离线管线闭环

**Task 5：benchmark 接线（手动文件 + 配置接入）**
- `runDailyEvolution` 增加 `benchmarkPath` 选项，默认取 `AGENT_SERVER_BENCHMARK` env；透传到 `runOfflinePipeline` 的既有 `benchmarkPath` 参数。
- 提供 benchmark.json 样例 + 文档说明格式。
- 补测试：scheduler 透传 env/option 到 pipelineFn。
- 文件：`src/offline/scheduler.ts`、`test/offline/scheduler.test.ts`、文档。
- 预估：改动 ~100 行；token ~70k。

**Task 6：dormant 完整闭环（P2 最大任务）**
- Python 侧：`verification_selection.pipeline` CLI 新增 `--rescore` 模式。
- TS 侧：`runDailyEvolution` 插入 rescore 步骤：`listDormant` → 写 candidates JSON → spawn rescore → 复用 `verifyAndCanonicalize` 晋升/保留。
- dormant 清理：TTL 或行数上限。
- 文件：`python/verification_selection/pipeline.py`、`src/offline/scheduler.ts`、`src/offline/verifier.ts`、`src/experience-store.ts`、`src/offline/pipeline.ts`、`test/offline/*`、Python 侧测试。
- 预估：改动 ~600–800 行；token ~250k。

### Phase 3 — 收尾

**Task 7：低优先级 follow-up 批量清理**
- checkpoint hash 分隔符 + 幂等；promoteStagedOutputs 缺失文件明确报错；SessionWriter 零内容守卫 + 路径复用保护；readJsonArray 错误带路径；测试临时目录清理；toOpenAIMessage 签名放宽；ETL 测试补充；spec §6 JSONL 示例更新为 v3。
- 预估：改动 ~300 行；token ~120k。

**Task 8：P2 live E2E 验证 + closeout**
- 起 server，Kimi Code 走流式路径验证 session 落盘 + custom_message；手动跑 `runDailyEvolution` 验证 dormant rescore/promotion/清理与 benchmark 透传；全套测试 + `npm run check`。
- 产出 live 验证文档与 P2 closeout。
- 预估：改动 ~150 行（文档为主）；token ~100k。

## token 用量评估汇总

| 任务 | 预估行数 | 预估 token | 实际提交行数（存档补充） |
|---|---|---|---|
| Task 1 server.ts 清理 | ~40 | ~60k | 100 |
| Task 2 retrieval 过滤+索引 | ~50 | ~50k | 44（+回归修复 30） |
| Task 3 流式 session 落盘 | ~250 | ~120k | 571 |
| Task 4 custom_message | ~120 | ~80k | 66 |
| Task 5 benchmark 接线 | ~100 | ~70k | ~120 |
| Task 6 dormant 闭环 | ~700 | ~250k | 583 |
| Task 7 follow-up 清理 | ~300 | ~120k | 419 |
| Task 8 E2E + closeout | ~150 | ~100k | 文档 2 篇 |
| **合计** | **~1700 行 / 8 提交** | **~850k** | **~1900 行 / 11 提交** |

估算口径：每任务含 subagent 上下文装载（读相关代码 ~10-20k）、实现、独立评审、修复、决策文档；Task 6 因跨 Python/TS 双侧加倍。

## 执行顺序与并行性

- 严格顺序：Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8（Task 6 依赖 Task 2 的索引与过滤；Task 8 收尾依赖全部）。
- Task 3/4 与 Task 5 文件不重叠，如需压缩周期可两个 subagent 并行；默认串行保质量。

## 验证

- 每任务：`node ../../node_modules/vitest/dist/cli.js --run <相关测试>` 通过 + `npm run check` 干净。
- Task 8：live E2E（Kimi Code 流式 + 离线 evolution 手动触发）。

## 存档备注（实际执行与方案的偏差）

- Task 2 的 status 过滤引入 ETL 测试回归（测试误用 search 断言 dormant 行），以独立小提交修复并新增 `listDormant`。
- Task 1 同类问题漏网一处：`gateway-client.ts` 的 `/tmp/gateway-request.json` 无条件落盘，live 验证前补上同一开关。
- Task 1 新增测试未传 sessionDir，污染仓库 `var/sessions`，以独立小提交修复。
- 环境变化：nvm 不复存在，改用 Homebrew Node v25.9.0；better-sqlite3 需 rebuild（Node 25 无预编译产物）。
