# Agent-Server C3：迭代观察基线（2026-07-23 快照，同日 follow-up 刷新）

日期：2026-07-23
用途：C 方案元原则要求的"上线运行后迭代"对照起点。所有数据均可通过下列 SQL 复查。
来源：`packages/agent-server/var/experience.db`，经 `runDailyEvolution`（omlx gemma-4-12B-it-4bit）生成。

**2026-07-23 follow-up 刷新**：场景 1 完整化 follow-up（新增含 retry/backoff 关键词的 session `1784792682394-*.jsonl` 并重跑 `runDailyEvolution`，checkpoint `ckpt-847e1d89f7e98401`）后，库存数字已变化，本文档各节已刷新为 follow-up 后的当前值；变化处以「原值 → 新值」标注。过程与证据见 ` design/2026-07-23-agent-server-c3-followup-natural-method-changes-and-decisions.md`。

---

## 1. 库存概览

```sql
SELECT type, json_extract(payload,'$.role') AS role, status, COUNT(*) AS cnt
FROM experiences
GROUP BY type, json_extract(payload,'$.role'), status
ORDER BY type, role;
```

| type | role | status | cnt |
|---|---|---|---|
| ABILITY | Guard | active | 1 |
| ABILITY | Method | active | 2（原 1，+1 自然产出） |
| EVIDENCE | (null) | active | 22（原 17，+5 新 session ETL 晋升） |
| EVIDENCE | Workflow | active | 3 |
| SKILL | (null) | active | 1 |

**解读**：ABILITY Method 2 条 = 1 条手动插入（供 BDD 场景 2 验证注入路径）+ **1 条 follow-up 自然产出**（`exp-13a22197b1df92fe`，quality 0.652847，来自含 retry/backoff 关键词的新 session）；22 条 EVIDENCE 来自 ETL 从 5 个 session JSONL 提取（17 旧 + 5 新，全部经 rescore 晋升）；3 条 EVIDENCE（Workflow）来自 offline pipeline 的 cards 晋升；1 条 SKILL 来自 skill_evolution pipeline。active 总计 29（原 23）。

## 2. ABILITY 详情

```sql
SELECT id, json_extract(payload,'$.role') AS role, quality,
       json_extract(payload,'$.trigger') AS trigger,
       json_extract(payload,'$.procedure') AS procedure,
       json_extract(payload,'$.boundary') AS boundary
FROM experiences WHERE type='ABILITY' AND status='active';
```

| id | role | quality | trigger | procedure | boundary |
|---|---|---|---|---|---|
| c3-method-1 | Method | 0.9 | test trigger quantum | 1) Write test 2) Run 3) Fix | Never skip tests |
| c3-guard-1 | Guard | 0.85 | always run full suite | 1) Run prechecks 2) Run postchecks | Must not bypass pre-push checks |
| exp-13a22197b1df92fe | Method | 0.652847 | Use when calling external APIs that intermittently return 5xx or time out and the operation is idempotent. | 1) Wrap the call in a retry loop with exponential backoff and jitter. 2) Cap attempts at 4. 3) Verify the response schema before using the payload. 4) Log each retry with its cause. | Must not retry on 4xx client errors or on non-idempotent POST requests without an idempotency key. |

**解读**：前 2 条为手动插入测试数据；第 3 条为 **follow-up 自然产出**——MockLLM `extract_handler` 的关键词门控（`backoff`/`retry` → Method）被新 session 轨迹触发，`cardsToStaged` 按 C1 路由存为 ABILITY 并晋升 active。

## 3. Quality 分布

### ABILITY

```sql
SELECT
  CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
  END AS bucket, COUNT(*) AS cnt
FROM experiences WHERE type='ABILITY' AND status='active'
GROUP BY bucket ORDER BY bucket;
```

| bucket | cnt |
|---|---|
| 0.6-0.8 | 1（自然 Method 0.652847） |
| 0.8-1.0 | 2 |

### EVIDENCE

```sql
SELECT
  CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
  END AS bucket, COUNT(*) AS cnt
FROM experiences WHERE type='EVIDENCE' AND status='active'
GROUP BY bucket ORDER BY bucket;
```

| bucket | cnt |
|---|---|
| 0.5-0.6 | 22（原 20） |
| 0.6-0.8 | 3（原 0） |

distinct 值：0.552438×21、0.578298×1、0.603735×3。新 session 的 5 条 ETL EVIDENCE 经 rescore 得 0.552438/0.578298/0.603735×3，全部 ≥0.5 晋升。

**解读**：quality 分布开始展宽（原全部集中 0.552438）——含正关键词（backoff/jitter/verify/test/checklist）的轨迹获得更高分，符合 `keyword_quality_index` 的计分方向。Mock 路径下评分仍由关键词驱动，不代表真实质量。

### Workflow cards（EVIDENCE 子集）

```sql
SELECT
  CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
  END AS bucket, COUNT(*) AS cnt
FROM experiences WHERE type='EVIDENCE' AND json_extract(payload,'$.role')='Workflow' AND status='active'
GROUP BY bucket ORDER BY bucket;
```

| bucket | cnt |
|---|---|
| 0.5-0.6 | 3 |

## 4. 并存行统计（已知限制：type 变更产生并存）

```sql
SELECT json_extract(a.payload,'$.taskId') AS shared_taskid
FROM experiences a
JOIN experiences e ON json_extract(a.payload,'$.taskId') = json_extract(e.payload,'$.taskId')
WHERE a.type='ABILITY' AND e.type='EVIDENCE';
```

**结果：0 行（follow-up 后仍为 0）。**

**解读**：自然 Method ABILITY 已产出，但并存行仍为 0——新 session 的 card 在 C1 之后首次入库即路由 ABILITY，不存在 C1 前的 EVIDENCE 旧行；ETL 提取的 EVIDENCE 行 payload 无 `taskId` 字段（JOIN 键为 NULL，永不上榜），Workflow card 与 Method card 同一轨迹只产一张，因此该 SQL 在当前管线下实际只能检测"同一 card 跨 type 重复晋升"（C1 前后的 hash 变化场景）。

## 5. 截断观察

| 指标 | 基线值 | 说明 |
|---|---|---|
| Method 实际注入条数 | 1（库存 2） | 手动插入条目经 FTS5 检索注入；follow-up 后自然 Method（库存第 2 条）经生产 `retrieve()` 验证可检索（查询 "How should I retry a flaky API call with backoff?" 命中排第 2） |
| Guard 实际注入条数 | 0（库存 1） | FTS 查询未命中 Guard entry 的 trigger（查询词 "test trigger quantum" 不匹配 "always run full suite"） |
| Method 是否达到上限 5 | 否 | 库存 2 条 → 远未及上限 |
| Guard 是否达到上限 5 | 否 | 0 条注入 → "无 ABILITY 时不产生空 Guard 块"行为正确（C2 单测覆盖） |

## 6. Checkpoint 历史

```sql
SELECT id, kind, datetime(epoch/1000,'unixepoch') AS epoch_iso, metric, snapshot
FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 5;
```

| id | epoch_iso | metric | snapshot（摘要） |
|---|---|---|---|
| ckpt-847e1d89f7e98401 | 2026-07-23 07:45:51 | 6 | etlInserted:5, skills:1, cards:4, promoted:1, rescored:5, promotedFromDormant:5, removedDormant:0 |
| ckpt-77c2725336cb4469 | 2026-07-23 06:52:45 | 21 | etlInserted:17, skills:1, cards:3, promoted:4, rescored:17, promotedFromDormant:17, removedDormant:0 |

follow-up run 解读：cards 4 = 3 张旧 Workflow 重新派生（contentHash 去重跳过）+ 1 张新 Method（promoted:1 全部来自它）；5 条新 ETL dormant 经 rescore 全部晋升（promotedFromDormant:5）；metric = 1 + 5 = 6。

## 7. 会话数据特征

```bash
ls -la var/sessions/
```

| 文件 | 大小 | 内容摘要 |
|---|---|---|---|
| 1784707421787-*.jsonl | 1.1 KB | "ping" 请求（gateway 不可达导致 error） |
| 1784707461941-*.jsonl | 4.3 KB | 非流式"量子计算"问答 |
| 1784707588573-*.jsonl | 4.5 KB | 非流式"量子计算"问答（变体） |
| 1784707649581-*.jsonl | 113 KB | Kimi Code 流式"帮我 review 代码"会话 |
| 1784792682394-*.jsonl | 1.4 KB | **follow-up 构造**：幂等 API 的 bounded exponential-backoff retry 设计会话（轨迹含 retry/backoff/jitter/verify/test/checklist 关键词） |

## 8. 迭代建议

基于当前基线，后续迭代需关注：

1. **Method/Guard 自然产出**：follow-up 已验证关键词门控通路可用（Method 1 条入库）。但 MockLLM 路径下 role 分布仍结构性偏 Workflow——只有轨迹含门控关键词才分流；真实使用中若 teacher 也是 Mock，ABILITY 产量会偏低。要 role 多样化：让 session 轨迹覆盖更多领域关键词，或切换到真实 LLM teacher 路径。
2. **并存行增长**：该 SQL 当前管线下只能检测"同一 card 跨 type 重复晋升"（ETL 行无 payload.taskId）；自然 Method 产出后仍为 0，符合预期。若未来换真实 LLM teacher 或重跑 C1 前数据，需复查。
3. **截断频率**：Method 库存 2、Guard 库存 1，距上限 5 仍远；达到 ≥6 时验证截断曲线 → 记录被截断 entry 的 quality，判断是否可惜。
4. **quality 分布展宽**：已开始（0.552438 → 0.55/0.58/0.60 三档 + ABILITY 0.65）。Mock 路径评分由关键词驱动，展宽方向正确但不代表真实质量；真实 LLM teacher 下的分布待观察。
5. **【新发现】FTS 拉丁正文不可检索**：`tokenizeForFts`（`experience-store.ts:69-83`）把非 CJK 文本也拆成单字符写入 `search_text`，导致 FTS 词查询对拉丁正文永不命中；词查询实际只命中 `title` 列（INSERT 时从 experiences 原样 SELECT，未拆字）。本次自然 Method 能被检索完全因为 title（"...Exponential-Backoff Retry for Flaky APIs"）含关键词。影响：英文 session 的 ETL EVIDENCE 正文无法被检索（中文靠 bigram 不受影响）。建议立项修正 tokenizer：拉丁保留整词 + CJK 保留 char/bigram。详见 follow-up 决策记录。
