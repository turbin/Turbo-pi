# 2026-08-13 经验学习系统：分层架构 / 时序 / 调用链 / 问题台账

状态：现役系统全量描述（C campaign D6 运行中）。本文取代 08-07 生产线文档成为**标准参照**。
素材来源：`doc/issues-snapshot/`（issue-001~011）、08 月决策记录、函数级代码调研（08-13）。

## 1. 系统总览

本系统验证的命题：**本地学生模型（Qwen3.5-27B）+ 经验学习 harness，能否在办公自动化域经教师少量指导后逐步独立，重复任务升级率趋近 0**。

核心机制闭环：在线执行（经验注入辅助）→ 全量记录（session+trace）→ 离线蒸馏（轨迹→卡片）→ 验证晋升（≥0.5 闸门）→ 回流注入。

四条红线：①原始轨迹从不直接注入 ②失败文本不入库（三层化：归因输入/程序化提取 Guard 卡）③晋升阈值 0.5 统一，dormant 永不可见 ④评估库与生产库物理隔离。

## 2. 分层架构图

```mermaid
flowchart TB
    subgraph L4["L4 评估与运维层"]
        EVAL["eval 跑批器<br/>alfworld_agent.py（ALFWorld）<br/>campaign.py（C 阶段办公 campaign）"]
        PRE["preflight.py<br/>依赖指纹校验+自动拉起"]
        GATE["gate_length_escalation.py<br/>升级率门控 <5% 才放行"]
        SNAP["snapshot_store.py<br/>跑批前冻结经验快照（M10）"]
        DASH["Web 监控 /dashboard<br/>链路·命中率·日志"]
        ISSUE["doc/issues-snapshot<br/>问题登记+回归哨兵（推送前门控）"]
    end

    subgraph L3["L3 离线进化层（每日/按需）"]
        ETL["ETL etlSessionFiles<br/>session→dormant 候选"]
        SYN["轨迹合成器<br/>synthesize_*_sessions.py<br/>（任务级，禁喂 per-request）"]
        DIST["Python 三管线（DeepSeek 蒸馏）<br/>skill_evolution / sop_lifecycle<br/>/ verification_selection"]
        VER["双阈值验证<br/>成卡 0.5（py）→ 晋升 0.5（ts）<br/>+ dormant rescore + TTL/cap 清理"]
        CKPT["checkpoint 审计<br/>（成功/失败均落账）"]
    end

    subgraph L2["L2 经验层 agent-server :8789"]
        RET["retrieve()<br/>FTS bm25 top-24 → 余弦 top-8<br/>（SQL 硬过滤 status=active）"]
        INJ["buildInjection()<br/>EVIDENCE 块 / Method≤5 / Guard≤5<br/>SKILL catalog≤10 / SOP schema≤15"]
        SW["SessionWriter + request_traces<br/>注入关闭也照录（学习回路不断）"]
        STORE[("经验库 SQLite<br/>live 库 + 跑批快照（读冻结写照旧）")]
    end

    subgraph L1["L1 路由层 agent-gateway :8787"]
        ENV["envelope 校验+准入<br/>allowed_models"]
        GATEQ["质量门控 evaluate_quality<br/>invalid_tool_schema / length<br/>/ empty_output / forced_tool_missing"]
        ESC["升级三重前置<br/>egress 许可→DLP→预算预留"]
        MR["model_runs 落库<br/>（升级率 ground truth）"]
        MARK["x-gateway 标记<br/>（响应头/SSE 注释行）"]
    end

    subgraph L0["L0 模型层"]
        STU["学生 omlx :8000<br/>Qwen3.5-27B-Distilled-4bit"]
        TEA["老师 DeepSeek<br/>v4-flash 蒸馏 / v4-pro judge"]
    end

    EVAL --> PRE --> GATE
    EVAL -->|"OpenAI 兼容请求<br/>（injection 开关随 body）"| RET
    RET --> STORE
    RET --> INJ --> ENV --> GATEQ
    GATEQ -->|合格| STU
    GATEQ -->|不合格| ESC --> TEA
    GATEQ --> MR
    GATEQ --> MARK
    STU --> SW --> STORE
    TEA --> SW
    SW -.->|每日归档| SYN --> ETL --> DIST --> VER --> STORE
    VER --> CKPT
    SNAP -.->|每日跑批前| STORE
    DASH -.-> STORE
```

层职责与不变量：

| 层 | 职责 | 关键不变量 |
|---|---|---|
| L0 模型 | 执行/教学算力 | 学生本地、老师云端；学生可独立断云运行 |
| L1 路由 | 门控+升级+计量 | 无状态；升级仅一次；云结果不再二次门控（C4） |
| L2 经验 | 检索/注入/记录 | 注入可关（injection=false），记录不可关 |
| L3 进化 | 轨迹→卡片转化 | dormant→active 唯一通道=双阈值验证；输入必须任务级 |
| L4 运维 | 跑批/监控/追溯 | preflight 不过不起跑；升级率门控 <5% 不放行；issue 必带回归哨兵 |

## 3. 时序交互图

### 3.1 在线路径（每次请求，含门控与标记）

```mermaid
sequenceDiagram
    participant A as 评估 agent<br/>(campaign/alfworld)
    participant S as agent-server :8789
    participant DB as 经验库（快照）
    participant G as agent-gateway :8787
    participant M as omlx 27B :8000
    participant T as DeepSeek

    A->>S: POST /v1/chat/completions<br/>(prompt, tools, injection 开关)
    S->>S: lastUserText() 提取 query
    alt injection = on（实验臂）
        S->>DB: retrieve()：bm25 top-24 → 余弦 top-8<br/>（仅 active；跑批期读冻结快照）
        DB-->>S: EVIDENCE/Method/Guard/SKILL/SOP
        S->>S: buildInjection() 组装注入块<br/>（Method/Guard 各按 quality 取 ≤5）
    else injection = off（对照臂）
        S->>S: 跳过检索注入（session/trace 照录）
    end
    S->>DB: recordRequestTrace（命中构成/开关态）
    S->>G: 转发（stream_options.include_usage 恒开）
    G->>G: envelope 校验 + 准入 + 幂等检查
    G->>M: primary 调用（seq=1）
    M-->>G: 结果（content/finish_reason/usage）
    G->>G: evaluate_quality() 四规则门控
    alt 门控接受
        G-->>S: 本地结果
    else 门控升级（仅一次）
        G->>G: egress 许可 → DLP 扫描 → 预算预留
        G->>T: escalation 调用（seq=2）
        T-->>G: 云端结果（不再二次门控，length 仅告警）
        G-->>S: 云端结果
    end
    G-->>S: x-gateway 标记（escalated/reason/provider）
    S->>S: session 落盘（含模型实际所见 prompt<br/>+ gateway_marker custom entry）
    S-->>A: 响应（SSE/JSON，x-request-id 贯穿）
```

### 3.2 离线路径（C campaign 每日夜间循环）

```mermaid
sequenceDiagram
    participant R as runbook（夜间）
    participant FS as sessions/transcripts
    participant P as run-evolution.ts
    participant PY as Python 三管线
    participant T as DeepSeek（蒸馏）
    participant DB as 经验库（live）
    participant S as agent-server :8789

    R->>FS: ①归档当日 sessions（tar）并清空（防泄漏）
    R->>FS: ②合成任务级轨迹<br/>synthesize_campaign_sessions.py
    R->>P: ③触发 runDailyEvolution(inputDir=合成目录)
    P->>DB: ETL：候选入池（dormant）
    P->>PY: trajectories.json → 三子管线
    loop 每条轨迹
        PY->>T: 蒸馏（Method/Guard/EVIDENCE 卡）
        PY->>T: 验证打分（C×K，vs_reference 口径<br/>thinking 关闭+max_tokens 封顶）
    end
    PY-->>P: cards/skills/sops.json
    P->>DB: 晋升：双阈值 0.5（成卡+晋升）<br/>批内 contentHash 去重
    P->>DB: dormant rescore + TTL 30 天/cap 10000 清理
    P->>DB: writeCheckpoint（成功/失败均落账）
    R->>DB: ④snapshot_store.py 生成次日快照
    R->>S: ⑤重启 8789 换载快照
    Note over S: 次日批次检索冻结快照<br/>（被测对象不中途变化）
```

## 4. Call Graph（函数级调用链）

### 4.1 在线请求链（agent-server）

```
server.ts: createServer()
├─ POST /api/stream → handleStream()                    proxy-handler.ts:47
└─ POST /v1/chat/completions                            server.ts:157
     ├─ stream=true：内联管线（retrieve→buildInjection→toOpenAIRequest
     │   →GatewayClient.stream→teeOpenAISSEWithSession→traceStreamCompletion）
     └─ stream=false：handleStream() 收干 SSE 聚合 JSON

handleStream()                                          proxy-handler.ts:47
├─ SessionWriter.writeSessionHeader()                   session-writer.ts:33
├─【分支】injection 开关：body.options?.injection ?? opts.injection ?? true
├─ lastUserText()                                       proxy-handler.ts:130
├─ retrieve(store, query, 8)                            retrieval.ts:12
│   ├─ buildFtsQuery()（CJK 字+bigram）                 retrieval.ts:31
│   ├─ store.search()（FTS5 bm25，status='active'）     experience-store.ts:330
│   └─ cosineScore() 重排 top-8                         retrieval.ts:53
├─ store.recordRequestTrace()                           experience-store.ts:385
├─ logTrace()（stdout + 文件 sink）                     observability.ts:58
├─ buildInjection(context, retrieved, {store})          injection.ts:27
│   ├─【阈值】METHOD_LIMIT=5 / GUARD_LIMIT=5（quality 排序截断）
│   ├─ evidence/Method/Guard 合成块插入最后 user 消息前
│   ├─ buildSkillCatalog(store, 10)                     skill-catalog.ts:9
│   └─ buildSopSchemas(store, 15)（重名请求侧胜出）     sop-schema.ts:8
├─ toGatewayRequest()→toOpenAIRequest()（include_usage 恒开） openai-compat.ts:40
├─ GatewayClient.stream()                               gateway-client.ts:46
├─ validateToolCallStream()（对合并 tools 出站校验）    toolcall-validator.ts:212
├─ recordStreamEvent()（done 时 buildAssistantMessage 回写）
└─ teeWithSessionClose()（终态恰好一次关闭）
```

### 4.2 gateway 路由链

```
api/chat.py: chat_completions()  POST /v1/chat/completions    :751
├─ ChatCompletionEnvelopeV1.model_validate()
├─【分支】model ∉ allowed_models → 403
├─ select_provider() → RouteDecision("omlx")（V1 恒本地优先）  routing.py:26
├─【分支】Idempotency-Key 命中 → 直接回放                     :708
├─ store.create_trace()（queued→leased→run_started）          store/trace_store.py
├─ stream=true → stream_traced_events()                       :567
└─ stream=false → execute_with_escalation()                   :512
     ├─ OmlxProvider.complete()（semaphore 并发闸+httpx）     providers/omlx.py:58
     ├─ record_succeeded_run(seq=1, purpose=primary)          → model_runs 落库
     ├─【分支】evaluate_quality()                             quality.py:86
     │   四规则：invalid_tool_schema / finish_reason_length
     │           / empty_output / forced_tool_missing
     │   escalate=False → ACCEPT 返回
     └─ escalate=True → escalate_to_cloud()（仅一次）         :448
          └─ begin_escalation()                               :321
               ├─ egress 不允许 → 422 local_quality_rejected
               ├─ scan_envelope() DLP 命中 → 403              security/dlp.py
               ├─ BudgetLedger.reserve() 超 cap → 429         store/budget_ledger.py
               └─ KimiProvider.complete()（OpenAI 兼容云端）  providers/kimi.py:69
          └─ finish_escalation()：ledger.reconcile()
               + record_succeeded_run(seq=2, purpose=escalation)
               （C4：云结果不再二次门控，length 仅告警+落库）
└─ 响应：build_openai_response() + x-gateway 标记             :120
```

### 4.3 离线进化链

```
run-evolution.ts: cmdRun()                                   :99
└─ runDailyEvolution(store, {inputDir})                      scheduler.ts:81
   ① etlSessionFiles()（session→dormant 候选）              etl.ts:38
   ② runOfflinePipeline(inputDir, outputDir)                 pipeline.ts:78
      ├─ collectTrajectories()→parseSessionFile()            pipeline.ts:193/206
      ├─ a) skill_evolution.pipeline（无 --benchmark 输出 []）
      │     EvolutionRunner：Analyzer/Retriever/Allocator/Proposer/Evolver
      ├─ b) sop_lifecycle.main()（CONSTRUCTOR→MERGER，epochs=1）
      └─ c) verification_selection.pipeline._cli()           pipeline.py:244
            └─ select_experiences()                          pipeline.py:102
                 ├─ 多轨迹同 task → Verifier.select_best()（PPT 锦标赛）
                 ├─ 单轨迹 → score_pair(vs REFERENCE)（Bradley-Terry）
                 ├─【阈值】quality≥0.5 才 _extract_card()
                 └─ canonicalize(theta=0.82) 入库
   ③ promoteStagedOutputs()                                  verifier.ts:237
      └─ verifyAndCanonicalize()【晋升阈值 0.5】             verifier.ts:58/30
   ④ dormant rescore（--rescore CLI，同口径重打分）
   ⑤ removeDormantBefore()（TTL 30 天 / cap 10000）
   ⑥ writeCheckpoint()（失败时 cmdRun 捕获写 metric=0 失败 ckpt）
```

## 5. 设计机制详述

### 5.1 门控机制（gateway quality gate）

**定位**：本地模型输出的质量守门员，决定"接受本地结果"还是"升级云端"——成本与质量的平衡点。

**判定规则**（`quality.py: evaluate_quality`，按序四条，命中即升级）：

| 规则 | 触发条件 | 意图 |
|---|---|---|
| invalid_tool_schema | toolCall 参数不满足最小 schema | 防格式崩坏 |
| finish_reason_length | 输出被 max_tokens 截断 | 防不完整输出 |
| empty_output | content 与 tool_calls 双空 | 防空响应（gemma EOS 问题起源） |
| forced_tool_missing | 强制工具未出现 | 防协议违背 |

**升级链路**：`begin_escalation` 三重前置——egress 许可（422）→ DLP 扫描（403）→ 预算预留（429）→ 云端调用（仅一次，云结果不再二次门控，C4）。

**可观测性**：`x-gateway` 标记（非流式响应头/流式 SSE 注释行 + body 内嵌字段）随响应下发；`model_runs` 落库为 ground truth（sequence/purpose/provider/quality_signals）；两者互为印证，拒绝只信其一（M1/C2 决议）。

**已知缺陷**：`finish_reason_length` 对"叙述型模型 + 小 max_tokens"场景系统性误杀（issue-003，**待解决**——重跑方案待拍板；规则策略讨论留 P2）。跑批放行由 `gate_length_escalation.py` 把守（窗口内 length 升级率 <5%）。

### 5.2 经验卡机制（experience cards）

**卡片类型与注入形态**：

| 类型 | 内容 | 注入方式 | 限额 |
|---|---|---|---|
| EVIDENCE | 事实/工作流碎片 | `<Extra Info>` 合成块，插入最后 user 消息前 | 检索 top-8 |
| ABILITY:Method | 程序级方法步骤 | 同上合成块 | quality 前 5 |
| ABILITY:Guard | 护栏/教训（"注意："前缀） | 同上合成块 | quality 前 5 |
| SKILL | 技能描述 | `<available_skills>` 拼入 system prompt | catalog ≤10 |
| SOP | 可调用流程 | schema 并入 tools 列表（重名请求侧胜出） | ≤15 |

**生命周期**（状态机）：

```
ETL 候选（dormant）→ 蒸馏成卡（py 阈值 0.5）→ 晋升验证（ts 阈值 0.5）→ active
    ↑                      ↓ 不足                       ↓ 不足
    └── dormant rescore 重打分 ← dormant（留观）    丢弃
active → rescore 下滑 → 降回 dormant；dormant 超 TTL 30 天或超 cap 10000 → removed
```

**硬约束**：检索 SQL 层 `status='active'` 过滤——dormant/removed 物理不可达 prompt；原始轨迹从不入库注入（三层化红线）；失败轨迹只作离线归因输入，教训以程序化提取的 Guard 卡沉淀（禁自由诊断）。

**快照纪律**（M10）：跑批前 `snapshot_store.py` 冻结快照，跑批全程检索只读快照（被测对象不中途变化），写路径（trace/session/晋升）一律走 live 库。

**已知缺陷**：卡片缺"交付物"维度、闸门不验交付产出（issue-010，**待解决**——C 后统一修复）。

### 5.3 检索机制

`retrieve()`：取最后一条 user 消息原文为 query（无语义解析）→ FTS5 bm25 top-24（CJK 字+bigram 前缀，OR 拼接）→ 词袋余弦重排 top-8。无 embedding、无 LLM 参与。已知局限：字面匹配对措辞差异不敏感（语义检索是待建能力）；FTS 拉丁检索局限挂技术债。

### 5.4 注入开关与同路径对照机制

服务级 `AGENT_SERVER_INJECTION=off` + 请求级 `injection` 布尔覆盖（`/v1` body 或 `/api/stream` options）。**关闭语义**：跳过检索+注入（含 skill catalog/SOP schema），session 与 trace 无条件照录；session 中 `experience_injection.disabled=true` 区分"关"与"未命中"。对照臂与实验臂走完全相同代码路径——基线轨迹也进学习回路（08-05 决议，取代物理旁路）。

### 5.5 学习回路触发机制

触发器已从门控（步级形式失败）迁移到**局级胜负**（08-04 决议）：败局（won=False / score 低于阈）触发败局重放归因。R2 进料三路合并：学生轨迹 + 同局老师胜局 + 败局对照。C campaign 为每日批次全量进化（每日夜间 runbook 触发）。

### 5.6 奖惩机制

**现役（经验卡层面）**：晋升阈值（准入奖励）、dormant 留观/丢弃（准入拒绝）、rescore 降级（留用查看）、TTL/cap 清理（淘汰）。**行为层面无奖惩**——模型执行时收不到任何结果反馈信号。

**关键缺口**：闸门打分依据是裁判自评（"程序合理性"），与真实执行结果脱钩（issue-010 的结构性根源）。

**待建（已立项方向，C 后统一修复批次）**：卡片实战结果归因奖惩——request_traces.retrievedIds × 任务分数 join，得"卡×结果"关联；高分任务注入卡加分，重复失败任务注入卡降分/降 dormant/强制重验。质量控制：最小样本阈值防误杀；对照臂差值校准（相关≠因果）。不做 token 级 RL（与本地 4-bit 部署形态不兼容）。

### 5.7 运维保障机制

- **preflight 门禁**：跑批入口必过依赖指纹校验（omlx 模型列表/gateway 模型/8789 链路+injection 标志），自有服务 down 自动 nohup 拉起；omlx 只探活
- **Web 监控**：`/dashboard`（链路/命中率/日志，5s 自刷）+ `/api/status/chain` + `/api/logs`；`AGENT_SERVER_WEB=off` 可关（默认 on）
- **issue 登记制度**：`doc/issues-snapshot/`，每 issue 必带回归测试哨兵，推送前 `./test.sh` 门控
- **跑批纪律**：nohup 常驻 + 独立监视器 + caffeinate 防休眠 + 断点续跑（completed_keys）
- **批次层异常隔离**：任何局部失败（API 超时/工具超时/评分崩溃）降级为观察，永不穿透批次层（issue-008/009/011 沉淀）

## 6. 问题台账（issue-001~011）

### 6.1 待解决（open）

| # | 问题 | 根因 | 解决方案 | 状态 |
|---|---|---|---|---|
| 003 | 门控 length 缺陷致 B 阶段两臂 84-87% 误升级 DeepSeek，纯 27B 从未被测 | alfworld max_tokens=200 × 27B 叙述截断 × `finish_reason_length` 无条件升级（quality.py:90） | **重跑方案 A（推荐）**：max_tokens 800 双臂重跑（~4 天）；B：混合口径（0 成本）；C：仅冷库（~2 天）。P0 可观测性修复已落地（x-gateway 标记/门控脚本/指纹校验） | **待解决——等用户拍板方案** |
| 010 | 照卡执行挤占交付本能：注入卡片致重复集分数下滑（0.567→0.378 后回升 0.467） | 蒸馏模板缺"交付物"维度；验证闸门只验程序合理性不验交付产出 | 预列 4 项：①蒸馏模板加 deliverables 字段 ②闸门加交付物产出检查 ③存量卡重蒸馏 ④补"无交付轨迹拦截"回归测试 | **待解决——C 完成后统一修复（用户指令）** |
| 002 余留 | 管线分阶段断点持久化 | 任意阶段失败全量重跑（2-4h/次放大器） | 立项做断点持久化，或降级为已知风险/关闭 | **待解决——C 收口后用户决策** |

### 6.2 已解决（fixed，均带回归哨兵，一个发布周期无复发后转 closed）

| # | 问题 | 修复 | 回归测试 |
|---|---|---|---|
| 001 | Web 命中率 NaN%（snake_case↔camelCase 失配） | 页面字段名修正 | `test/regressions/issue-001` |
| 002 | 进化管线 logprobs 截断/缺 choices（三连故障） | 双 llm_client 重试 + 打分调用 thinking 关闭+max_tokens 封顶（提速 40-100×） | `python/tests/test_issue002_pipeline_resilience.py` |
| 004 | 非流式升级标记双层断裂（假绿） | body 内嵌 x_gateway + 非流式透传 | `test/regressions/issue-004` |
| 005 | 门控脚本无时间窗（永远 FAIL） | `--since`/`--last-hours` JOIN 窗口过滤 | `test_campaign.py` 2 例 |
| 006 | 快照模式写侧去重漏重 | 写路径查询改回 live 库 | `test/regressions/issue-006` |
| 007 | alfworld max_tokens 默认 200（缺陷原值） | 参数改 required（机制性防回退） | `test_alfworld_agent.py` |
| 008 | 单请求超时杀死批次（950s>300s） | timeout 1800s + 4 次退避重试 + 断点续跑 | `test_campaign.py` 3 例 |
| 009 | 工具超时未捕获杀死批次 | TimeoutExpired 转 toolResult 观察 | `test_campaign.py` 1 例 |
| 011 | QCB 评分脚本崩溃杀死批次 | safe_grade 降级 grading_error 行 | `test_campaign.py` 1 例 |

### 6.3 故障模式归纳（台账的元教训）

1. **局部异常穿透批次层**（008/009/011 三例同源）：原则已定——任何局部失败降级为观察，永不穿透批次层。
2. **小样本外推失真**（003 的 147 请求 bisect vs 全量 84%）：升级率必须 model_runs 全量口径核验。
3. **自评通过 ≠ 行为效用**（010）：验证闸门需要面向交付物的 outcome 检查。
4. **观测缺口即盲区**（004/005）：标记断裂造成假绿——标记与 model_runs 互为印证、拒绝只信其一（决议 M1/C2）。

## 7. 当前生效决议摘要（详见各决策记录）

- **失败经验三层化**（08-04）：原始失败文本不入库；败局作归因输入；Guard 卡程序化提取+回放验证（≤5）
- **注入开关与同路径对照**（08-05）：双臂同走 8789，对照臂 injection off；DeepSeek 直连臂例外
- **preflight 门禁 + 指纹校验**（08-05/M11）：跑批必过，模型列表/injection 标志精确匹配
- **C 判据预注册**（08-05）：重复任务升级率 D7≤5%、新任务 <20%，绝对阈值不可后改
- **快照纪律**（M10）：跑批全程检索冻结快照，写照走 live 库
- **门控只观测不改策略**（C4）：云结果不再二次门控，length 规则讨论留 P2
- **升级率全量口径**（08-09）：model_runs 为 ground truth，标记互为印证

Refer Spec：2026-07-18-agent-server-experience-replay-spec.md；2026-08-04-c3-amendment；2026-08-05-injection-toggle/web-monitor/c-campaign-design；2026-08-09-p0-fixes/27b-b-round-findings；doc/issues-snapshot/
