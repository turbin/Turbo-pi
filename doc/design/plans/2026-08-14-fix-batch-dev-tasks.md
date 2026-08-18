# C 后统一修复批次：开发任务拆分与里程碑计划

日期：2026-08-14
状态：**已批准方向（用户 08-14 指令），M1 启动**
依据：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（下称"方案"）；用户指令：变更 ≤3000 行/任务、TDD、pi agent 双人组（1 开发 + 1 测试）、里程碑处主会话 review 把关、全部完成后 push 再开实验。

## 1. 任务拆分（全部任务预估变更均 <3000 行，满足硬约束）

| 任务 | 内容 | 涉及文件（主） | 预估变更行 | 依赖 |
|---|---|---|---|---|
| **T0** | F0 归因数据通道：requestId→randomUUID；buildInjection 返回并落 injected_ids；task_id 透传（campaign.py→/v1→session 头→request_traces 新列）；/api/stream 路径处置（定案写决策记录）；issue-013 回归测试 | agent-server src/server.ts、proxy-handler.ts、injection.ts、experience-store.ts、types.ts；eval/campaign.py；test/regressions/issue-013-* | ~400 | 无 |
| **T1** | 最小断点：打分阶段产物落盘（staged JSON 已有，补打分中间结果）+ `--resume <run_dir>` 跳过已完成打分；输入哈希防脏复用；回归测试（模拟阶段崩溃→resume 仅重跑该阶段） | agent-server python/verification_selection（双副本 llm_client 同步）、offline/run-evolution.ts CLI | ~300 | 无 |
| **T2** | F1 卡片交付物：EXTRACTION_PROMPT 加交付物维度；CARD_SCHEMA required 加 deliverables；cardsToStaged 映射；Python 打分侧无交付封顶 <0.5；TS verifier 二次校验；SOP/SKILL/EVIDENCE 豁免；存量卡重蒸脚本；TS+Python 双侧回归测试 | python/verification_selection/{pipeline.py,experience.py}、src/offline/verifier.ts、test/regressions/issue-010-*、python/tests/ | ~500 | T0 |
| **T3** | F2 归因奖惩：injected_ids×分数关联表（离线）；confidence 列迁移（ALTER+user_version+COALESCE 兼容+快照再生）；降权（confidence→retrieval 排序加权）；≥3 独立任务阈值；复升排除（降权卡跳过复评 N 批）；首版不自动降级；回放验收脚本 | src/experience-store.ts、retrieval.ts、offline/pipeline.ts、scheduler.ts、eval/ 归因脚本、测试 | ~700 | T0、T2 |
| **T4** | F3 情景标签：payload 加 domain/task_pattern；蒸馏打标（元数据透传）；ETL 打标（复用 T0 task_id + 任务→域注册表）；在线 domain 通道（types/server/proxy-handler/retrieval + campaign.py）；检索域过滤（无 domain 不过滤）；回归测试 | src/types.ts、server.ts、proxy-handler.ts、retrieval.ts、offline/etl.ts、python 蒸馏、eval/campaign.py、测试 | ~600 | T0、T2（重蒸顺带打标） |
| **T5** | F4 晋升统一：晋升闸升级为"可证伪验证闸"框架；SOP quality=1 直通改"预验证通过标记"；SKILL utility→可验证任务映射或暂缓入库（定案写决策记录）；红线 3 修订入 v2 设计文档；五类卡过闸/拦截/豁免测试 | src/offline/verifier.ts、python/sop_lifecycle、doc（红线修订）、测试 | ~400 | T2、T3 |
| **T6** | quick wins 四项：x-gateway marker 加 trace_id（gateway chat.py + agent-server 消费侧）；ETL session 完整性校验；DLP 扫 tools[] + 默认敏感列表（身份证号+密钥类，config 可扩充）；快照保留 N 份 + 回滚 runbook | agent-gateway api/chat.py、security/dlp.py；agent-server offline/etl.ts、eval/snapshot_store.py、测试 | ~500 | 无（搭车 M4/M5） |
| **T7** | 交叉臂 harness：campaign.py 两臂→四臂配置；冻结快照锁库（全程不换载）；差分核算脚本（库演进/即时注入/sanity 差分预注册口径） | eval/campaign.py、campaign_plan.py、campaign_metrics.py、eval/snapshot_store.py、测试 | ~400 | T0（口径数据）、T6 快照项 |

合计预估变更 ~3800 行（8 任务，单任务最大 ~700 行，远低于 3000 行硬约束）。

## 2. TDD 与双人组协议

**开发 agent（pi-dev）**：先写回归测试（红，断言目标行为）→ 实施（绿）→ 跑目标测试全绿 → 自跑 `npm run check`。不 commit。
**测试 agent（pi-test）**：独立于开发 agent 复核——全量跑 `./test.sh` 相关包 + 审计测试质量（断言是否真正覆盖机制、有无假绿）+ 补缺失用例；可改测试，不改实现（发现实现缺陷写报告打回）。
**主会话（我）**：里程碑门禁 review——diff 全读、AGENTS.md 合规（erasable syntax / biome / 无 any / 无 inline import）、测试独立复跑、与方案逐条对账。不合格 → 打回 pi-dev 附修复清单，直到通过。
**commit 纪律**：pi agent 一律不 commit；主会话在里程碑通过后按 COMPLETED/TODO/Refer Spec + conventional 前缀提交。

## 3. 里程碑与 token 估算

token 为粗估（输入+输出合计，含上下文读取与迭代；假设 dev 每任务 2-4 轮实现-测试迭代，test 每任务 1-2 轮）。实际随代码熟悉度上下浮动 ±50%。

| 里程碑 | 任务 | pi-dev 估 | pi-test 估 | 主会话 review 估 | 小计 |
|---|---|---|---|---|---|
| **M1** 数据通道 | T0+T1 | 300-500k | 120-200k | 40-60k | ~0.5-0.8M |
| **M2** 交付物维度 | T2 | 250-450k | 100-180k | 40-60k | ~0.4-0.7M |
| **M3** 归因奖惩 | T3 | 350-600k | 150-250k | 50-80k | ~0.6-0.9M |
| **M4** 标签+晋升统一 | T4+T5 | 400-700k | 180-300k | 60-90k | ~0.7-1.1M |
| **M5** quick wins+交叉臂 | T6+T7 | 350-600k | 150-250k | 50-80k | ~0.6-0.9M |
| 合计 | T0-T7 | 1.7-2.9M | 0.7-1.2M | 0.2-0.4M | **~2.8-4.4M** |

里程碑门禁（每个 M 必须全过才进下一个）：
1. 目标测试 + 相关包测试全绿（`./test.sh` 口径，e2e 不触发）
2. `npm run check` 干净（biome/tsgo/哨兵）
3. diff ≤3000 行/任务复核、无越权改动（omlx 不可动、改动仅限工程内）
4. 方案条目逐项对账（改动点清单 vs diff）
5. 决策记录文档随 commit

## 4. 执行顺序

M1（T0+T1）→ M2（T2）→ M3（T3）→ M4（T4+T5）→ M5（T6+T7）→ 全量验证 + push GitHub + 9B pilot → 实验。

环境约束（写入每个 pi 任务 prompt）：Node 25 走 `scripts/with-node25.sh`；agent-server 测试用 `node ../../node_modules/vitest/dist/cli.js --run <file>` 或 `./test.sh`；Python 侧 `cd packages/agent-server && uv run pytest python/tests/`（或现有 venv 惯例）；gateway 测试 `cd packages/agent-gateway && uv run pytest`；永不跑全量 e2e；不读不动 `.env`/auth 文件；omlx 不可动。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5；2026-08-14-fix-batch-user-rulings-changes-and-decisions.md；plans/2026-08-14-plan-library-version-cross-eval.md；AGENTS.md（通用约束）
