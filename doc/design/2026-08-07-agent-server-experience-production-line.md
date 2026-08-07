# 2026-08-07 经验生产线：分层架构与时序

状态：现役系统描述（B 阶段热库轮运行中）。本文是经验生产线的标准参照文档——描述**已实现并验证运行**的形态，未验证的效用判读见各阶段实验报告。

## 1. 生产线总述

经验生产线 = 一条"执行 → 记录 → 蒸馏 → 验证 → 回流"的闭环流水线：

```
在线执行（学生模型跑任务，经验注入辅助）
    ↓ 全量落盘（session JSONL + request_traces）
离线蒸馏（老师模型把轨迹提炼成卡片）
    ↓ 质量闸门（回放验证打分 ≥0.5）
经验库（active 卡片）
    ↓ 检索注入（次日/下轮执行时回流到 prompt）
在线执行（带经验的下一次执行）—— 闭环
```

四条红线（不可违反）：
1. 原始轨迹**从不直接注入**——只有蒸馏+验证后的卡片能进入 prompt（C 决策 3）
2. 失败轨迹不直接入库——只作离线归因输入，教训以程序化提取的 Guard 卡形式沉淀（2605.29463 红线）
3. 晋升阈值 0.5 统一，dormant 永不可见（SQL 层硬过滤 `status='active'`）
4. 评估库与生产库物理隔离（`var/eval/` 独立实例）

## 2. 分层架构图

```mermaid
flowchart TB
    subgraph L4["L4 评估与运维层"]
        EVAL["eval 跑批<br/>alfworld_agent / campaign"]
        PRE["preflight.py<br/>依赖探活+自动拉起"]
        DASH["Web 监控 /dashboard<br/>链路·命中率·日志"]
        ISSUE["doc/issues-snapshot<br/>问题登记+回归哨兵"]
    end

    subgraph L3["L3 离线进化层（每日/按需触发）"]
        ETL["ETL<br/>session→dormant 候选"]
        DIST["三管线蒸馏（DeepSeek）<br/>skill_evolution / sop_lifecycle<br/>/ verification_selection"]
        VER["回放验证打分<br/>C×K 评分 · 阈值 0.5"]
        CKPT["checkpoint 审计"]
    end

    subgraph L2["L2 经验层 agent-server :8789"]
        RET["检索 retrieve<br/>FTS bm25 top-24 → 余弦 top-8"]
        INJ["注入 buildInjection<br/>EVIDENCE块 / Method / Guard<br/>SKILL目录 / SOP工具"]
        SES["session 落盘 + request_traces<br/>（注入关闭也照录）"]
        STORE[("经验库 SQLite<br/>EVIDENCE·ABILITY(Method/Guard)<br/>SKILL·SOP")]
    end

    subgraph L1["L1 路由层 agent-gateway :8787"]
        GATE["质量门控<br/>空输出/格式崩坏检测"]
        ROUTE["路由<br/>本地优先 · 云兜底"]
    end

    subgraph L0["L0 模型层"]
        STU["学生 omlx :8000<br/>Qwen3.5-27B-Distilled 4bit"]
        TEA["老师 DeepSeek<br/>v4-flash（蒸馏/judge）"]
    end

    EVAL -->|OpenAI 兼容请求| RET
    RET --> STORE
    RET --> INJ --> GATE
    GATE -->|合格| STU
    GATE -->|升级| TEA
    GATE --> SES --> STORE
    SES -.->|每日归档| ETL
    ETL --> DIST --> VER --> STORE
    VER --> CKPT
    PRE -.-> EVAL
    DASH -.-> STORE
```

各层职责一句话：

| 层 | 职责 | 关键不变量 |
|---|---|---|
| L0 模型 | 执行与教学的算力 | 学生本地、老师云端，物理可断 |
| L1 路由 | 质量门控+升级 | 无状态，可独立替换 |
| L2 经验 | 检索、注入、记录 | 注入可关（injection=false），记录不可关 |
| L3 进化 | 轨迹→卡片的转化 | dormant→active 唯一通道是验证打分 |
| L4 运维 | 跑批、监控、问题追溯 | preflight 不过不起跑 |

## 3. 时序图

### 3.1 在线路径（每次请求）

```mermaid
sequenceDiagram
    participant A as 评估 agent<br/>(alfworld/campaign)
    participant S as agent-server :8789
    participant DB as 经验库 SQLite
    participant G as agent-gateway :8787
    participant M as omlx 27B :8000
    participant T as DeepSeek 老师

    A->>S: POST /v1/chat/completions<br/>(任务 prompt, injection 默认 on)
    S->>S: 取最后一条 user 消息作 query
    alt injection = on
        S->>DB: FTS bm25 top-24 → 余弦 top-8<br/>(仅 status=active)
        DB-->>S: EVIDENCE/Method/Guard/SKILL/SOP
        S->>S: buildInjection 组装注入块
    else injection = off（对照臂）
        S->>S: 跳过检索注入（trace 照录）
    end
    S->>DB: recordRequestTrace（命中构成）
    S->>G: 转发（注入后 prompt）
    G->>M: 学生优先
    alt 门控判定合格
        M-->>G: 学生输出
    else 门控判定不合格（空输出/格式崩坏）
        G->>T: 升级云端
        T-->>G: 老师输出
    end
    G-->>S: 响应
    S->>S: session JSONL 全量落盘<br/>（含模型实际所见 prompt）
    S-->>A: 响应（SSE/JSON）
```

### 3.2 离线路径（每日进化）

```mermaid
sequenceDiagram
    participant C as 触发器<br/>（手动/cron）
    participant P as run-evolution.ts
    participant FS as sessions 目录
    participant PY as Python 三管线
    participant T as DeepSeek（蒸馏）
    participant DB as 经验库 SQLite

    C->>P: 触发（AGENT_SERVER_SESSION_DIR 指向当日轨迹）
    P->>FS: collectTrajectories（任务级合成 session）
    FS-->>P: trajectories[]
    P->>DB: ETL：候选入池（status=dormant）
    P->>PY: skill_evolution / sop_lifecycle<br/>/ verification_selection
    loop 每条轨迹
        PY->>T: 蒸馏调用（Method/Guard/EVIDENCE 卡）
        T-->>PY: 候选卡片
        PY->>T: 回放验证打分（C 标准×K 重复<br/>thinking 关闭 + max_tokens 封顶）
        T-->>PY: 质量分
    end
    PY-->>P: cards / skills / sops
    P->>DB: 晋升：质量分≥0.5 → active<br/>其余留 dormant / removed
    P->>DB: dormant rescore + TTL 清理
    P->>DB: writeCheckpoint（成功/失败均记录）
    Note over DB: 次日在线路径的检索<br/>即可命中新卡（闭环）
```

## 4. 当前实证状态（08-07）

| 环节 | 状态 |
|---|---|
| 在线记录 | 已验证（session/trace 全量，含 injection=off 对照臂） |
| ETL→候选池 | 已验证（15,069 dormant，幂等） |
| 蒸馏产卡 | **已验证破零：41 Method + 62 Guard + 130 EVIDENCE active**（E5 为 0 程序级卡） |
| 验证闸门预测力 | ⏳ 检验中（B 热库轮：自评通过的卡是否有真实效用） |
| 回流增效 | ⏳ 检验中（热库 vs 冷库 15.7% 基线，8/9 出数） |

Refer Spec：2026-07-18-agent-server-experience-replay-spec.md（§5.1/§6）；2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md（三层化）；2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md（开关与同路径对照）
