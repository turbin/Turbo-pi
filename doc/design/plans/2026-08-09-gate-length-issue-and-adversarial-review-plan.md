# 门控 length 缺陷 issue 登记 + 全链路对抗性审查与修复建议

任务：① 将门控 length 缺陷登记为本地 issue 并引用改造方案；② 对抗性审查全部相关代码，找出其他可导致实验失败的 bug，给出修改建议。

审查方式：3 个并行对抗审查 agent（agent-gateway Python / eval harness / agent-server TS 链路），全部发现均已对照代码行验证。

---

## 一、Issue 登记（issue-003）

新建 `doc/issues-snapshot/issue-003-gate-length-misescalation.md`：

- 状态：open；报告：2026-08-09（监控/复盘发现）
- 现象：B 阶段 27B 冷/热库两臂 84-87% 请求被升级到 DeepSeek，升级原因 100% = `finish_reason_length`；"纯 27B"从未被测，A 阶段 bisect"升级率 0%"结论作废，"云端成本归零"等 4 项结论撤回。
- 根因：`alfworld_agent.py:123` max_tokens=200（为命令提取所设）× 27B 叙述风格 → 截断 → `quality.py:90` 无条件升级；链路逐跳透传无防护（server.ts:205/283、proxy-handler.ts:172、providers/base.py:59-65）。
- 修复（引用改造方案）：指向 `doc/design/2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md` §5 方案 A/B/C + 本次审核修正版（见下节"对方案 A 的两处修正"）。
- 回归测试（red-first，随修复落地）：
  1. gateway 升级标记 pytest（tests/unit/test_escalation.py）：升级响应必须带可观测标记（配合发现 G3 修复）——先红后绿。
  2. 跑批前 gating 脚本：model_runs 全量口径 length 升级率门槛（<5%），不达标不开跑（制度化 §6.1 教训）。

同时更新 `doc/issues-snapshot/index.md`（加 issue-003 行，状态 open）。

### 对方案 A 的两处修正（代码核查结论，写入 issue 的修复引用）

1. **"冷库臂改 agent-local 绕开门控"不成立**：`routing.py:31` `del envelope`——V1 路由完全忽略 model 名，agent-local 无任何绕门控语义；要实现需改 gateway 代码，不值得。建议双臂统一 agent-auto + 调大 max_tokens。
2. **800 需 pilot 校准**：先冷库 5 局实测 finish_reason 分布定 max_tokens（800/1024），验收加 model_runs 全量口径 length 升级率 <5% 门槛。

---

## 二、对抗性审查发现汇总（39 项：4 critical / 21 major / 14 minor）

### CRITICAL（直接导致实验结果无效或不可审计）

| # | 位置 | 问题 | 修复建议 |
|---|---|---|---|
| C1 | `eval/campaign.py:65,89,168` | **C 阶段 runner 根本无法运行**：`run_agent` 无 `injection` 参数，89 行 NameError / 168 行 TypeError；committed 代码从未跑通过，任何已有 C 结果来源不可审计 | 加 `injection: bool` 参数；补 run_agent mock 冒烟测试 |
| C2 | `eval/campaign.py:179` + `campaign_metrics.py:25-28` | **预注册判据结构性永绿**：`escalated` 硬编码 False，标注脚本不存在 → escalation_rate 恒 0，判据①②永远通过——与本次 length 缺陷同类（度量与现象脱钩） | 跑分前 join gateway model_runs 标注；`check_criteria` 遇未标注行拒绝出结论 |
| C3 | `eval/alfworld_agent.py:154` | **134 硬编码无回绕保护**：textworld `shuffled_cycle` 池尽回绕重放。已核实 `results/alfworld-20260730/control-full.jsonl` 仅 117 个唯一 gamefile，117-133 行是重放——该轮 17/134（12.7%）A/B 对错位 | 用 `len(env.game_files)` 为界；池大小≠预期即硬失败；每条记录写池大小+池 hash |
| C4 | gateway `chat.py:434-445` + `providers/base.py:59-65` | **升级结果不过闸 + max_tokens 原样上云**：length 升级的请求以同样 200 cap 打 DeepSeek，云端再截断也按"升级成功"落库——同一缺陷在云端隐形复发 | 升级结果至少观测（cloud 仍 length 时显式标记/告警）；或升级腿解除 max_tokens 限制 |

### MAJOR（按主题归并，21 项）

**可观测性缺失（本次缺陷未被早发现的总因）**
- M1 gateway 响应无升级标记、`model` 恒为逻辑名、usage 是云端的（chat.py:86-117）→ 加 `x-gateway: {escalated, reason, provider}` 响应字段 + SSE 事件
- M2 usage=0 根因：`gateway-client.ts:45-49` 流式从未请求 `stream_options.include_usage` → 一行修复，恢复 token 观测（本可第一时间暴露 length 缺陷）
- M3 所有 harness 不记录 finish_reason/served provider → 每步记录，length 即告警
- M4 sse.py None→0 零填充与非流式 omit 不一致（sse.py:39-44 vs chat.py:111-116）→ 统一为 unknown 即省略

**A/B 臂间不对称（除注入外的隐藏变量）**
- M5 实验臂双 system message（server.ts:198-202 + injection.ts:84-87 + openai-compat.ts:42-44）→ catalog 并入既有 system 内容，不新建消息
- M6 检索/存储错误只炸实验臂（proxy-handler.ts:64-65 → 502；campaign.py 无 try/except 一炸全死）→ 失败面对称化，检索失败=整轮 loud fail
- M7 截断 tool call 硬 502、截断文本放行（toolcall-validator.ts:331-340）——实验臂 prompt 更长更易截断，臂偏 → 截断改为观测传递 + harness 判失败样本
- M8 `harness.py:46-47` 与 `run-full-arm.sh:10-14` 控制臂物理旁路 8789——违反仓库 08-05 规则，注入与后端混杂 → 控制臂统一走 8789 + injection:false
- M9 gateway thinking 参数只透传云端、omlx 丢弃，且 reasoning_content 不解析 → 空 content 误判 empty_output 升级（providers/base.py:41,72-73,102）→ omlx 也透传 thinking / 解析 reasoning_content

**非平稳性与环境漂移**
- M10 经验库无快照/只读：实验臂每请求实时检索，跑批期间任何库写入（手动进化、dormant 提升、TTL 清理）改变处理本身 → campaign 开始快照 active 集（只读模式或 created_at 过滤）
- M11 preflight 只探活：任何 HTTP 状态算通过；不校验 omlx 加载的模型、8789 的 store 路径/injection 默认值（preflight.py:61-70,96-101,127-141）→ 校验 /v1/models 模型 id + /api/status/chain 配置指纹
- M12 gateway 预算机制时间相关：全额预扣、泄漏无清扫、自然月窗口跨月重置（chat.py:321,378,448-452）→ 实验窗口预算 + 泄漏清扫 + 按实际计费
- M13 每 key 渠道配置（egress/budget）可臂间不同（channel.py:34-42）→ 跑批 runbook 断言 + 启动日志

**harness 工程缺陷**
- M14 `--start N` 不推进 env 迭代器，游戏标号错位（alfworld_agent.py:154-155；env.skip 存在未用）→ `env.skip(args.start)` 或废弃 --start 改 gamefile 断点
- M15 append 模式无去重：崩溃重跑整局/整日重复记录（alfworld_agent.py:152、campaign.py:161）→ 打开时读已有 key 跳过
- M16 extract_command 正则无词边界（"because"匹配"use "）、last-match-wins、think: 劫持丢观测（alfworld_agent.py:63-73,189-190）；注入改变叙述风格 → 提取失败率臂偏，分数差可归因于提取器 → 行锚定+词边界+排除 think: 优先+失败率分臂记录
- M17 harness.py 无轨迹存档、cost/timeout 死代码、60s 超时臂不对称、archive 删共享目录全部 session（harness.py:155,171,248-259,309-329）→ 存档消息列、删死旋钮、实验臂超时对齐本地延迟、只归档本轮
- M18 synthesize_alfworld_sessions 伪造 task-context（含完整轨迹自泄漏+内容翻倍）；session id 硬编码 cold 前缀跨臂碰撞（:38,82-88）→ alfworld 记录 init_prompt + 缺失即硬失败 + id 前缀参数化

**数据完整性（gateway 内部）**
- M19 幂等重放缓存 5xx/429 成永久失败（chat.py:790-793）；取消/崩溃的 keyed 请求永久毒化 Idempotency-Key（chat.py:241-277,660-664；trace_store.py:343）→ 仅缓存确定性 4xx；取消/租约恢复时释放 key
- M20 流式升级前置失败后无声断流：200 无错误事件无 [DONE]（chat.py:559-568 在 try 外）→ 纳入 bytes_sent 错误事件处理
- M21 omlx 把所有非 200（含确定性 400 如 context 超长）映射 502（providers/omlx.py:68-72）→ 上游 4xx 透传为 4xx

### MINOR（14 项，技术债）

- gateway：门控顺序致截断中 tool-call 误标 invalid_tool_schema + 空判定谓词不一致（quality.py:88-93 vs chat.py:135）；tool_choice="required" 不过闸（quality.py:94）；finish_reason null → 502（providers/base.py:95-97）
- eval：final_day=max(day) 冒充 D7 + 空切片判据平凡通过（campaign_metrics.py:26-27,58-65）；campaign 超时只记 transcript、status 仍 completed（campaign.py:80-83,109）；d3_discriminate 位置选案+过期参数（:41,50,73-74）；harness.py "DONE" 子串误判（:245）；judge 模型由环境变量漂移（campaign.py:112-119 + lib_grading.py:27）
- agent-server：采样参数白名单丢 seed/top_p 等（server.ts:203-211）；finishReason 缺省 "stop"（server.ts:599）；eval session 的 tool 结构对进化 ETL 不可见 + 一请求一 session 文件（offline/pipeline.ts:218-241, etl.ts:42）；非文本 content 静默丢弃 + 流式路径 console.log 全量 prompt（server.ts:176-184,237）

### 已验证干净的区域（不再查）

gateway：预算预留原子性、trace CAS 状态机、model_runs 归属（sequence/purpose/reason 正确）、DLP、租约生命周期。agent-server：injection:false 真跳过且记录一致（disabled 标记）、session 命名无碰撞、参数转发流式/非流式一致、finish_reason 端到端保真、进化未接入 server、生产 docker 与 eval 库隔离、验证管线单事务提升。eval：campaign_plan 分层划分确定性无泄漏（测试最完善）、ALFWorld 排序跨进程确定（池一致前提下）。

### 历史数据影响提示

C3 证实 `alfworld-20260730` 控制臂 17 局为重放（A/B 错位 12.7%）；E5 热库轮（11/134 vs 10/134）若引用过该轮数据需注明口径。建议在下轮报告前统一复核哪些历史结论依赖该数据集。

---

## 三、修复优先级建议（供用户拍板分批）

- **P0（下轮跑批前必修，否则结果仍不可信）**：C1-C4 全部；M1-M3 可观测性三件套；M5 双 system；M8 控制臂旁路；M10 经验库快照；M11 preflight 指纹；M14/M15/M16/M18 alfworld 四件；max_tokens 参数化 + pilot 校准（原方案 A 修正版）
- **P1（强烈建议）**：M4、M6、M7、M9、M12、M13、M17、M19、M20、M21
- **P2（技术债另立任务）**：全部 minor；门控 length 规则策略讨论（§6.3 已记）

## 四、执行步骤（本计划批准后）

1. 写 `doc/issues-snapshot/issue-003-gate-length-misescalation.md` + 更新 index.md（状态 open，修复节引用改造方案与本审核修正）
2. 写 `doc/design/2026-08-09-adversarial-review-experiment-validity.md`（本报告全文，含 clean 区域与历史数据影响）
3. 更新 `doc/design/INDEX.md`（登记审查文档）+ `doc/design/progress/2026-07-24-eval-benchmark.md` 交接节（追加 08-09 审核发现摘要）
4. 本计划复制到 `doc/design/plans/2026-08-09-gate-length-issue-and-adversarial-review-plan.md` 并登记 INDEX.md
5. 按 AGENTS.md 惯例补 `doc/design/2026-08-09-*-changes-and-decisions.md` 决策记录
6.（视用户选择的方案）实施 P0 修复批次：每项 red-first 测试 + 修复 + 转绿，gateway pytest / agent-server vitest / eval pytest 全绿，npm run check 干净

不做：不改 quality.py 门控规则（策略问题另立任务）；不实施 P1/P2；不动历史结果数据。
