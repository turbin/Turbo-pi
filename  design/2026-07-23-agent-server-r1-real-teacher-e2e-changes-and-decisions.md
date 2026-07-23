# R1：真实 LLM teacher 全链路 E2E 验证 —— 决策记录

日期：2026-07-23
任务书：` design/2026-07-23-agent-server-r-real-teacher-tasks.md` R1
性质：纯验证（零代码改动）

## 验证环境

- omlx 127.0.0.1:8000，模型 `gemma-4-12B-it-4bit`（api_key 取自 gateway `config.toml` 的 omlx provider 配置，不落本文档）
- 命令（从 `packages/agent-server`）：
  ```bash
  EXPERIENCE_STORE_PATH=./var/experience.db AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json \
  PYTHONPATH=python LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=gemma-4-12B-it-4bit \
  TEACHER_MODEL=gemma-4-12B-it-4bit LLM_API_KEY=<omlx key> \
  ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts
  ```
- 运行前备份：`var/experience.db.r1-pre-real-teacher-backup`（与任务书约定一致）

## 逐 stage 结果

总耗时 **2m31s**（exit 0）。staged 输出文件（cards/skills/sops.json）在运行开始后约 2 分钟写入，即 stage 2（Python 三管线，真实 LLM 调用集中在此）约占全程主体；其余 stage 均为本地 SQLite 操作，秒级。

| stage | 结果 | 说明 |
|---|---|---|
| 1 ETL | etlInserted=0 | 5 个 session 均已处理过，contentHash 幂等去重正确 |
| 2 pipeline | skills=1, sops=0, cards=4 | 真实 LLM 重新派生；sops=0 与 Mock run 一致（sop_lifecycle 对当前会话无新产出） |
| 3 promote | promoted=4 | 4 张新 cards 全部 ≥0.5 晋升 |
| 4 rescore | rescored=0 | **dormant=0，rescore 未触发**（见决策 1） |
| 5 cleanup | removedDormant=0 | 无 dormant 可清理 |
| 6 checkpoint | `ckpt-82fbef5131817d6c`，metric=4 | metric = promoted 4 + promotedFromDormant 0 |

## 关键发现（真实 teacher vs Mock 基线）

1. **role 分布失真解除**：同一批 5 个 session，Mock 路径产 1 Method（关键词门控触发）+ 3 Workflow；真实 teacher 本轮产 **4 张 Method**（`Conceptual Contrast Explanations` / `Conceptual Definition with Contrast` / `Scope Code Review Framework` / `Idempotent API Retry Strategy`），无 Workflow 偏向。ABILITY Method 库存 2 → 6。
2. **quality 脱离关键词档位**：新条目得分 0.724104 / 0.731059×3，不再是 Mock 的 0.552438/0.578298/0.603735 固定档；verifier 文本回退通路（P3-1 修复）在真实 run 中正常工作。区分度有限（0.72-0.73 聚集），留 R2 对照评估。
3. **五元组完整且引用真实轨迹**：抽查 `exp-0f43bbf41ed034a4`，trigger/procedure/boundary/role/evidence 齐全，`evidence.trace_span_ref` 引用真实 session 文本，`verifier_score=0.724104` 与行 quality 一致。同一 retry session 在真实 teacher 下产出比 Mock 版更完整的 6 步 procedure（Mock 版 4 步）。
4. **rescore 路径未触发**：当前库 dormant=0，stage 4 整体跳过。P3-1 发现的 rescore 真实 LLM 超时（120s/12 次调用）本轮**既未复现也未治理**——TS 侧 `timeoutMs` 默认 300s 是否足够仍未实测。

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | **rescore 超时暂不治理，维持现状** | 本轮无 dormant 可 rescore，治理无验证对象；改动不可在无法验证时落地（TDD 纪律）。触发治理的条件：出现 dormant 积压后真实 run 发生 timeout（checkpoint snapshot 的 `rescored` < dormant 行数或直接失败 checkpoint）。风险已记录，runbook 观察项覆盖（连续 metric=0 / 失败 checkpoint → 查日志） |
| 2 | **真实 teacher E2E 验收通过，进入 R2** | 全链路 exit 0、checkpoint 三态语义正常、产出质量脱离 Mock 失真；满足任务书 R1 验收标准 |

## 测试

零代码改动。回归确认：包级 vitest 全量 21 文件 / 225 测试全绿（与基线一致）。

## 数据状态

- 当前库存：ABILITY 7（Method 6 / Guard 1）、EVIDENCE 25、SKILL 1，active 共 33；dormant 0。
- 备份：`var/experience.db.r1-pre-real-teacher-backup`（运行前，29 active）。

Refer Spec：` design/2026-07-23-agent-server-r-real-teacher-tasks.md`（R1）；` design/2026-07-23-agent-server-c3-observation-baseline.md`（Mock 基线对照）；` design/2026-07-22-agent-server-p3-task1-real-llm-verification.md`（rescore 超时遗留）
