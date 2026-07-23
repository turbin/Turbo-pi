# Agent-Server 观察 Runbook

日期：2026-07-23
用途：C 方案上线后的观察期操作手册——对照基线 SQL 集监控经验库健康度，触发迭代评审。
基线文档：` design/2026-07-23-agent-server-c3-observation-baseline.md`（2026-07-23 follow-up 刷新版）
元原则来源：` design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`（"所有决策暂定，上线运行后按观察基线迭代"）

---

## 1. 观察周期与评审节奏

| 频率 | 动作 |
|---|---|
| 每周一次 | 跑 §2 SQL 集，与基线对比，填写周报（附录 A 模板） |
| 4 周 | 出第一份迭代评估：汇总 4 周趋势，决定是否调整 C 方案暂定决策 |
| 触发式 | §3 动作表中任一条件命中时，立即评审对应决策 |

**执行环境备忘**：

- 所有 SQL 从 `packages/agent-server` 目录执行：
  ```bash
  cd packages/agent-server
  sqlite3 var/experience.db "<SQL>"
  ```
- Node 命令走 `../../scripts/with-node25.sh`。
- 进化日志：`var/evolution-launchd.log`（stdout）、`var/evolution-launchd.err`（stderr）。

---

## 2. 对照 SQL 集

以下 SQL 引自基线文档各节。每条注明"关注什么变化"。

### 2.1 库存概览（基线 §1）

```sql
SELECT type, json_extract(payload,'$.role') AS role, status, COUNT(*) AS cnt
FROM experiences
GROUP BY type, json_extract(payload,'$.role'), status
ORDER BY type, role;
```

**基线值**：ABILITY Guard 1 + Method 2 = 3；EVIDENCE 22 + Workflow 3 = 25；SKILL 1。active 总计 29。

**关注**：
- ABILITY Method/Guard 数量是否增长（自然产出信号）；
- EVIDENCE 总量增长速率（反映真实 session 积累量）；
- 是否出现 `status != 'active'` 的行（dormant/removed 的 TTL 清理是否生效）。

### 2.2 ABILITY 详情（基线 §2）

```sql
SELECT id, json_extract(payload,'$.role') AS role, quality,
       json_extract(payload,'$.trigger') AS trigger,
       json_extract(payload,'$.procedure') AS procedure,
       json_extract(payload,'$.boundary') AS boundary
FROM experiences WHERE type='ABILITY' AND status='active';
```

**基线值**：3 条（c3-method-1 手动 0.9、c3-guard-1 手动 0.85、exp-13a22197b1df92fe 自然 Method 0.652847）。

**关注**：
- 新增 ABILITY 的 role 分布（Method vs Guard vs 其他）；
- 自然产出 ABILITY 的 trigger/procedure 内容是否合理（非空、非乱码、语义正确）；
- quality 是否在 0.5-1.0 合理区间。

### 2.3 Quality 分布（基线 §3）

```sql
-- ABILITY
SELECT
  CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
  END AS bucket, COUNT(*) AS cnt
FROM experiences WHERE type='ABILITY' AND status='active'
GROUP BY bucket ORDER BY bucket;

-- EVIDENCE
SELECT
  CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
  END AS bucket, COUNT(*) AS cnt
FROM experiences WHERE type='EVIDENCE' AND status='active'
GROUP BY bucket ORDER BY bucket;
```

**基线值**：ABILITY 0.6-0.8×1 + 0.8-1.0×2；EVIDENCE 0.5-0.6×22 + 0.6-0.8×3。

**关注**：
- 分布是否展宽（更多 bucket 出现 = quality 分化，是质量信号增强的好迹象）；
- 高分段（0.8-1.0）是否出现自然产出（非手动插入）；
- 低分段（<0.5）是否有条目被拦截（不应出现在 active 中——如果看到，说明晋升门控有 bug）。

### 2.4 并存行统计（基线 §4）

```sql
SELECT json_extract(a.payload,'$.taskId') AS shared_taskid
FROM experiences a
JOIN experiences e ON json_extract(a.payload,'$.taskId') = json_extract(e.payload,'$.taskId')
WHERE a.type='ABILITY' AND e.type='EVIDENCE';
```

**基线值**：0 行。

**关注**：
- 并存行 >0 → 同一 card 跨 type 重复晋升（C1 前后 hash 变化场景），评审是否需要清理立项。
- 注意：ETL 提取的 EVIDENCE 行 payload 无 `taskId`（JOIN 键 NULL 不上榜），此 SQL 只检测 cards 晋升路径的并存。

### 2.5 截断观察（基线 §5）

无固定 SQL，通过以下方式观察：

```bash
# 查看 Method 注入条数（库存 vs 注入上限 5）
sqlite3 var/experience.db "SELECT COUNT(*) FROM experiences WHERE type='ABILITY' AND json_extract(payload,'\$.role')='Method' AND status='active';"

# 查看 Guard 注入条数
sqlite3 var/experience.db "SELECT COUNT(*) FROM experiences WHERE type='ABILITY' AND json_extract(payload,'\$.role')='Guard' AND status='active';"
```

**基线值**：Method 库存 2（注入上限 5）；Guard 库存 1（注入 0，FTS 未命中）。

**关注**：
- 库存 ≥6 → 截断发生（C2 决策 4：quality 前 5 条），需评审被截断条目是否"可惜"；
- Guard 库存 ≥6 → 同上；
- 截断频率 = 每周新增中有多少被截断 → 评估上限 5 是否合理。

### 2.6 Checkpoint 历史（基线 §6）

```sql
SELECT id, kind, datetime(epoch/1000,'unixepoch') AS epoch_iso, metric, snapshot
FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 10;
```

**基线值**：2 个 checkpoint（ckpt-847e1d89f7e98401 metric=6、ckpt-77c2725336cb4469 metric=21）。

**关注**：
- metric 趋势：是否持续 >0（进化在产出）vs 连续 0（管线空转或失败）；
- 失败 checkpoint（snapshot 含 `error` 字段）→ 查 `var/evolution-launchd.err` 排查原因；
- checkpoint 间隔：应约 24h（StartInterval 86400），偏差过大说明调度异常；
- snapshot 中 `promoted`/`promotedFromDormant` 比值：新晋升 vs dormant 重评分晋升的平衡。

---

## 3. 触发评审的动作表

每行对应 C 方案一项暂定决策的观察项（来源：C 设计文档决策表"上线后观察项"列）。

| 触发条件 | 评审内容 | 对应 C 决策 | 建议动作 |
|---|---|---|---|
| Method/Guard 库存合计 ≥6 | 截断是否发生、被截断条目质量是否可惜 | 决策 4（注入上限 5） | 评审是否提高上限或引入衰减 |
| Guard 误伤案例出现（模型被错误约束导致输出质量下降） | Guard 阈值 0.5 是否太低 | 决策 2（质量门槛暂沿用 0.5） | 提高 Guard 阈值（如 0.7）或增加人工审核 |
| 并存行 >0（§2.4 SQL 返回行） | 是否需要清理 EVIDENCE/ABILITY 并存行 | 已知限制（type 变更并存） | 立项清理迁移脚本 |
| ABILITY 自然产量连续 4 周为 0 | 关键词门控是否过严、session 数据是否足够多样 | 决策 1（C-轻路径） | 评审是否需要 C-重（独立 LLM 提炼管线） |
| 近似重复 Method 堆积（trigger/procedure 语义相近但 content_hash 不同） | 是否需要合并/去重 | 决策 5（本期不做合并） | 立项 edges/合并功能 |
| quality 分布始终集中单一值（无展宽） | 评分是否有效区分质量 | 决策 2（门槛）+ Mock 路径限制 | 评审是否切换真实 LLM teacher |
| 连续 3 个 checkpoint metric=0 | 管线是否空转或全部失败 | B3（失败也写 checkpoint） | 检查进化日志、session 数据、omlx 可达性 |

---

## 4. 日常使用接线说明

agent-server 的经验积累依赖真实 session 数据。客户端（pi / Kimi Code）需将 API 请求指向 agent-server（8788），由 agent-server 代理到 gateway（8787）再到 omlx（8000），同时记录 session JSONL 到 `var/sessions/`。

### 4.1 架构链路

```
客户端 (pi / Kimi Code)
  → agent-server (127.0.0.1:8788)    ← 经验检索 + 注入 + session 记录
    → gateway (127.0.0.1:8787)       ← 模型路由
      → omlx (127.0.0.1:8000)        ← 本地模型推理
```

### 4.2 Kimi Code CLI 配置

Kimi Code 通过 `config.toml` 配置自定义 provider（已验证于 P1/P2 live 验证）：

```toml
# ~/.config/kimi/config.toml（或对应路径）
[providers.local]
type = "openai_legacy"
base_url = "http://127.0.0.1:8788/v1"
api_key = "any"          # agent-server 不校验 key
model = "agent-auto"
```

配置后验证：

```bash
kimi provider list
# 预期：显示 local provider，model agent-auto

kimi -p "你好" -m local/agent-auto
# 预期：经 agent-server → gateway → omlx 返回回复
# agent-server 日志：[agent-server] stream query: 你好
# var/sessions/ 下产生新的 .jsonl 文件
```

### 4.3 启动 agent-server

```bash
cd packages/agent-server
../../scripts/with-node25.sh npx tsx src/start.ts
# 预期输出：agent-server listening on 127.0.0.1:8788
```

前提：gateway（8787）和 omlx（8000）须已运行。agent-server 启动不依赖它们，但请求代理需要。

### 4.4 session 积累 → 进化消费

- 每次客户端请求在 `var/sessions/` 产生一个 `<timestamp>-<uuid>.jsonl` 文件；
- 每日进化（LaunchAgent 或手动触发）扫描 `var/sessions/` 中的新 session → ETL 提取 → 管线处理 → 晋升/更新经验库；
- 已处理的 session 不会被重复 ETL（幂等，由 session 路径去重）。

---

## 5. 日常健康检查清单（建议每周执行）

```bash
cd packages/agent-server

# 1. 进化调度是否正常
../../scripts/with-node25.sh npx tsx src/offline/schedule.ts doctor

# 2. 最近 checkpoint
../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts --status

# 3. 进化日志有无错误
tail -30 var/evolution-launchd.err
# 预期：无输出或仅有 warning；有 error 行需排查

# 4. session 积累量
ls var/sessions/ | wc -l
# 对比上周：应增长（如果客户端在使用）

# 5. 经验库体积
ls -lh var/experience.db

# 6. FTS 检索健康（N1 修复后拉丁词应可检索）
sqlite3 var/experience.db "SELECT COUNT(*) FROM experiences_fts_docsize;"
# 预期：= experiences 行数（FTS 已重建）

cd ../..
```

---

## 附录 A：周报模板

```markdown
# Agent-Server 进化周报 — W<N>（<起始日期> ~ <结束日期>）

## 1. 库存变化

| type | role | status | 上周 cnt | 本周 cnt | 变化 |
|---|---|---|---|---|---|
| ABILITY | Method | active | | | |
| ABILITY | Guard | active | | | |
| EVIDENCE | (null) | active | | | |
| EVIDENCE | Workflow | active | | | |
| SKILL | (null) | active | | | |
| **合计 active** | | | | | |

## 2. 新增 ABILITY 详情

| id | role | quality | trigger（摘要） | 来源（自然/手动） |
|---|---|---|---|---|
| | | | | |

（无新增则写"本周无新增 ABILITY"）

## 3. Quality 分布变化

| bucket | ABILITY 上周 | ABILITY 本周 | EVIDENCE 上周 | EVIDENCE 本周 |
|---|---|---|---|---|
| 0.5-0.6 | | | | |
| 0.6-0.8 | | | | |
| 0.8-1.0 | | | | |

## 4. Checkpoint 趋势

| checkpoint id | 日期 | metric | promoted | promotedFromDormant | 失败? |
|---|---|---|---|---|---|
| | | | | | |

## 5. 并存行

本周并存行数：<N>（基线：0）

## 6. 截断状态

| 类型 | 库存 | 注入上限 | 截断? |
|---|---|---|---|
| Method | | 5 | |
| Guard | | 5 | |

## 7. Session 积累

本周新增 session 数：<N>
累计 session 数：<N>

## 8. 触发评审项

（对照 §3 动作表逐条检查，命中的打 ✓ 并说明）

- [ ] Method/Guard 库存 ≥6
- [ ] Guard 误伤案例
- [ ] 并存行 >0
- [ ] ABILITY 自然产量连续 4 周为 0
- [ ] 近似重复 Method 堆积
- [ ] quality 分布无展宽
- [ ] 连续 3 checkpoint metric=0

## 9. 备注与下周关注

（自由记录：异常现象、环境问题、客户端配置变更等）
```

---

## 附录 B：基线快照引用

本 runbook 引用的基线数据来自 ` design/2026-07-23-agent-server-c3-observation-baseline.md`（2026-07-23 follow-up 刷新版），关键数字：

- active 总计 29（ABILITY 3 + EVIDENCE 25 + SKILL 1）
- 自然 Method 1 条（exp-13a22197b1df92fe，quality 0.652847）
- 并存行 0
- checkpoint 2 个
- session 5 个（4 真实 + 1 构造）
- FTS 已重建（N1 修复，拉丁整词 + CJK bigram）
