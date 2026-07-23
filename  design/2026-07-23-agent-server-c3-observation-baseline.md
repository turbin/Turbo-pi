# Agent-Server C3：迭代观察基线（2026-07-23 快照）

日期：2026-07-23
用途：C 方案元原则要求的"上线运行后迭代"对照起点。所有数据均可通过下列 SQL 复查。
来源：`packages/agent-server/var/experience.db`，经 `runDailyEvolution`（omlx gemma-4-12B-it-4bit）生成。

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
| ABILITY | Method | active | 1 |
| EVIDENCE | (null) | active | 17 |
| EVIDENCE | Workflow | active | 3 |
| SKILL | (null) | active | 1 |

**解读**：ABILITY 的 Method/Guard 各 1 条均为手动插入（供 BDD 场景 2 验证注入路径）；17 条 EVIDENCE 来自 ETL 从 4 个 session JSONL 提取；3 条 EVIDENCE（Workflow）来自 offline pipeline 的 cards 晋升；1 条 SKILL 来自 skill_evolution pipeline。

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

**解读**：本表 2 条均为手动插入测试数据。当前 live 管线（MockLLM + benchmark.example.json 2 样本）未产出 Method/Guard cards。

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
| 0.5-0.6 | 20 |

**解读**：全部 EVIDENCE quality 集中在 0.55 附近（verifier 对 4 个 session 的连续评分结果）。分布单一——预期现象：4 个 session 的对话主题相似（量子计算问答 + 代码 review），verifier 产出的评分分布窄。

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

**结果：0 行。**

**解读**：当前无自然 Method/Guard ABILITY 产出 → 无并存。这是基线的"零状态"——当后续 session 数据增加且真实 LLM 路径产出 Method/Guard cards 后，此 SQL 可能返回非零行。那时需复查并存行内容，判断是否为无害冗余。

## 5. 截断观察

| 指标 | 基线值 | 说明 |
|---|---|---|
| Method 实际注入条数 | 1 | 手动插入的唯一 Method 条目通过 FTS5 检索 → 注入（触发词与 FTS5 匹配） |
| Guard 实际注入条数 | 0 | FTS 查询未命中 Guard entry 的 trigger（查询词 "test trigger quantum" 不匹配 "always run full suite"） |
| Method 是否达到上限 5 | 否 | 仅 1 条 → "不足上限时全量注入"行为正确 |
| Guard 是否达到上限 5 | 否 | 0 条 → "无 ABILITY 时不产生空 Guard 块"行为正确（C2 单测覆盖） |

## 6. Checkpoint 历史

```sql
SELECT id, kind, datetime(epoch/1000,'unixepoch') AS epoch_iso, metric, snapshot
FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 5;
```

| id | epoch_iso | metric | snapshot（摘要） |
|---|---|---|---|
| ckpt-77c2725336cb4469 | 2026-07-23 06:52:45 | 21 | etlInserted:17, skills:1, cards:3, promoted:4, rescored:17, promotedFromDormant:17, removedDormant:0 |

## 7. 会话数据特征

```bash
ls -la var/sessions/
```

| 文件 | 大小 | 内容摘要 |
|---|---|---|
| 1784707421787-*.jsonl | 1.1 KB | "ping" 请求（gateway 不可达导致 error） |
| 1784707461941-*.jsonl | 4.3 KB | 非流式"量子计算"问答 |
| 1784707588573-*.jsonl | 4.5 KB | 非流式"量子计算"问答（变体） |
| 1784707649581-*.jsonl | 113 KB | Kimi Code 流式"帮我 review 代码"会话 |

## 8. 迭代建议

基于当前基线，后续迭代需关注：

1. **Method/Guard 自然产出**：当前为 0 — 需要更多 session 数据或调整 benchmark.example.json 样本触发 MockLLM 的 Method/Guard handler 分支（或切换到真实 LLM teacher 路径使五元组提取的 role 多样化）。
2. **并存行增长**：Method/Guard 开始产出后，同 taskId 可能同时存在 EVIDENCE + ABILITY → 监控此 SQL 结果判断是否需清理。
3. **截断频率**：当 Method/Guard 库存 ≥6 时，场景 2 曲线验证截断触发 → 记录被截断 entry 的 quality，判断是否可惜。
4. **quality 分布展宽**：当前全部集中在 0.55 — 需不同难度/质量的 session 来拉开评分分布。
