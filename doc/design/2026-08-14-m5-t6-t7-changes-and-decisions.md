# M5（T6+T7）开发决策记录：台账 quick wins 四项 + 交叉评估臂 harness

日期：2026-08-14
状态：**已实施，测试全绿（TS 338 + Python 89 + eval 81 + gateway 185）**
依据：`plans/2026-08-14-post-c-unified-fix-batch-plan.md` v5（§5 台账表、§6 裁决 5）；`plans/2026-08-14-fix-batch-dev-tasks.md`（T6/T7 行）；`plans/2026-08-14-plan-library-version-cross-eval.md`（T7 设计全文）

## T6：台账 quick wins 四项

### 1. TDD 过程记录（先红后绿）

- **gateway pytest**（6 例新 + 3 例旧契约更新）：先写断言后实现——marker trace_id 三路径（升级/未升级/SSE 注释）首跑 3 红；DLP tools[] 两例 + 身份证号一例首跑 3 红；旧断言（marker 精确 dict）2+1 处随新契约更新（trace_id 是台账 2 的契约本体，非可选项）。
- **agent-server vitest**（`test/gateway-marker-trace.test.ts` 1 例 + `test/offline/etl-completeness.test.ts` 5 例）：handleStream 路径 gateway_marker 会话条目首跑红（此前该路径不写独立 marker 条目——仅 /v1 流式内联路径写，两条路径契约不一致）；ETL 完整性五例全红（半截隔离/闭合摄入/error 闭合/legacy 无信号/混合批次）。
- **eval pytest**（`test_snapshot_store.py` 4 例 + `test_campaign_cross.py` 7 例）：首跑收集期 ImportError 全红（新模块/新函数不存在）。
- 既有测试更新：etl.test.ts 8 处（EtlResult 解构 + 首个 fixture 补 response_completed 闭合标记）、domain-tagging.test.ts 3 处（fixture 补闭合）、scheduler.test.ts（etlFn fake 形态 + fixture 闭合）、attribution-confidence.test.ts（fake 形态）。

### 2. 设计决策

**T6-1（台账 2）GatewayMarker.trace_id 必选字段 + 消费侧双路径对齐**：gateway 四处构造点全部线程化 trace_id（升级/未升级/SSE 路径——响应 id chatcmpl-* 即 trace_id，跨库对账键）；agent-server 消费侧：/v1 流式内联路径已有 gateway_marker 条目，**handleStream 路径（/api/stream 与 /v1 非流式共用）补写**（done 事件的 x_gateway → gateway_marker custom entry）——双路径契约一致，session 归档与 gateway model_runs 逐请求对账成立。

**T6-2（台账 7）ETL 完整性校验 = 流闭合标记判据**：pi-native session 有头 + response_completed/error/aborted 闭合标记 = 完整；**有头无闭合 = 半截（落盘中断），整体隔离**（`EtlResult.isolated` 上报，scheduler 快照增 etlIsolated 计数）；无头文件（legacy P0 格式）无完整性信号，维持现状摄入；行级 malformed 跳过语义不变。error/aborted 闭合的 session 仍摄入（stream parts 照常挖矿——既有语义保留，完整性≠成功）。

**T6-3（台账 3 + 裁决 5）DLP tools[] + 身份证号默认**：scan_envelope 扩扫 `tools[i].function.description` 与 `parameters`（JSON 序列化文本）——SOP schema 经 tools 出网，是消息文本之外的盲区；DEFAULT_DLP_PATTERNS 增 `chinese_id_number`（`\b\d{17}[\dXx]\b`，18 位）；配置化机制已存在（config.security.dlp_patterns 合并覆盖，追加即生效）——本批次文档化（dlp.py docstring），不改配置机制。

**T6-4（台账 4）快照留存 + 回滚 runbook**：snapshot_store.py 新增每日快照模式 `--snapshots-dir <dir> [--retain N]`（N 预注册默认 7，时间戳命名，按名序剪枝；非快照文件不动）；legacy 双参模式保留；docstring 增回滚 runbook 三步（冻结回滚/整库回滚/验证）——"回滚到昨日 active 集"可执行。

## T7：交叉评估臂 harness

### 1. TDD 过程记录

`eval/tests/test_campaign_cross.py` 7 例（先红后绿）：臂常量与库/注入映射、预注册差分公式（库演进 X2−X1 / 注入 X1−X4 / sanity X3−X4）、每日一致性、sanity 零差 ok、sanity 超差报非零、缺臂报错、四臂计划 = 重复集 20 任务一致集。campaign.py 改动（--arms/--frozen-base-url/--metrics 交叉核算）由 dry-run + 合成 metrics 冒烟验证。

### 2. 设计决策

**T7-1 四臂落点 = campaign.py 扩展（不改 agent-server）**：`--arms x1,x2,x3,x4` 模式每臂跑当日重复集（20 任务）；冻结臂（X1/X4）走 `--frozen-base-url`（缺省回退 AGENT_SERVER，真实跑批必须显式指定加载 D1 快照的实例——"全程不换载"由实例级快照加载保证，M10 机制已备）；注入按臂定义 body 级开关；run.jsonl 行附 `library: frozen|daily` 维度。旧双臂行为（--arms 缺省）完全不变。

> **修正声明（2026-08-14，m5-test-review 缺陷-1 打回修复）**：初版实现三处断裂，--arms 跑批回路不可用——① row 写入引用未定义的 `library`（首个任务落库即 NameError）；② `injection=arm=="experiment"` 对 x1..x4 恒 False，四臂注入全关（2×2 注入维度失效）；③ `client_frozen` 创建后从未使用，X1/X4 实际跑当日库（锁库不换载未落地）。已修复：按臂取值接线（ARM_LIBRARY/ARM_INJECTION 消费、冻结臂走 client_frozen、library 落库）。**教训**：dry-run 与 --metrics 冒烟均在跑批回路之前返回，不能作为回路可用性证据——pi-test 补测 `test_campaign_cross_wiring.py`（3 例，mocked 端到端驱动 campaign.main() 真实 --arms 回路）随修复转绿并永久保留，今后作为 T7 最小回路冒烟。修复后全量：TS 338 / Python 89 / eval 84 / gateway 185 全绿。

**T7-2 差分核算 = campaign_cross.py 纯函数**：差分口径预注册进模块 docstring（库演进 X2−X1、即时注入 X1−X4、sanity X3−X4、C 阶段 +10.3pp 对应量分解）；样本单位 = 任务日配对设计（同任务跨臂同日差分，消除任务难度方差）；**n=20 功效声明**（红线 6）：单任务 = 5pp，小样本不报显著性，差分以均值差呈现、结论以全量落库为准；sanity 容差 SANITY_TOLERANCE=0.05 预注册（超差报"未建模混淆"哨兵）。

**T7-3 范围边界**：只交付 harness 能力 + 冒烟（dry-run/合成 metrics），不跑真实 campaign（9B pilot 后用户确认排期）；office 先行顺序约束沿用（方案原文），ALFWorld 臂另行报备。

## 测试与检查结果

- TS：`packages/agent-server` 全包 **338 通过**（35 文件；新增 gateway-marker-trace 1 例 + etl-completeness 5 例；既有 ETL/scheduler/domain 测试契约更新）；Node 25 经 `scripts/with-node25.sh`。
- Python：`python/tests/` **89 通过**（未受影响）；eval `tests/` **81 通过**（新增 test_snapshot_store 4 例 + test_campaign_cross 7 例）。
- gateway：`uv run pytest` **185 通过**（新增 marker trace_id 3 例 + DLP 4 例；3 处旧断言随契约更新）。
- 冒烟：四臂 dry-run（--day 3 --arms x1,x2,x3,x4 → 四臂各 20 任务）；合成 metrics 交叉核算（库演进 0.10 / 注入 0.15 / sanity 0.0 ok）。
- `npx tsgo --noEmit` 0 错误；biome 0 问题（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/browser-smoke 全过。
- 唯一 check 失败项：`check:pinned-deps`（pre-existing，eval/results 工件，M1-M4 同口径）。

## 边界与遗留风险

1. **T7 真实跑批依赖双实例部署**（冻结快照实例 + 当日实例）：runbook 化在决策记录/快照 docstring，真实排期需 9B pilot 后用户确认。
2. **trace_id 对账键的旧数据缺口**：改造前的 x-gateway marker 无 trace_id——历史 session 条目无法与新口径对账（不回填，声明即可）。
3. **ETL 完整性判据的 legacy 盲区**：无头文件（P0 格式）无完整性信号仍摄入——半截 legacy 文件理论上漏网（现役无该格式新数据，接受）。
4. **DLP tools 扫描的误报面**：parameters schema 的 JSON 序列化文本含 20+ 字符的样例值可能误中 api_key 模式——DLP 只拦截不泄露（findings 仅模式名+位置），误报代价为阻断，方向安全。
5. **sanity 容差 0.05 是预注册启发值**：无历史分布校准，超差解释义务在跑批报告（方案验收口径）。
6. **未 commit**（纪律）；docx/conversations/assets 未触碰。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§5 台账、§6-5）；plans/2026-08-14-fix-batch-dev-tasks.md（T6/T7）；plans/2026-08-14-plan-library-version-cross-eval.md；doc/design/2026-08-13-agent-server-high-level-design-v2.md（§7 台账）
