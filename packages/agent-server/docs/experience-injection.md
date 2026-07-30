# 经验注入技术方案（Experience Injection）

本文档是 agent-server 经验注入机制的工程说明，面向维护和二次开发者。设计决策史见 `doc/design/`（INDEX.md 阶段 1-9）；本文只描述**当前实现**。

## 1. 总览

经验注入 = 在每次 LLM 调用前，从本地经验库检索与当前请求相关的历史经验，注入上下文，使模型"越用越聪明"。三件套：

```
                    ┌──────────────── 在线路径（每次请求）────────────────┐
client → agent-server(:8788/:8789) ─ retrieve ─→ FTS bm25 top-24 → 余弦 top-8
              │                                                            │
              │ buildInjection：合成消息插入最后一条 user 消息之前             │
              ▼                                                            ▼
        agent-gateway(:8787) → omlx 学生模型(:8000) ─质量门控─→ DeepSeek 升级
              │
                    └──────────────── 离线路径（每日/每周）────────────────┘
session JSONL → ETL → 三条 Python 管线（SKILL/SOP/ABILITY cards）
              → verifier 连续质量分 ≥0.5 晋升 active → FTS 索引
              → dormant rescore / TTL 清理 / checkpoint
```

## 2. 三件套实现

### 2.1 ABILITY cards（经验形态）

- 四类经验（`src/types.ts` Experience）：`SKILL`（可复用技能）、`SOP`（工具 schema 化流程）、`ABILITY`（细分 `Method`/`Guard`）、`EVIDENCE`（证据片段）
- ABILITY cards 由离线管线从 session 轨迹提炼，按 role 精确等值分流 Method/Guard（C1 决策）；Method=方法论（如"retry with exponential backoff"），Guard=护栏（如"never pipe secrets to logs"）
- 每条经验：`title + payload(JSON) + quality(连续分) + status(active/dormant/removed) + contentHash(去重)`

### 2.2 FTS 检索（`src/retrieval.ts`）

- 两级：SQLite FTS5 bm25 取 `min(limit*3, 24)` 候选（SQL 层过滤 `status='active'`）→ token 重叠余弦重排取 top-N（注入限 8）
- CJK 处理（N1）：`tokenizeForFts` 拉丁整词 + CJK 单字/bigram（FTS unicode61 不分 CJK 词，bigram 是召回关键）
- MATCH 注入安全：所有 token 加引号，用户输入永远不能破坏 FTS 语法

### 2.3 注入组装（`src/injection.ts`）

- EVIDENCE 池 + Method + Guard 合并为**一条合成 user 消息**，插在最后一条真实 user 消息之前
- 上限：SKILL catalog ≤10（进 system prompt `<available_skills>`）、SOP schema ≤15（进 tools）、Method/Guard 各取 quality 前 5
- 过滤顺序固定：过滤非法 payload → quality 降序 → 截断（C2）
- 注入内容落 session 的 `custom_message` 条目（可审计、可回放）

### 2.4 进化管线（`src/offline/`）

- **ETL**（`etl.ts`）：session JSONL → 轨迹候选（pi v3 原生格式）
- **三条管线**（`pipeline.ts`，spawn vendored Python 包 `python/`）：
  - `skill_evolution.pipeline` → SKILL
  - `sop_lifecycle` → SOP
  - `verification_selection.pipeline` → ABILITY cards
  - 端点：`LLM_BASE_URL`+`LLM_MODEL`/`TEACHER_MODEL` 走真实 teacher（当前 DeepSeek v4-pro）；缺失时回退 MockLLM
- **verifier**（`verifier.ts`）：连续质量分 ≥0.5 → active；<0.5 丢弃（不建负面库）；dormant 可 rescore 复评
- **调度**（`schedule.ts`/`scheduler.ts`）：外部化 run-evolution CLI；生产 compose sidecar 24h evolution + 168h weekly-report
- **checkpoint**（`checkpoint.ts`）：每次运行记录（含失败），`/api/evolution/status` 可查

## 3. 在线调用链（含学生-老师）

```
client → agent-server → 检索+注入 → gateway(8787) → omlx 学生(gemma-4-12B)
                                        └ 门控四类证据（空输出/截断/schema错/forced tool缺失）→ DeepSeek 升级
```

- 门控判定在 `packages/agent-gateway/src/agent_gateway/quality.py`（只用可观测证据，不用启发式打分）
- 观测：`request_traces` 表 + `/stats` 命中率页 + `req=` 结构化日志（中文 kind 标签 + 注入标题）

## 4. 配置速查

| 项 | 位置 |
|---|---|
| 经验库 | `EXPERIENCE_STORE_PATH`（生产 var/，评估 var/eval/） |
| session 目录 | `AGENT_SERVER_SESSION_DIR` |
| 上游 | `GATEWAY_URL`（裸 base 不带 /v1）+ `AGENT_GATEWAY_KEY` |
| teacher | `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`/`TEACHER_MODEL`（.env, gitignored） |
| 注入上限 | `src/injection.ts` SKILL 10 / SOP 15 / Method 5 / Guard 5 |
| 晋升阈值 | `verifier.ts` 0.5 |

## 5. 验证状态（2026-07-30）

- 254 vitest（agent-server）+ 169 pytest（agent-gateway）全绿
- 生产在线：compose 三服务（server 8788 / evolution 24h / weekly-report 168h），DeepSeek teacher
- 评估：ALFWorld 三腿 A/B 进行中（L1 DeepSeek SR 6.7%；L2 学生管线运行中；L3 学生+注入排队）；学生负荷 omlx 71% / 升级 29%
- 命中率观测上线（O 里程碑）：生产 `/stats` 可查
