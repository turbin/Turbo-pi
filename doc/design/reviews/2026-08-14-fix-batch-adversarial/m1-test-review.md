# M1（T0+T1）测试 agent 独立复核报告

日期：2026-08-14
复核人：pi-test（测试/质量 agent，独立于 pi-dev 复核）
对象：M1 里程碑（T0 归因数据通道 + T1 最小断点），工作区未提交变更
结论：**打回**（1 项实现缺陷 + 2 项覆盖空洞，修复清单见 §8）

---

## 1. 全量测试独立复跑（不信开发方数字）

| 套件 | 开发方声明 | 独立复跑 | 判定 |
|---|---|---|---|
| TS `packages/agent-server`（vitest, Node 25 包装） | 279 通过 / 29 文件 | **279 通过 / 29 文件**（复跑在补测试之前） | 一致 |
| Python `python/tests/`（uv run pytest） | 38 通过 | **38 通过** | 一致 |
| eval `tests/`（eval/.venv pytest） | 54 通过 | **54 通过** | 一致 |

复跑环境：`scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run`（仓库根起，`--root packages/agent-server`）；Python 用 `uv run pytest`（python/tests/）与 `eval/.venv/bin/python -m pytest tests/`。无失败、无跳过。

补测试后终态（§5）：TS **283 通过 + 1 失败**（失败为缺陷证据测试，§4.1）；Python **41 通过**；eval 54 通过。

## 2. 测试质量审计（防假绿）

### 2.1 `test/regressions/issue-013-request-id-collision.test.ts`（7 例）

| # | 用例 | 断言强度 | 审计结论 |
|---|---|---|---|
| 1 | requestId 非计数器序列 | 强 | UUID 正则 + 两次不等 + 两行独立落库。仅"跨进程不碰撞"无法直接断言，但实现为 node:crypto randomUUID（代码核查），机制可信 |
| 2 | 两阶段 upsert 不覆写 retrieved/injected | **强** | 直接锁定 NULL 哨兵：若用 `COALESCE(excluded.injected_ids, …)` 绑定 `'[]'` 的错实现，phase-2 会把 `['exp-a']` 覆写成 `[]`，本例红。决策记录 T0-4 声称的缺陷确实被锁住 |
| 3 | 同 id 冲突阶段一字段首写（合并哨兵） | 中 | ts/model/retrievedIds 首写被断言；retrieved_kinds/hit 未断言（两次写入值相同，无区分度），可接受 |
| 4 | 真实链路 injected ⊆ retrieved | **弱** | **"把全部 retrieved id 当 injected_ids 记录"的错实现也能过**（子集断言天然成立）；top-5 截断、malformed 排除、SKILL/SOP 排除、无 user 消息 → [] 均未覆盖。已由补测 §5.1 关闭 |
| 5 | task_id 透传 + 可空 | 强 | trace 行 + session 头 metadata + 无 task_id 客户端读回 ""，三处断言齐全 |
| 6 | /api/stream 纳入落库 | **弱（且暴露缺陷）** | 只断言行存在 + hit/retrievedCount + taskId；**completion 阶段字段（finish_reason/tokens/latency）未断言——且当前实现确实永远为 NULL（§4.1 缺陷）** |
| 7 | 旧库迁移补列 + 安全默认值 | 强 | PRAGMA + ALTER 断言 + 旧行读回 `[]`/`""` + 新字段可写。已用真实 C 阶段库副本独立验证（§3.2） |

总体：7 例中 2 例强断言锁住核心机制（NULL 哨兵、迁移），1 例弱（#4）、1 例弱且掩盖缺陷（#6）。

### 2.2 `python/tests/test_issue002_pipeline_resume.py`（6 例）

- **崩溃模拟真实性**：通过。`CrashOnTask` 包装 `Verifier.score_pair` / `select_best`——异常注入点就在打分调用上（非加载/非落盘路径）；崩溃后 journal 只含已完成组（task-a），resume 仅补未完成组且调用数精确（6 = 2 组 × 3）。
- **脏复用拒绝（负例）**：有。`test_changed_trajectory_content_invalidates_cache` 改轨迹内容 → 该组重打、其余跳过，锁住"哈希即凭证"。
- **覆盖空洞**：prompt 指纹失效（G/K/标准变化 → 全量重打）无测试；`score_threshold` 不参与哈希（T1-2 决策）无测试；resume 指向不存在 run_dir 无显式测试。已由补测 §5.3 关闭（3 例全绿）。
- 半截行测试构造合理（"该 key 从未落盘 + 半截行"是真实崩溃现场形态）。

## 3. 机制核查

### 3.1 injected_ids 口径 vs injection.ts 实现 —— 一致

逐条对账决策记录 T0-2 与 `injection.ts` 实现：

- EVIDENCE：过滤（text 非空）后进池者全部入 injectedIds（不排序、不截断）✓
- Method/Guard：过滤 → quality 排序 → top-5 **之后**的 id（与内容组装同一集合）✓
- 无 blocks（全 malformed / 检索空）或无 user 消息可 splice → `[]` ✓
- SKILL/SOP 显式排除（catalog / tool schemas 独立通道）✓
- 对照臂（injection off）显式写 `[]`：`handleStream` 与 /v1 两处均为 `injectionOn ? injected.injectedIds : []` ✓

### 3.2 迁移兼容性 —— 实测通过（真实 C 库副本）

用 `backup/c-campaign-20260814/store/experience-c-final.db`（真实旧 schema，860 行）副本实测：

- initSchema 后自动补 `injected_ids` / `task_id` 列，860 行原样保留；旧行读回 `injected_ids='[]'`、`task_id=null`；`getHitRateStats` COALESCE 读回 `"[]"`/`""` ✓
- **快照 readonly 不被破坏**：以原库为 `snapshotPath` 打开（`readonly: true`），initSchema + search 后原文件 mtime 不变、`PRAGMA table_info` 无新列 ✓（search/listActive 走 readDb 且 SQL 不引用新列，代码核查一致）
- 新库（CREATE TABLE 含新列）路径：PRAGMA 检查双列存在 → 无 ALTER ✓

### 3.3 task_id 不带时生产路径不变 —— 通过

- /v1：`body.task_id` 缺失 → taskId undefined → 不写入 metadata/trace（测试 5 断言读回 ""）✓
- /api/stream：`body.taskId` 同样处理（测试 6 带 taskId；不带时与 /v1 同一解析/COALESCE 模式，按构造等价）✓
- task_id 只进 metadata/trace 行，`toGatewayRequest` 不透传（grep 核查）✓
- campaign.py `run_agent` task_id 为必选 kwarg：仓库内全部调用点（main + 4 处测试）已更新，无遗漏 ✓

### 3.4 --resume 对不存在/损坏 run_dir —— 通过

- 不存在：TS `cmdRun` `mkdirSync(recursive)` 后当全新目录全量重打（决策边界 4）；Python `ScoreJournal.load()` 对缺失文件返回 `{}`。补测 §5.3 显式锁定（红→绿确认）
- 损坏（半截行）：dev 测试 4 覆盖，该 key 视为未完成重打 ✓
- `--resume` 缺参数：CLI 打印 usage 并 exit 2（代码核查）✓

## 4. 发现的实现缺陷

### 4.1 【缺陷-1】/api/stream trace 行缺 completion 阶段（两阶段契约不完整）

**证据**（红测试 `test/regressions/issue-013-stream-completion-phase.test.ts`，对当前实现失败）：

- `handleStream`（proxy-handler.ts）只写阶段一（检索，L76）与阶段一点五（注入集，L105），**从不写阶段二**（finish_reason/prompt_tokens/completion_tokens/latency_ms）；`grep recordRequestTrace src/` 显示 proxy-handler 内无任何 completion 写入。
- /v1 两个入口都有阶段二（streaming 走 `traceStreamCompletion`，非 streaming 走 server.ts L426；`test/server.test.ts:456` 断言 finishReason "stop" + tokens）。
- 后果：/api/stream（pi 原生路径）的 trace 行这三列**永远为 NULL**，stats/hit-rate 看板对原生路径无 latency/token 可观测性。
- 与决策记录 T0-6 冲突：其理由 2 声称"与 /v1 同契约"、理由 3 声称"handleStream 已有完整检索字段与**两阶段 upsert**，仅需传入 requestId"——"两阶段"在 handleStream 上不成立（F0 前该路径连阶段一都不写，此缺陷是 F0 带入的契约声明失真）。
- 修复成本：teeWithSessionClose 的 closeWriter 处补一条 recordRequestTrace（done 事件已带 reason + usage），与 traceStreamCompletion 同模式。

**处置建议**：代码修复（补阶段二）优先；若裁决豁免，必须修订决策记录 T0-6 声明并删除红测试。

## 5. 补测试清单（本复核新增）

| 文件 | 用例 | 跑测结果 |
|---|---|---|
| `test/regressions/issue-013-injected-ids-granularity.test.ts`（新） | 4 例：top-5 截断精确集合（3 证据 + 5 Method + 5 Guard，截断 6 个不入集，长度 < 19）；SKILL/SOP 排除；malformed 排除；无 user 消息/全 malformed/空检索 → `[]` | **全绿**（锁定 T0-2 口径，堵住 §2.1 弱断言 #4） |
| `test/regressions/issue-013-stream-completion-phase.test.ts`（新） | 1 例：/api/stream 完成后 trace 行必须带 finishReason/promptTokens/completionTokens/latencyMs | **红**（缺陷-1 证据，修复后转绿） |
| `python/tests/test_issue002_resume_fingerprint.py`（新） | 3 例：prompt 指纹变化（G 5→8）全量失效且与全新跑逐位一致、journal 不翻倍；score_threshold 不参与哈希（换阈值零调用、accepted 重算）；resume 不存在 run_dir 全量重打不报错 | **全绿** |

补测后计数：TS 283 通过 + 1 失败（缺陷证据），Python 41 通过，eval 54 通过。新增 TS 文件通过 biome（`npm run check` 口径）。

## 6. npm run check 复跑

- biome：干净（1 条 info 级 lint 在 `test/web-monitor.test.ts:107`，**不在本批次 diff 内**，pre-existing，不阻断）
- check:ts-imports / check:shrinkwrap / check:install-lock:coding-agent / tsgo --noEmit（0 错误）/ check:browser-smoke：**全部通过**
- **check:pinned-deps：失败**（138 条 "must be pinned"），全部位于 `packages/agent-server/eval/results/`（gitignore 的 C 阶段 campaign 工件，非本批次变更文件）——与决策记录 §3-6 声明一致，确认为 pre-existing，与本变更无关，不修

## 7. 总体结论

**门禁：打回**（M1 目标测试本身全绿、check 除 pre-existing 项全干净、diff 448 行远低于 3000 行约束、无越权改动——但存在 1 项实现缺陷与决策记录声明冲突，且 2 处测试覆盖空洞由本复核补齐后暴露该缺陷）。

### 打回清单（pi-dev 修复后本复核复跑确认）

1. **缺陷-1（必改）**：`handleStream` 补 /api/stream 阶段二 completion 记录（finish_reason/tokens/latency），使红测试 `issue-013-stream-completion-phase.test.ts` 转绿；或经主会话裁决豁免并修订决策记录 T0-6（此时删除红测试）。
2. **补测保留**：`issue-013-injected-ids-granularity.test.ts`（4 例，当前已绿，锁定口径）、`test_issue002_resume_fingerprint.py`（3 例，已绿）随修复一并合入，作为 issue-013/issue-002 回归测试的永久组成部分。
3. 修复后需全量复跑（TS 284 全绿、Python 41、eval 54）并复跑 `npm run check`。

### 复核通过项（无需返工）

- requestId→randomUUID、NULL 哨兵 upsert、task_id 透传链、旧库迁移 + 快照 readonly 语义、injected_ids 口径实现、--resume 幂等与哈希防脏复用、TS/Python 断点机制——机制核查全部通过（§3），核心机制测试断言强度合格（§2.1 #1/#2/#5/#7、§2.2）。

Refer Spec：plans/2026-08-14-fix-batch-dev-tasks.md（T0/T1、§2 双人组协议）；doc/design/2026-08-14-m1-t0-t1-changes-and-decisions.md；doc/issues-snapshot/issue-013-request-id-collision-trace-merge.md
