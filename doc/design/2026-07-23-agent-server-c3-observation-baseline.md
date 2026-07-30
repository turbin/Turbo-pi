# Agent-Server C3：迭代观察基线（2026-07-23 快照，同日 follow-up 刷新；同日晚 R2 真实 teacher 刷新）

日期：2026-07-23
用途：C 方案元原则要求的"上线运行后迭代"对照起点。所有数据均可通过下列 SQL 复查。
来源：`packages/agent-server/var/experience.db`，经 `runDailyEvolution`（omlx gemma-4-12B-it-4bit）生成。

**2026-07-23 follow-up 刷新**：场景 1 完整化 follow-up（新增含 retry/backoff 关键词的 session `1784792682394-*.jsonl` 并重跑 `runDailyEvolution`，checkpoint `ckpt-847e1d89f7e98401`）后，库存数字已变化，本文档各节已刷新为 follow-up 后的当前值；变化处以「原值 → 新值」标注。过程与证据见 `doc/design/2026-07-23-agent-server-c3-followup-natural-method-changes-and-decisions.md`。

**2026-07-23 R2 真实 teacher 刷新**：R1 真实 LLM teacher run（checkpoint `ckpt-82fbef5131817d6c`，omlx gemma-4-12B-it-4bit）后，本文档再次刷新为当前值，Mock 时代数字保留作历史对照（「原值 → 新值」）。对照分析见 `doc/design/2026-07-23-agent-server-r2-mock-vs-real-evaluation.md`。

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
| ABILITY | Method | active | 6（原 2，+4 真实 teacher 自然产出） |
| EVIDENCE | (null) | active | 22 |
| EVIDENCE | Workflow | active | 3 |
| SKILL | (null) | active | 1 |

**解读（R2 刷新）**：ABILITY Method 6 条 = 1 条手动 + 1 条 Mock 自然 + **4 条真实 teacher 自然产出**（`Conceptual Contrast Explanations` / `Conceptual Definition with Contrast` / `Scope Code Review Framework` / `Idempotent API Retry Strategy`，quality 0.7241/0.7311×3，脱离 Mock 关键词档）。真实 teacher 下同 5 session 产 4 Method 0 Workflow，Mock 路径的 role 偏 Workflow 判断不成立。active 总计 33（原 29）。

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
| 0.6-0.8 | 5（原 1；Mock 0.6528 + 真实 0.7241 + 0.7311×3） |
| 0.8-1.0 | 2 |

**解读（R2 刷新）**：真实 teacher 得分脱离 Mock 固定档，但 4 张新 card 聚集 0.724-0.731（极差 0.007）——verifier 文本回退通路的字母分映射粒度粗，区分度有限，列入观察项。

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

**结果：3 行（原 0）**——taskId 来自量子问答×2 + 代码评审 session。

**解读（R2 刷新）**：proxy 命中但**语义非重复**——这 3 个 taskId 是 Mock 时代 Workflow EVIDENCE card 与真实时代 Method ABILITY card 同轨迹不同 role（各产一张不同 card），不是 C 已知限制的"同一 card 跨 type 重复晋升"。评审结论：不立项清理；runbook 动作表需补判读规则（同 taskId 不同 role ≠ 重复晋升）。详见 R2 报告 §1.5。

## 5. 截断观察

| 指标 | 基线值 | 说明 |
|---|---|---|
| Method 实际注入条数 | 上限截断生效（库存 6 > 5） | 原 1（库存 2）；R1 后库存 6，**已命中 runbook 触发条件 ≥6**。top-5 by quality = 0.9 + 0.7311×3 + 0.7241，被截的是 0.6528（Mock 时代 retry Method，与 0.7241 真实版同源）——截断不可惜，上限 5 维持（R2 §1.4） |
| Guard 实际注入条数 | 0（库存 1） | FTS 查询未命中 Guard entry 的 trigger（查询词 "test trigger quantum" 不匹配 "always run full suite"） |
| Method 是否达到上限 5 | **是**（原否） | 库存 6 条 → 截断发生 |
| Guard 是否达到上限 5 | 否 | 0 条注入 → "无 ABILITY 时不产生空 Guard 块"行为正确（C2 单测覆盖） |

## 6. Checkpoint 历史

```sql
SELECT id, kind, datetime(epoch/1000,'unixepoch') AS epoch_iso, metric, snapshot
FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 5;
```

| id | epoch_iso | metric | snapshot（摘要） |
|---|---|---|---|
| ckpt-82fbef5131817d6c | 2026-07-23 14:17:29 | 4 | **真实 teacher 首轮**：etlInserted:0, skills:1, cards:4, promoted:4, rescored:0, promotedFromDormant:0, removedDormant:0 |
| ckpt-847e1d89f7e98401 | 2026-07-23 07:45:51 | 6 | etlInserted:5, skills:1, cards:4, promoted:1, rescored:5, promotedFromDormant:5, removedDormant:0 |
| ckpt-77c2725336cb4469 | 2026-07-23 06:52:45 | 21 | etlInserted:17, skills:1, cards:3, promoted:4, rescored:17, promotedFromDormant:17, removedDormant:0 |

真实 run 解读：etlInserted=0（session 无新增，幂等正确）；cards 4 全部为真实 teacher 重派生的 Method（promoted:4）；rescore 未触发（dormant=0）。metric 下降是无新 session 输入的自然结果，非管线退化；判读规则见 R2 报告 §1.6。

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

基于当前基线（R2 真实 teacher 刷新后），后续迭代需关注：

1. ~~**Method/Guard 自然产出**~~ **已关闭（R1/R2）**：真实 teacher 下 role 分布失真解除（单轮 4 Method 0 Workflow）；Mock 偏倚是关键词门控产物而非管线问题。日常进化切换真实 teacher 的指令见 R2 报告 §2.1（用户动作）。
2. **并存行增长**：R1 后 proxy 0→3，但语义为"同轨迹不同 role"而非重复晋升，评审不立项清理（R2 §1.5）。若未来出现"同一 card 跨 type 重复晋升"（C1 前后 hash 变化场景）再复查。
3. **截断频率**：Method 库存 6 已触发截断（上限 5），被截条目不可惜（R2 §1.4）。继续观察 Guard 何时起量、被截条目 quality 是否上升。
4. **quality 分布展宽**：ABILITY 已脱离 Mock 档位（0.724-0.731），但 verifier 文本回退粒度粗（极差 0.007）；EVIDENCE 仍是 Mock 时代得分（rescore 未触发）。真实 teacher 下 EVIDENCE 重评分待 dormant 积压后观察。
5. ~~**FTS 拉丁正文不可检索**~~ **已关闭（N1）**：tokenizer 已重写并重建，`MATCH '"jitter"'` 0→2 命中。
6. **【新】增量派生**：verification 管线每轮对全部 session 重派生 cards，真实 teacher 下成本随 session 数线性增长（~30s/session）；session 数 ~50（单轮 ~25 min）前需立项"只处理新 session"的增量派生（R2 §2.2）。
7. **【新】rescore 规模化风险**：dormant 积压出现时真实 LLM rescore 可能超时（P3-1 数据 12 calls/候选）；触发治理条件见 R1 决策记录决策 1。
