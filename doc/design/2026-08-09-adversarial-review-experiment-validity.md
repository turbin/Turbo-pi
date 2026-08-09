# 2026-08-09 实验有效性对抗性审查（门控 length 缺陷同类 bug 全链路排查）

状态：**审查完成，修复分批待用户拍板（P0/P1/P2）**。
触发：B 阶段门控 length 缺陷（issue-003）暴露"harness/中间件配置可静默改变被测对象"这一缺陷类。本文档对全链路做对抗性审查，假设每一行都藏着同类 bug，逐一对照代码验证。
方式：3 路并行对抗审查（agent-gateway Python / eval harness / agent-server TS 链路），所有发现均有代码行级证据。
关联：`doc/issues-snapshot/issue-003-gate-length-misescalation.md`；`doc/design/2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md`。

## 1. 对 issue-003 修复方案的代码核查结论（对方案 A 的两处修正）

1. **"冷库臂改 agent-local 绕开门控"不成立**：`routing.py:26-32` `select_provider` 第一行 `del envelope, context`——V1 路由完全忽略 model 名，`agent-local` 仅是 `allowed_models` 逻辑名（config.example.toml:57），无任何绕门控语义。实现绕门控需改 gateway 代码，不值得；max_tokens 调大后 length 误杀趋近 0，保留门控（empty_output/invalid_tool 是真实质量信号）反而更接近生产口径。**建议：双臂统一 agent-auto + 调大 max_tokens。**
2. **max_tokens=800 是拍脑袋值，需 pilot 校准**：冷库 5 局 pilot 实测 finish_reason 分布 → 定 800/1024 → 全量；验收预注册门槛 = model_runs 全量口径 length 升级率 <5%。

兼容性已核查：`extract_command()` 取最后一个动词行，max_tokens 调大不破坏提取；热库臂注入 prompt 变长但 contextWindow 128k 无压力；升级腿 DeepSeek 在 800 下更不会触顶。C 阶段 `campaign.py:85-90` 未设 max_tokens，无此缺陷。

## 2. 发现汇总（39 项：4 critical / 21 major / 14 minor）

### 2.1 CRITICAL（直接导致实验结果无效或不可审计）

| # | 位置 | 问题 | 修复建议 |
|---|---|---|---|
| C1 | `eval/campaign.py:65,89,168` | **C 阶段 runner 根本无法运行**：`run_agent(client, model, prompt, ws, timeout_s)` 无 `injection` 参数，89 行 `extra_body={"injection": injection}` NameError、168 行 `run_agent(..., injection=...)` TypeError——首个真实任务即崩；`tests/test_campaign.py` 只测 plan/metrics。committed 代码从未跑通，A/B 核心接线（per-arm injection）从未被 exercised | 加 `injection: bool` 参数；补 run_agent mock 冒烟测试 |
| C2 | `eval/campaign.py:179` + `campaign_metrics.py:25-28` | **预注册判据结构性永绿**：`"escalated": False` 硬编码，标注脚本全仓不存在 → escalation_rate 恒 0，判据①（≤0.05）②（<0.20）永远通过——与 length 缺陷同类：度量与现象脱钩，两臂云主导时一切读绿 | 跑分前 join gateway model_runs 标注；`check_criteria` 遇未标注行拒绝出结论（fail loud） |
| C3 | `eval/alfworld_agent.py:154` | **134 硬编码无回绕保护**：textworld `shuffled_cycle`（textworld_batch.py:100）池尽回绕重放。已核实历史数据：`results/alfworld-20260730/control-full.jsonl` 134 行仅 117 个唯一 gamefile，117-133 行为重放，而 experiment/student-full 均 134 唯一——该轮 17/134（12.7%）A/B 对错位（两臂玩的不是同一局） | 以 `len(env.game_files)` 为界；池大小≠预期硬失败；每条记录写池大小+池 hash |
| C4 | gateway `chat.py:434-445` + `providers/base.py:59-65` | **升级结果不过闸 + max_tokens 原样上云**：`finish_escalation` 直接返回云端 result，无第二次 `evaluate_quality`；length 升级的请求以同样 200 cap 打 DeepSeek，云端再截断也按 `state="succeeded"` 落库——同一缺陷在云端隐形复发 | 升级结果至少观测（cloud 仍 length 时显式标记/告警）；或升级腿解除 max_tokens 限制 |

### 2.2 MAJOR（21 项，按主题归并）

**可观测性缺失（本次缺陷两个跑批周期未被发现的总因）**

- M1 gateway 响应无升级标记：`"model": envelope.model` 恒为逻辑名，usage 取最终 result（升级后=云端）（`chat.py:86-117`）；client 侧日志把云端补全记在本地模型名下，真相只在 model_runs。→ 响应加 `x-gateway: {escalated, reason, provider}` 字段 + SSE 事件。
- M2 usage=0 根因（三腿报告遗留 follow-up 确诊）：`gateway-client.ts:45-49` 流式从未请求 `stream_options.include_usage`，gateway 只在请求时才发 usage chunk（`chat.py:617`、`sse.py:99-111`）→ `done.usage` 恒 zeroUsage，request_traces/alfworld 记录全 0。一行修复即可恢复 token 观测——本可第一时间暴露 length 缺陷（completion_tokens 顶格签名）。
- M3 所有 harness 不记录 finish_reason / served provider（eval/ 无任何文件读这两字段）→ 每步记录，length 即告警。
- M4 usage 上报不一致：sse.py:39-44 None→0 零填充 vs chat.py:111-116 全 None 则省略——同一条件两种 client 可见形态。→ 统一 unknown 即省略，不零填充。

**A/B 臂间不对称（除注入外的隐藏变量）**

- M5 实验臂双 system message：`server.ts:198-202` context.systemPrompt=undefined，harness 的 system 留在 messages；注入时 `injection.ts:84-87` 把 skill catalog 提为 systemPrompt，`openai-compat.ts:42-44` 将其 prepend 为第一条 system——控制臂 `[system(harness), user]`，实验臂 `[system(skills), system(harness), user(evidence), user]`，prompt 骨架不对称且随库存活 SKILL 数变化。→ catalog 并入既有 system 内容，不新建消息。
- M6 检索/存储错误只炸实验臂：`retrieve` 仅 injectionOn 时调用（proxy-handler.ts:64-65），SQLITE_BUSY 等失败 → 502；控制臂无此失败面。campaign.py 无 try/except，一个 502 杀死整轮。→ 失败面对称化；检索失败=整轮 loud fail。
- M7 截断 tool call 硬 502、截断文本静默放行：`toolcall-validator.ts:331-340` vs alfworld 忽略 finish_reason（:130）；实验臂 prompt 更长更易截断 → 臂偏。→ 截断 tool call 改为观测传递（finish_reason=length 下发），harness 判失败样本。
- M8 `harness.py:46-47`（控制臂直连 DeepSeek）与 `run-full-arm.sh:10-14`（控制臂走 8899 中继）物理旁路 8789——违反 08-05 决策（agent-server/AGENTS.md:17），注入与后端两个变量混杂，控制臂 session 不进学习回路。→ 控制臂统一 8789 + injection:false。
- M9 gateway `thinking` 参数只透传云端（kimi.py:70 `forward_thinking=True`）、omlx 丢弃（omlx.py:59 无 flag），且 `reasoning_content` 从不解析（base.py:102 只读 content）→ 本地模型若默认 thinking-on，content=null 误判 empty_output 升级。→ omlx 透传 thinking / 解析 reasoning_content 并入 content。

**非平稳性与环境漂移**

- M10 经验库无快照/只读：实验臂每请求实时检索（proxy-handler.ts:64-65），`buildInjection` 无条件附 skill catalog + SOP（injection.ts:84-101）；两臂顺序执行，期间任何库写入（手动进化、scheduler dormant 提升、TTL 清理）改变处理本身；唯一防线是 AGENTS.md:46 的人工纪律。→ campaign 开始快照 active 集（`AGENT_SERVER_STORE_READONLY=1` 或 created_at 过滤）。
- M11 preflight 只探活不验指纹：`_probe` 任何 HTTP 状态算过（preflight.py:61-70）；`ensure_omlx` 不校验加载的模型 id（:96-101）；`ensure_agent_server` 不校验 store 路径/injection 默认值，auto-start 还不传 AGENT_SERVER_INJECTION（:127-141）→ 陈旧/错配实例静默通过。→ 校验 /v1/models 模型 id + `/api/status/chain` 配置指纹，存疑即 fail 而非 auto-start。
- M12 gateway 预算机制时间相关：升级按全额预扣记账（chat.py:378，$0.10/次与实际无关）；触顶后臂行为中途翻转（429/422）；`release_quietly` 吞错 + reconcile 失败 → 预留永久泄漏无清扫；自然月窗口跨月即重置（:321）。→ 实验窗口预算 + 泄漏清扫告警 + 按估算实际计费。
- M13 每 key 渠道配置（cloud_egress_allowed/monthly_budget）可臂间不同（channel.py:34-42、config.py:75-83），无任何告警。→ 跑批 runbook 断言 + 启动逐渠道日志。

**harness 工程缺陷**

- M14 `--start N` 不推进 env 迭代器：`alfworld_agent.py:154-155` 只改计数器，`env.reset()` 仍从池首取（textworld_batch.py:117），`env.skip()`（:124）存在未用——分片/续跑结果归属错局。→ `env.skip(args.start)` 或废弃 --start 改 gamefile 断点。
- M15 append 模式无去重：alfworld_agent.py:152 / campaign.py:161；崩溃重跑同参数 → 整局/整日重复记录，metrics 双计。→ 打开时读已有 game_idx/(day,task_id,arm) 跳过。
- M16 `extract_command()` 正则无词边界（"because"内含"use "、"mistake"内含"take "）、last-match-wins、"think:" 劫持丢真实观测（alfworld_agent.py:63-73,189-190）；注入改变叙述风格 → 提取失败率臂偏，分数差可归因于提取器伪影。→ 行锚定 `^\s*` + 词边界 + 优先最后非 think: 匹配 + 失败率分臂记录。
- M17 harness.py：轨迹不存档（:248-259 不返回 messages）、cost/timeout 死代码（:39,42,171）、client 60s 硬超时（:155）对慢本地臂不对称、archive_sessions 删共享目录全部 session（:309-329）。→ 存档消息列、删死旋钮、超时对齐本地延迟、只归档本轮 session。
- M18 synthesize_alfworld_sessions 伪造 task-context：alfworld 不记 init_prompt（四个结果文件均无），:82-88 fallback 永远触发——"任务上下文"含完整轨迹（自泄漏）且轨迹二次出现；session id 硬编码 `alfworld-27b-cold-` 前缀（:38）跨臂碰撞、输出文件互相覆盖。→ alfworld 记录 init_prompt（一行）+ 合成器缺失即硬失败 + id 前缀参数化。

**数据完整性（gateway 内部）**

- M19 幂等重放缓存 5xx/429 成永久失败（chat.py:790-793 缓存一切 GatewayError）；取消/崩溃的 keyed 请求永久毒化 Idempotency-Key（取消路径不释放 key；trace_store.py:343 只释放 deadline_exceeded 不释放 lease_expired）→ 重试永远 409。→ 仅缓存确定性 4xx；取消/租约恢复且无响应落盘时释放 key。
- M20 流式升级前置失败后无声断流：`begin_escalation` 在 try 外（chat.py:559-568），heartbeat 已提交 200 头，此时 budget/egress 失败 → 连接直接死，client 记到截断的"成功"200。→ 纳入 bytes_sent → SSE 错误事件处理（对齐 :538-543）。
- M21 omlx 把所有非 200（含确定性 400，如 context 超长）映射 502 upstream_unavailable（omlx.py:68-72）→ 重试客户端反复重发，失败记账膨胀；带 key 时与 M19 叠加成粘滞 502。→ 上游 4xx 透传为 4xx。

### 2.3 MINOR（14 项，技术债）

- gateway：门控顺序——截断中 tool-call（JSON 坏 + length）误标 invalid_tool_schema，扭曲升级原因分布（quality.py:88-91 应先查 length）；空判定谓词不一致（门控 `not content` vs 信号 `content is None`，chat.py:135）；`tool_choice="required"` 无 tool call 不过闸（quality.py:94）；上游 finish_reason null/非字符串 → 502（base.py:95-97，应接受 null 映射为可门控值）。
- eval：`final_day=max(day)` 冒充 D7 + 空切片 escalation_rate([])=0 平凡通过（campaign_metrics.py:26-27,58-65，应判 inconclusive）；campaign 超时仅记 transcript、status 仍 completed（campaign.py:80-83,109）；d3_discriminate 位置选案（:41,50）+ 过期参数 max_tokens=100/stop（:73-74），其 EMPTY 率结论不迁移到现 harness；harness.py:245 `"DONE" in content.upper()` 误判；judge 模型由环境变量漂移（campaign.py:112-119 注释称 DeepSeek，lib_grading.py:27 默认 claude-opus），judge 输入截断 500 字符不可审计。
- agent-server：采样参数白名单静默丢 seed/top_p/response_format/tool_choice 等（server.ts:203-211、proxy-handler.ts:171-174，复现审计受损）；`traceStreamCompletion` finishReason 缺省 "stop"（server.ts:599，latent）；eval session 的 OpenAI tool 结构对进化 ETL 不可见（pipeline.ts:218-241、etl.ts:42 只认 pi 原生 part）+ 一请求一 session 文件双重计数风险；非文本 content part 静默丢弃 + 流式路径 console.log 全量 prompt（server.ts:176-184,237）。

## 3. 已验证干净的区域（不再复查）

- gateway：预算预留原子性（BEGIN IMMEDIATE 单事务）；trace CAS 状态机无跨 provider 调用持事务；model_runs 归属正确（primary 先于门控落库、escalation sequence=2 带 reason）；幂等重放不产生重复 model_runs；DLP 扫描与落盘；租约生命周期全路径清理。
- agent-server：injection:false 真跳过检索/注入且 session/trace 照录（disabled:true 标记区分关与未命中）；无静默空注入（检索失败=loud 502，零命中仍注 catalog 并记 hit=0）；session 命名无碰撞；参数转发流式/非流式一致；无 prompt 截断；finish_reason 端到端保真；进化未接入 server 启动；生产 docker 与 eval 库物理隔离（除非显式覆盖 env，见 M10）；weekly-report 只读；验证管线单事务提升（verifyAndCanonicalize，quality≥0.5 + contentHash 去重，失败不半晋升）。
- eval：campaign_plan 分层划分确定性无泄漏（seed=42，测试覆盖最完善）；ALFWorld 排序跨进程确定（sorted + RandomState(1234)，池一致前提下——C3 的失败模式是池内容分歧而非 RNG）；harness.py 拒绝复用已有 run 目录。

## 4. 历史数据影响提示

C3 证实 `alfworld-20260730` 控制臂 17 局为重放（A/B 错位 12.7%）；E5 热库轮（11/134 vs 10/134）及三腿报告若引用过该轮数据需注明口径。建议下轮报告前统一复核哪些历史结论依赖该数据集。C1 同时意味着：任何已存在的 C campaign 结果由非 committed 代码产生，来源不可审计。

## 5. 修复优先级建议（供用户拍板分批）

- **P0（下轮跑批前必修，否则结果仍不可信）**：C1-C4；M1-M3 可观测性三件套；M5 双 system；M8 控制臂旁路；M10 经验库快照；M11 preflight 指纹；M14/M15/M16/M18 alfworld 四件；max_tokens 参数化 + pilot 校准（issue-003 方案 A 修正版）。
- **P1（强烈建议）**：M4、M6、M7、M9、M12、M13、M17、M19、M20、M21。
- **P2（技术债另立任务）**：全部 minor；门控 length 规则策略讨论（findings 文档 §6.3 已记）。

## 6. 方法论教训（沉淀）

1. **烟囱测试通过 ≠ 真实运行可信**：smoke-02 5/5 通过恰因规模小、未触任何悬崖（超时/成本/池回绕/升级）；验收必须以全量口径核验 ground truth（model_runs），拒绝小样本外推。
2. **度量必须与现象同源**：C2 与 length 缺陷同构——度量管道与现象脱钩时一切读绿。任何预注册判据评审时必须追问"这个字段谁写、何时写、能否为假"。
3. **A/B 审计清单**：臂间差异必须恰好等于处理变量——prompt 骨架（M5）、失败面（M6/M7）、后端路径（M8）、库状态时点（M10）、实例指纹（M11）逐项核对。

Refer Spec：2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md（issue-003 根因与方案 A/B/C）；2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md（控制臂跑法决策，M8 违反项）；2026-08-05-agent-server-c-campaign-design.md（判据预注册，C2 破坏项）
