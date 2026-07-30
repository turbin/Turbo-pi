# Agent Server P1 工程规格：Skill/SOP 注入、离线进化、Session JSONL 对齐

**日期：** 2026-07-19
**分支：** `feature/agent-gateway-design`
**来源：** 用户决策（P1 全部一起做；离线模块作为 Python 子进程；pi session JSONL 对齐替换现有格式）
**目标：** 在 P0 基础上，实现 SKILL/SOP 在线注入、离线经验进化闭环、以及 pi 原生 session JSONL 落盘格式。

---

## 1. 方案决策

| 决策项 | 选择 | 理由 |
|---|---|---|
| 离线模块实现方式 | **Python 子进程** | handoff 中三个 impl 包（`skill_evolution`、`evidence_replay`、`verification_selection`）已用 Python 实现且经过测试；TS 重写成本高、风险大。TS agent-server 通过子进程调用 Python 离线 pipeline，通过文件/环境变量传递输入输出。 |
| Session JSONL 格式 | **替换为 pi 原生格式** | P0 的自定义 JSONL（`{type, data}`）与 pi tooling 不兼容；P1 直接对齐 pi session 格式（`type:"session"` header + `id`/`parentId` 树），便于后续 ETL 和 pi 生态互操作。 |
| 在线注入范围 | SKILL catalog + SOP schema + 已有 EVIDENCE/ABILITY | 对齐 SPEC §8 P1 验收标准。 |

---

## 2. 系统架构

```
agent client (Kimi Code / pi)
      │ POST /v1/chat/completions 或 /api/stream
      ▼
┌──────────────────────────────┐
│  TypeScript agent-server     │  ← 在线层
│  - /v1/chat/completions      │
│  - /api/stream               │
│  - 检索 + 注入 (SKILL/SOP/EVIDENCE/ABILITY) │
│  - pi session JSONL 落盘      │
│  - 离线 cron 调度（子进程调用） │
└────────────┬─────────────────┘
             │ OpenAI 兼容
             ▼
┌──────────────────────────────┐
│  Python agent-gateway        │  ← 模型路由层
│  - /v1/chat/completions      │
│  - omlx / DeepSeek provider  │
└────────────┬─────────────────┘
             ▼
       omlx (local) / DeepSeek (cloud)

离线侧：
┌──────────────────────────────┐
│  Python offline pipeline     │  ← 经验进化层
│  - impl_skill_evolution      │
│  - impl_evidence_replay      │
│  - impl_verification_selection│
│  - teacher = DeepSeek        │
└──────────────────────────────┘
```

---

## 3. 模块划分

### 3.1 TypeScript agent-server（新增/改造）

| 模块 | 功能 | 对应 SPEC |
|---|---|---|
| `src/injection.ts` | 扩展：支持 SKILL catalog 和 SOP schema 注入 | §4.1/§5.2 |
| `src/skill-catalog.ts` | 从 Experience Store 取 active SKILL，组装 `<available_skills>` | §4.1 |
| `src/sop-schema.ts` | 从 Experience Store 取 active SOP（≤15），组装 OpenAI function schema | §4.1 |
| `src/session-writer.ts` | 重写：输出 pi 原生 session JSONL 格式 | §3.4/§5.2 |
| `src/offline/scheduler.ts` | cron 调度，调用 Python 子进程 | §6 |
| `src/offline/etl.ts` | session JSONL → EVIDENCE 候选入库 | §3.4 |
| `src/offline/pipeline.ts` | 调用 Python 三管线（skill_evolution、sop、experience_card） | §4/§6 |
| `src/offline/canonicalize.ts` | TF-IDF blocking + 五 rubric 裁决 | §6 |
| `src/offline/verifier.ts` | TwoStageScorer 连续分，quality ≥ 0.5 | §4.3 |
| `src/offline/checkpoint.ts` | checkpoint 写入与回滚 | §6 |

### 3.2 Python 离线 pipeline（handoff 复现包）

| 包 | 功能 | 对应 SPEC |
|---|---|---|
| `impl_skill_evolution/` | MetaSkill-Evolve fast/slow loop | §4.1 |
| `impl_evidence_replay/` | ReContext 证据重放（P0 已用其思想） | §4.2 |
| `impl_verification_selection/` | Verifier + ExperienceCard + canonicalize | §4.3 |

TS server 通过 `child_process.spawn` 调用这些 Python 包的 CLI 入口，输入输出通过临时 JSON 文件传递。

---

## 4. 接口协议

### 4.1 在线：`POST /v1/chat/completions` / `POST /api/stream`

请求处理时序（扩展 P0）：
1. 解析 context.messages，取最后一条真实 user 消息为 query。
2. 检索 Experience Store：FTS bm25 top-24 → 余弦重排 top-8。
3. 组装注入：
   - SKILL catalog → systemPrompt 追加 `<available_skills>` XML。
   - SOP schema → tools 数组平铺（≤15）。
   - EVIDENCE/Method/Guard → 新 user 消息，插在最后一条真实 user 之前。
4. 转发给 Python gateway。
5. 流式事件透传/转换。
6. 落盘 pi session JSONL。

### 4.2 离线：cron 调度

每日一次或手动触发：
1. ETL：读增量 pi session JSONL，提取 EVIDENCE 候选（dormant）。
2. 轨迹采集：对训练任务集用 teacher 跑 no-skill 轨迹（每任务 ≥2 run）。
3. 三管线抽取（Python 子进程）：
   - `python -m skill_evolution.pipeline --input trajectories.json --output skills.json`
   - `python -m sop_lifecycle --input trajectories.json --output sops.json`
   - `python -m verification_selection.pipeline --input trajectories.json --output cards.json`
4. verifier 筛选：quality ≥ 0.5 才 active。
5. canonicalize：TF-IDF blocking + 五 rubric 裁决。
6. 入库：active 集更新、checkpoint 写入。

---

## 5. 数据流

### 5.1 在线重放（每请求）

```
client → agent-server
  → 解析 messages
  → 检索 Experience Store (SKILL/SOP/EVIDENCE/ABILITY)
  → 组装注入:
      - <available_skills> → systemPrompt
      - SOP schemas → tools
      - evidence/method/guard → user message before last real user
  → 转发 Python gateway
  → SSE 透传/转换
  → pi session JSONL 落盘
```

### 5.2 离线进化（cron）

```
pi session JSONL → ETL → EVIDENCE 候选
  → teacher 跑训练轨迹
  → Python 三管线抽取
  → verifier 筛选
  → canonicalize 去重合并
  → 入库 active + checkpoint
```

---

## 6. pi session JSONL 格式

替换 P0 的自定义 JSONL，对齐 pi 原生格式（v3，`packages/agent/src/harness/session/jsonl-storage.ts`）：

```jsonl
{"type":"session","version":3,"id":"...","timestamp":"2026-07-21T00:00:00.000Z","cwd":"...","metadata":{"model":"agent-auto","provider":"local"}}
{"type":"message","id":"...","parentId":null,"timestamp":"...","message":{"role":"user","content":"...","timestamp":...}}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"experience_injection","data":{"retrieved":["exp-1"]}}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"custom_message","data":{"messages":[...],"systemPrompt":"...","tools":[...]}}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"response_started"}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"stream_event","data":{"type":"text_delta","contentIndex":0,"delta":"..."}}
{"type":"message","id":"...","parentId":"...","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"api":"openai-completions","provider":"local","model":"agent-auto","usage":{...},"stopReason":"stop","timestamp":...}}
{"type":"custom","id":"...","parentId":"...","timestamp":"...","customType":"response_completed"}
```

关键特性：
- `type:"session"` header（`version:3`）：记录 session 元数据（id/timestamp/cwd/metadata）。
- 树状 entry（`{type, id, parentId, timestamp, ...}`）：`parentId` 链向前一条 entry，支持分支/回退；消息嵌套在 `message` payload 下。
- `type:"custom"` entry 以 `customType` 区分：`experience_injection`（检索结果）、`custom_message`（注入后的完整上下文，随会话重放）、`stream_event`（流事件）、`response_started`/`response_completed`/`error`/`aborted`（终态标记）。
- 流正常完成时重建的 assistant `message` entry 与 `stream_event` 并存；error/abort 时只留 `stream_event` + 终态 custom entry。

---

## 7. Experience Store Schema（扩展）

P0 已有 `experiences` + `experiences_fts`。P1 新增：

- `edges`（lineage/inspiration/merged_into）
- `sop_reviews`（SOP 生命周期评审记录）
- `canonical_units` / `unit_members`（canonical unit 聚合）
- `reasoning_cache`（两阶段打分缓存）
- `checkpoints`（进化 checkpoint）

---

## 8. 测试策略

- **单元测试（vitest）**：每个 TS 模块独立测试。
- **集成测试**：TS server → Python gateway 的端到端请求（用 FakeProvider 或 mock gateway）。
- **离线测试**：mock teacher 验证三管线抽取与 canonicalize。
- **live 验证**：Kimi Code 经 agent-server 到 omlx/DeepSeek，检查 skill/SOP 注入记录。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Python 子进程调用失败/超时 | 设置 timeout、捕获 stderr、失败时保留上一 checkpoint |
| 离线 pipeline 与在线 schema 不一致 | 共享 `experiences` SQLite schema；Python pipeline 只写 dormant，verifier 后才 active |
| SOP schema 注入膨胀 | 硬上限 ≤15，按成功率降序 |
| pi session JSONL 格式复杂 | 参考 `packages/agent/src/harness/session/jsonl-storage.ts` 实现 |

---

## 10. 实施路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1.1** skill catalog + SOP schema 注入 | 在线请求能消费 SKILL/SOP 经验 | mock benchmark 显示 skill/SOP 被注入；live 验证 Kimi Code 响应包含 skill/SOP 内容 |
| **P1.2** 离线进化 pipeline | cron 调用 Python 子进程，产出 active 经验 | mock 模式下三管线产出经验；checkpoint 可回滚 |
| **P1.3** pi session JSONL 对齐 | 落盘格式与 pi 原生格式一致 | pi session-manager 能回放落盘文件；ETL 能解析 |

---

## 11. 参考 Spec

- `doc/design/HANDOFF.md`
- `doc/design/SPEC.md`（原 v1.0）
- `doc/design/2026-07-18-agent-server-experience-replay-spec.md`
- `doc/design/2026-07-18-agent-server-v1.1-p0-plan.md`
