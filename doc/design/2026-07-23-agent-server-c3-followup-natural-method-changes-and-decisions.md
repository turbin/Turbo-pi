# Agent-Server C3 Follow-up：自然 Method ABILITY 入库验证——决策与变更记录

日期：2026-07-23
来源：C3 验收报告（`doc/design/2026-07-23-agent-server-c3-acceptance-report.md`）"遗留与后续建议"第 1 条——构造含 `retry`/`backoff` 关键词的 session 重跑 `runDailyEvolution`，把场景 1 的"条件性 PASS"升级为完整 PASS。
通用约束：见 `doc/design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"一节。本次为数据构造 + live 验证 + 文档刷新，**零代码改动**。

---

## 1. 执行过程

### 1.1 Session 构造

按 C3 验收修正后的根因（MockLLM `extract_handler` 关键词门控，`testing.py:129-172`：`backoff`/`retry` → Method）构造 pi v3 session `var/sessions/1784792682394-37b98075-6185-4a17-836d-1a4f2a7bc508.jsonl`：

- user：幂等外部库存 API 偶发 5xx/无响应，要求设计 retry 策略。
- assistant：bounded retry loop + exponential backoff + jitter、cap 4 attempts、verified response schema、test simulating two 5xx、checklist。

关键词设计依据（`testing.py:15-33`）：

- **触发门控**：`backoff`、`retry`（命中 Method 分支）。
- **抬 quality**：正关键词 `backoff`/`jitter`/`verif*`/`test*`/`checklist` 命中 5 个，`keyword_quality_index` = 18（reference 轨迹含 `guesses` 负关键词 = 6）→ 预演 quality 0.652847 ≥ 0.5 晋升阈值。
- **避负关键词**：全文规避 `error`/`timeout`/`fail`/`wrong`/`assum*`/`skip*`/`crash`/`guess`/`brute force`（用 "5xx"、"stops responding" 等表述替代）。

### 1.2 预演（可选但做了）

直接调 Python `select_experiences`（MockLLM 路径）预演：quality 0.652847、accepted、card role=Method。确认后再跑真实管线，避免无效全量运行。

### 1.3 真实管线执行

```bash
cd packages/agent-server
cp var/experience.db var/experience.db.c3-followup-backup   # 运行前备份
EXPERIENCE_STORE_PATH=./var/experience.db \
AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json \
PYTHONPATH=python \
../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts
# 输出：evolution checkpoint: ckpt-847e1d89f7e98401
```

环境无 `LLM_BASE_URL`/`LLM_MODEL` → MockLLM 路径（与 C3 live 验证一致；真实 LLM 只参与 omlx 侧，不在本通路）。

**checkpoint snapshot**：

```json
{"etlInserted":5,"pipeline":{"skills":1,"sops":0,"cards":4},
 "promoted":1,"rescored":5,"promotedFromDormant":5,"removedDormant":0}
```

解读：5 条新 session ETL 句子入库 dormant；cards 4 = 3 张旧 Workflow 重新派生（contentHash 去重跳过，不计 promoted）+ 1 张新 Method；promoted:1 全部来自新 Method card；5 条 dormant 经 rescore 全部 ≥0.5 晋升（0.552438×1 / 0.578298×1 / 0.603735×3）；metric = 1 + 5 = 6。

## 2. 验证证据

### Q1：自然 Method ABILITY 入库（场景 1 Then）

```sql
SELECT id, type, status, quality, json_extract(payload,'$.taskId')
FROM experiences WHERE type='ABILITY' AND json_extract(payload,'$.role')='Method' AND quality=0.652847;
```

```
exp-13a22197b1df92fe | ABILITY | active | 0.652847 | 1784792682394-37b98075-6185-4a17-836d-1a4f2a7bc508
```

五元组与 MockLLM Method 模板逐项一致（trigger/procedure/boundary 已录入基线文档 §2）。

### Q2：并存行统计

```sql
SELECT json_extract(a.payload,'$.taskId') FROM experiences a
JOIN experiences e ON json_extract(a.payload,'$.taskId')=json_extract(e.payload,'$.taskId')
WHERE a.type='ABILITY' AND e.type='EVIDENCE';
```

**0 行。** 符合预期：新 session 的 card 首次入库即路由 ABILITY，无 C1 前的 EVIDENCE 旧行；ETL 行 payload 无 `taskId`（JOIN 键 NULL）。

### Q3：生产 retrieve() 路径可检索

```ts
await retrieve(store, "How should I retry a flaky API call with backoff?", 8)
```

新 Method ABILITY 命中（top-8 第 2 位，q=0.652847），同列还有新 session 的 4 条 ETL EVIDENCE。注入通路（FTS → buildInjection）对自然 ABILITY 可用。

### 库存变化（基线已同步刷新）

| 指标 | 原值 | 新值 |
|---|---|---|
| ABILITY active | 2（均手动） | 3（+1 自然 Method） |
| EVIDENCE active | 20 | 25（+5 ETL 晋升） |
| SKILL active | 1 | 1 |
| dormant 残留 | 0 | 0 |
| checkpoint 数 | 1 | 2 |

## 3. 决策记录

1. **session 构造走"最小触发"而非"真实会话录制"**：只构造 user + assistant 两条消息（无 toolCall/stream_event），因为管线只消费 `collectTrajectories` 的 task + assistant/toolResult text。理由：目标明确（触发关键词门控），最小构造减少变量；代价是benchmark 派生器、toolCall 校验等旁路无新数据，可接受。
2. **不重清 DB，增量重跑**：保留 C3 库（含 2 条手动 ABILITY）直接重跑，验证增量幂等（旧 cards 去重跳过、ETL 幂等）。这正是 cron 日常运行的形态，比 fresh DB 更接近真实。
3. **预演先行**：直接调 Python `select_experiences` 预演 quality/role，确认达标后再跑全管线。成本极低，避免"跑完发现没触发"的往返。
4. **【新发现】FTS 拉丁正文不可检索，仅记录不修复**：`tokenizeForFts`（`experience-store.ts:69-83`）对非 CJK 字符也逐字拆开写入 `search_text`，FTS 词查询对拉丁正文永不命中；词查询实际只命中 `title` 列（INSERT 语句从 experiences 原样 SELECT title，未经 tokenizer）。实测：`MATCH 'jitter'`（仅存在于 card 正文）0 命中，`MATCH 'flaky'`（title 内）命中。中文正文靠 bigram 不受影响；英文 session 的 ETL EVIDENCE 正文实际不可检索。本次自然 Method 可被检索完全因为 title 含关键词。这是 P0 task3 CJK tokenize 决策的副作用，影响检索召回质量，已写入基线迭代建议第 5 条，**建议单独立项修正**（拉丁保留整词 + CJK 保留 char/bigram），本次不改代码。
5. **并存行 SQL 的检测能力有限（观察结论）**：ETL 行 payload 无 `taskId`、同一轨迹只产一张 card，该 SQL 在当前管线下只能检测"同一 card 跨 type 重复晋升"（C1 前后 hash 变化场景）。基线文档 §4 解读已如实更新。

## 4. 变更清单

| 文件 | 变更 |
|---|---|
| `packages/agent-server/var/sessions/1784792682394-*.jsonl` | 新增构造 session（var/ 在 gitignore，不入库） |
| `doc/design/2026-07-23-agent-server-c3-live-verification.md` | 场景 1 判定：条件性 PASS → PASS（补 follow-up 小节） |
| `doc/design/2026-07-23-agent-server-c3-observation-baseline.md` | 全量刷新：库存/quality 分布/checkpoint/会话特征/迭代建议（含 FTS 新发现第 5 条） |
| `doc/design/2026-07-23-agent-server-c3-followup-natural-method-changes-and-decisions.md` | 本文档 |
| `doc/design/INDEX.md` | 新增本文档条目；C3 相关条目措辞同步；时间线补 follow-up 记录 |

测试基线：零代码改动，未动 213 测试；`npm run check` 由 pre-commit 执行。

Refer Spec：`doc/design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`（C3 场景 1）；`doc/design/2026-07-23-agent-server-c3-acceptance-report.md`（遗留建议第 1 条）；`doc/design/2026-07-23-agent-server-c3-live-verification.md`；`doc/design/2026-07-23-agent-server-c3-observation-baseline.md`
