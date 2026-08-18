# C 后统一修改方案（统一修复批次规划，待用户审核）

日期：2026-08-14（v2：经对抗式审查 round 1-2 修订，审查档案 `doc/design/reviews/2026-08-14-fix-batch-adversarial/`）
状态：**待审核（本方案只规划不改代码；用户逐批次批准后另行实施）**
依据：用户 2026-08-12 长效指令（C 完成后统一回顾所有未完成 issue 并一次修复）；C 收口报告（2026-08-14-agent-server-c-campaign-final-report.md）；概要设计 v2 §5/§7；五份 08-13 待启动方案。

## 修订记录

- v1（08-14 早）：初稿。
- v2（08-14）：对抗式审查 17 项发现（1C/10M/6m）+ 新增 F-18 全部接受并落实：新增前置批次 F0（归因数据通道）；F1 模块落点三处修正；F2 归因对象/样本单位/校准口径/迁移方案/保守降级重写；F3 补 ETL 打标与验收口径修订；§6 裁决口径与 §7 流转措辞修正；工期口径拆分人工工时/日历时间。round 3 对账 11/11 通过，共识达成（审查档案 round-1/round-1-response/round-2/round-3）；round-3 两项 minor（F-19 /api/stream 路径处置、F-20 INDEX 刷新）已吸收进 v2 定稿。
- v3（08-14）：用户五项裁决落盘（§6 全部关闭转决议）：①B' 27B 重跑取消，实验主线切 9B 全量重跑 + 新增实验顺序决策点（office 案例集先行→报告→用户确认→ALFWorld）；②断点持久化翻转为立项（最小断点，见 §5 批注）；③SOP/SKILL 不做双轨、机制完善后统一晋升闸（新增批次 F4，§4.5）；④演进方案 6 补 plan 立项（plans/2026-08-14-plan-library-version-cross-eval.md）；⑤DLP 默认敏感列表建立（身份证号+密钥类，可扩充）。决策记录：doc/design/2026-08-14-fix-batch-user-rulings-changes-and-decisions.md。
- v4（08-14）：§8 诚实边界扩充为"限制→解决方案"对照表（用户要求逐条给方案）；issue-013（requestId 碰撞）/issue-014（bm25 字面检索，deferred）登记 doc/issues-snapshot/。
- v5（08-14）：§10 用户问答与解释纪要落盘（+10.3pp 解读/小模型测量/休眠整理记忆/限制解决方案四组问答）；随后进入开发实施阶段（任务拆分见 plans/2026-08-14-fix-batch-dev-tasks.md）。

## §0 工程实态核实表（2026-08-14 代码级检索，审查员独立复核通过）

| # | 项 | 实态 | 证据 |
|---|---|---|---|
| 1 | 卡片 `deliverables` / `domain`·`task_pattern` / `confidence` 字段 | 未建 | `packages/agent-server/src/types.ts:28-39`；全 src grep 零命中 |
| 2 | 离线管线阶段断点 / `--resume` | 未建 | `src/offline/checkpoint.ts:4-14` 整轮粒度（同 id 重写 no-op，本身幂等）；`run-evolution.ts:145` 起 CLI 仅 --status/--loop；ETL 按 (file,entry,sentence) 幂等（`etl.ts:29,47`） |
| 3 | verifier 交付物检查 | 未建 | `src/offline/verifier.ts:30,60` 唯一闸门 quality≥0.5 |
| 4 | active 卡降级/淘汰通道 | 未建 | `src/offline/scheduler.ts:106` rescore 只取 dormant；`verifier.ts:70-75` 同 hash 命中 active 直接 continue |
| 5 | x-gateway marker 含 trace_id | 未建 | `agent-gateway/src/agent_gateway/api/chat.py:83-109`；trace_id 仅作响应体 id（`:135`） |
| 6 | DLP 扫 tools[] / 模式数 | 部分建 | `security/dlp.py:14-18` 默认 3 条；`scan_envelope` 只扫 messages+assistant tool_calls（`:43-55`） |
| 7 | ETL session 完整性校验 | 未建 | `src/offline/etl.ts:88` malformed 行仅跳过；error/aborted 流仍摄入（`:16-23`） |
| 8 | 蒸馏 prompt 提取交付物 | 未建 | `python/verification_selection/pipeline.py:24` EXTRACTION_PROMPT 无交付物维度；全 python/ grep 零命中 |
| 9 | request_traces.retrievedIds | **代码写路径已建，历史数据前提不成立** | 写路径：`src/experience-store.ts:96,405,429`、`server.ts:253`、`proxy-handler.ts:74`。但 C 终态库实测 860 行、ts 仅 08-09(491)/08-10(369)、hit=1 仅 4 行——requestId 为 Fastify 每进程计数器（`server.ts:165`），两阶段 upsert 的 ON CONFLICT 只更新 completion 字段（`experience-store.ts:386-397`），跨日/跨实例请求被静默合并，D2-D7 检索记录全失（审查 F-1，数据实证双方独立复核一致） |
| 10 | `eval/gate_length_escalation.py` 门控 | 已建 | 默认阈值 5%（`:23` DEFAULT_MAX_RATE=0.05） |

## §1 修复批次 F0（前置）：归因数据通道修复（issue-013，审查 F-1/F-2/F-3 升格）

**问题**：requestId 碰撞致 request_traces 跨日静默合并（C 库 D2-D7 检索记录全失）；落库的是检索集而非实际注入集；任务分数与请求无 join 键（run.jsonl 的 trace_ids 是自造 chatcmpl id，无处落库）。凡依赖 request_traces 的分析均受污染。

- 改动点：
  1. requestId 改 randomUUID（`src/server.ts:165`），消除跨日/跨实例碰撞
  2. **落实际注入集**：`buildInjection()` 返回注入 id 清单（Method/Guard 截取后、EVIDENCE 实际入 prompt 者），proxy-handler/server 写入 request_traces 新列 `injected_ids`；SKILL/SOP 为独立检索通道，显式排除在本归因口径外（或另列 injected_skill_ids/injected_sop_ids，实施时定）
  3. **task_id 透传**：harness（campaign.py）随请求带 task_id → session 头 metadata → request_traces 新列，补上 任务分数↔请求↔注入集 的 join 链
  4. **既有数据处置声明**：F0 修复前的 request_traces 及其派生看板（hit-rate `/api/stats/hit-rate`、stats 页）数据标记不可信/归档，防止后续分析误用
  5. issue-013 登记：`doc/issues-snapshot/issue-013-request-id-collision-trace-merge.md` + index 更新；回归测试 `packages/agent-server/test/regressions/issue-013-*.test.ts`（requestId 唯一性/碰撞合并哨兵，先红后绿）
  6. **`/api/stream` 路径处置**（审查 F-19）：该路径（`src/server.ts:150-161`）当前不传 requestId、不写 request_traces（`proxy-handler.ts:66-79` 守卫）——F0 实施时二选一：纳入 trace 落库（与 /v1 同口径）或显式声明该路径不在归因口径内，写入决策记录
- 边界声明（防过度回溯）：C 判据结论不受此缺陷污染——升级率口径为 gateway model_runs 全量 + x-gateway 标记（红线 6），+10.3pp 归因用 run.jsonl 臂×日分数，D3 注入审查用 session tar；受污染面仅限 request_traces 表本身及其派生看板。
- 预估：人工工时 1 天

## §2 修复批次 F1：卡片交付物维度（issue-010 主体，对应 plan-card-deliverable-fix）

- 改动点（v2 修正落点，审查 F-4/F-5）：
  1. schema：payload 增加 `deliverables`（交付物清单），三处——`python/verification_selection/pipeline.py` EXTRACTION_PROMPT（要求显式提取"任务最终必须产出什么"）、`python/verification_selection/experience.py` CARD_SCHEMA（required 增加 deliverables）、`src/offline/verifier.ts` cardsToStaged payload 映射。注意：Method 卡提取在 verification_selection，不在 skill_evolution
  2. 交付检查：**适用范围仅 Method（ABILITY）卡**；落点两处——Python verification_selection 打分侧（持有 TeacherTrajectory，无交付轨迹 quality 封顶 <0.5）+ TS 闸门二次校验（verifier.ts 对带 deliverables 的卡校验字段非空）；**SOP/SKILL/EVIDENCE 显式豁免**（SOP quality=1 / SKILL utility 预验证通道不动，EVIDENCE 无交付物概念），写入决策记录
  3. 存量卡处理定案：**重蒸**（否决 LLM 批量补字段——回填无验证通道，质量不可控）。语料量与耗时估算：现役 C 库 920 条 active 卡，对应 7 日 campaign 语料，按 C 实测 35-45min/夜处理单日轨迹推算全量重蒸约 4-6h 管线运行，分批夜间执行；域标签（F3）顺带在重蒸时打上
  4. 回归测试：TS 侧 `packages/agent-server/test/regressions/issue-010-*.test.ts`（合成"分析完整但无交付"轨迹断言闸门拦截）+ **Python 侧** `python/tests/`（CARD_SCHEMA 校验 + 打分封顶哨兵，参照 test_issue002_pipeline_resilience.py 落点惯例）；先红后绿
- 吸收台账项 10（0.5 阈值鉴别轴与任务成败正交）：交付检查把闸门与任务结果挂上第一个钩
- 验收：修复后短程验证 campaign（重复集 3 天）分数曲线不低于无注入基线；全部测试绿 + `npm run check` 干净
- 预估：人工工时 1-1.5 天；日历时间 ≥3 天（验收 campaign + 夜间进化）

## §3 修复批次 F2：实战归因奖惩 + 置信度（对应 plan-outcome-attribution-reward，吸收台账 1）

- 归因对象与口径（v2 重写，审查 F-2/F-6/F-7/F-14/F-15）：
  1. 归因管道：request_traces.**injected_ids**（F0 提供）× 任务分数（F0 task_id join）→「卡×结果」关联表，纯离线计算；多卡共注入首版**仅记数不动作**（credit assignment 加权策略列为后续演进）
  2. 奖惩规则：注入且高分→加分（封顶）；注入且连续失败→**降权**。**样本单位 = 独立任务数**（同任务多请求共享同一 judge 分数，非独立样本），阈值 **≥3 个不同任务**（预注册取值，写入决策记录；历史分布依据随实施补）
  3. **降权落地形态**：confidence 降低 → 检索排序降权（改动点 `src/retrieval.ts` retrieve()/store.search 排序加权）；quality 字段不动。**首版仅降权，不自动降级**——active→dormant 通道机制建立但触发需人工确认（或更高证据门槛），全自动降级待样本量充分后启用。台账 1 首版达成度：交付"降权+人工确认降级"通道，非全自动闭环
  4. **复升排除**（审查 F-14）：被实战降权的卡带标记，跳过 runDormantRescore 自评复评 N 批（N 预注册），或需实战证据才可复升——阻断"自评复升→再注入→再失败"循环
  5. 元数据迁移：Experience 加 `confidence` 列——ALTER TABLE ADD COLUMN + **user_version 版本化** + 快照再生流程 + 旧库读取兼容（COALESCE 默认值）（审查 F-8）
  6. **对照校准口径**（审查 F-6）：对照臂仅 D1/D7 运行，校准仅在这两日可执行，其余结算日跳过校准（不做跨日近似）；统计功效预算声明：重复集 n=20 下功效有限，归因结论按红线 6 以全量落库为准、不外推；"对照臂每日同跑"纳入后续 campaign 设计并计入成本
  7. 历史回放验收修订：C 库 request_traces 因 F-1 不可用，回放改以 session JSONL 的 experience_injection 条目近似（显式声明 requestId 跨日碰撞、task 归属靠 workspace 路径解析的误差），或推迟至 F0 修复后的新 campaign 数据
  8. 回归测试：合成「卡 A 注入后 ≥3 个不同任务连续失败→降权」「卡 B 连续成功→加分」「<阈值不动」「降权卡跳过复评」序列
- 明确不做：token 级 RL；单请求即时奖惩（按日批次离线结算）；SKILL/SOP 归因（独立通道，后续演进）
- 验收：全部测试绿；回放（近似口径）能后验标出 issue-010 中致降分的卡
- 预估：人工工时 1.5-2 天；依赖 F0（数据通道）、F1（分数信号可信度）

## §4 修复批次 F3：情景标签与检索过滤（对应 plan-scenario-tags，backlog 中优先）

- 改动点（v2 补 ETL 路径与在线通道，审查 F-9/F-18）：
  1. schema：payload 加 `domain`（alfworld/office/wenshu/...）与 `task_pattern`
  2. 写入双路径：a) 蒸馏管线按轨迹来源自动打标（合成器 task_type/arm 元数据透传）；b) **ETL 打标路径**（审查 F-18-b：EVIDENCE 直插不经蒸馏，须在 ETL 摄入时按 session 所属任务打域，复用 F0 的 task_id 透传 + 任务→域注册表）
  3. 存量卡回填：随 F1 重蒸顺带打标（默认域 office），不做单独回填
  4. 检索：`bm25 召回后按 domain 过滤，**卡无 domain 不过滤**（向后兼容）`；同域优先、跨域排除（策略 A/B 实测）；改动点 `src/retrieval.ts` / store.search
  5. 在线 domain 通道完整改动点清单：harness（campaign.py 随请求传 domain）→ `src/server.ts:220-227` /v1 解析 → `src/types.ts:10-26` ProxyStreamOptions → session 头 metadata（`server.ts:208`）→ proxy-handler → retrieval；collectTrajectories 离线侧同步
- 验收口径修订（审查 F-18-a）：**带 domain 标签卡（含 ETL 打标 EVIDENCE）的跨域注入为零** + 显式声明存量未回填卡在重蒸完成前的跨域可见窗口期及风险接受；C 重复集分数不因过滤退化
- 回归测试：带标签跨域卡不被注入异域任务；无标签卡仍可见；同域命中率不退化
- 预估：人工工时 1.5-2 天（原 0.5-1 天不覆盖 ETL 路径+通道+回填，审查后上修）；混合库 A/B 实测日历时间另计

## §4.5 修复批次 F4：晋升机制统一（用户 08-14 裁决 3，台账 5 + 红线 3 修订）

**裁决**：不做双轨，将机制完善并统一——不是把 SOP/SKILL 降格塞进现役 0.5 自评闸，而是把晋升机制升级为"可证伪的验证闸"后全卡类统一：

- 设计原则：每类卡晋升必须过"与任务结果挂钩的可执行验证判据"，阈值/尺度可按类标定，但不存在绕过验证的通道
  - Method/Guard（ABILITY）：F1 交付物检查 + F2 实战归因信号（既有批次提供）
  - EVIDENCE：维持 0.5 闸 + 随 F2 获得实战降权通道
  - SOP：保留生命周期管线预验证（实质强于自评闸），纳入统一框架文档化，quality=1 直通语义改为"预验证通过标记"
  - SKILL：现状 benchmark 恒为空、无验证对象——建立 utility 分到可验证任务的映射，或暂缓 SKILL 入库直至有验证通道（实施时定案，写入决策记录）
- 配套：红线 3 修订为"晋升统一过验证闸"；v2 §3.3 局限声明（是否收编待裁决）闭环
- 回归测试：五类卡各一序列（过闸/拦截/豁免路径断言）
- 预估：人工工时 1-1.5 天；依赖 F1/F2（验证判据来源）

## §5 台账 quick wins（搭车 F1-F3 或独立小批次）

| 台账项 | 改动 | 落点 | 预估 |
|---|---|---|---|
| 2 双印证无对账键 | GatewayMarker 增加 trace_id 字段，agent-server marker 条目同步落库 | gateway `api/chat.py:83-109` + agent-server marker 消费侧 | 0.5 天 |
| 7 ETL 半截 session 摄入 | ETL 摄入前 session 完整性校验（结束标记/token 账目闭合），不完整 session 隔离不摄入 | `src/offline/etl.ts:88` 附近 | 0.5 天 |
| 3 DLP tools[] 盲区 + 敏感列表 | scan_envelope 扩展扫 tools[] schema；**默认敏感模式列表（用户 08-14 裁决 5）**：身份证号 + 密钥类（AWS key/PEM 私钥/api_key 赋值）为内置默认，配置化可扩充——用户在 config 中追加模式即生效，无需改码 | gateway `security/dlp.py:14-18,43-55` + config | 0.5-1 天 |
| 4 快照无留存/回滚 | 每日快照保留 N 份 + "回滚到昨日 active 集"runbook 步骤 | eval/snapshot_store.py + doc | 0.5 天 |

**管线断点（原裁决 2，v3 翻转为立项）**：最小断点——打分结果（最贵阶段，issue-002 r3 的 1608 次打分/13-27h 估算来源）落盘 + `--resume` 跳过已完成打分；ETL/提取阶段产物落盘视 office 先行阶段故障率再定。排在 F0 之后、9B 全量起跑前完成。翻转理由：9B 重跑使批次数数倍增长（暴露次数线性上升）、9B 轨迹分布未经验证（issue-002 类边缘故障复现概率不为零）、0.5-1 天保费相对 4 天跑批盘子合理。预估 0.5-1 天。

## §6 用户裁决记录（2026-08-14，全部关闭转决议）

1. ~~issue-003 B' 重跑 A/B/C~~ → **裁决：不重跑 27B；实验主线切换为 9B 模型全量重跑批**。**新增实验顺序决策点**：后续实验先跑 QwenClawBench 一类 office 案例集 → 向用户报告测试结论 → 用户确认后才进入 ALFWorld 测试。配套含义：B' 27B 基线永久放弃（issue-003 以"27B 纯基线不再测量，主线转 9B"关闭）；9B 起跑前置——omlx 9B 可用性确认、测速、pilot 校准 max_tokens（9B 叙述风格与 27B 不同，finish_reason 分布需重测，length 升级率 <5% 门控不变）；9B 低基线预期使 headroom 增大，是测量"绝对提升"的更好设计（v2 §1 混淆因子随 9B 基线重测重新定性）
2. ~~管线断点持久化立项/降级/关闭~~ → **裁决（经问答修订）：立项最小断点**（打分阶段产物落盘 + --resume，0.5-1 天，F0 之后、9B 起跑前；理由见 §5 批注）；ETL/提取阶段视 office 先行阶段故障率再定
3. ~~SOP/SKILL 收编 0.5 闸~~ → **裁决：不做双轨，机制完善并统一**（新增批次 F4，§4.5）
4. ~~演进方案 6 补 plan~~ → **裁决：立项**，plan 已补写 `doc/design/plans/2026-08-14-plan-library-version-cross-eval.md`，与 9B 重跑批合并排期
5. ~~DLP 模式集扩展口径~~ → **裁决：建立默认敏感列表**——身份证号 + 密钥类（AWS/PEM/api_key）为内置默认，列表配置化、用户可持续扩充（随 §5 quick win 实施）

## §7 issue 状态流转建议（v2 措辞修正，审查 F-11）

**全部保持 fixed，下一发布周期后评估 closed**——发布周期口径：changelog 最新发布版 0.80.10（2026-07-16，另有 main 上 Release v0.81.0 提交 07-21 无 tag），issue-001（08-05）与 004~009（08-09~08-10）修复后均为零个发布周期，不满足"一个发布周期无复发"纪律。issue-008/009 准确表述为"修复后（D1/D2 起）无复发"。issue-002 保持 fixed 待 §6-2 裁决后流转；issue-011（08-13 修复）观察期未满。转 closed 时 issue 文件与回归测试不删除（纪律）。新增 issue-013 随 F0 登记（§1-5）。

## §8 诚实边界与对应解决方案（v4 扩充）

| # | 限制 | 解决方案 | 状态 |
|---|---|---|---|
| 1 | n=20 下 5pp 分辨力有限（单任务 = 5pp；p=0.2 时二项 SE≈8.9pp；0/20 时真实升级率 95% 上界 ≈15%，"≤5%"是验收规则而非统计证明） | a) 配对设计（同任务跨臂同日差分，消除任务难度方差——四臂已内建）；b) 多日趋势拟合（7×20=140 任务日/臂，斜率估计替代端点两点比较）；c) 请求级升级率作次级指标（~300/日，任务为 cluster）；d) 预算允许时重复集扩 n（n≥60 且 0 事件才能统计认证 <5%） | D 阶段方案内建 a/b/c；d 待用户按预算定 |
| 2 | 对照臂仅 D1/D7（两点不定性漂移形态，D2-D6 无校准数据） | 四臂设计 X3/X4 每日运行 = 对照数据每日存在，结构性解决；成本并入 9B 报价 | 交叉臂 plan 已落实 |
| 3 | host bash agent ≠ 容器 harness（系统性偏低、地板效应压缩分数区间、能力缺口/环境缺口误分类、与外部成绩不可比） | a) 只做内部 A/B 比较、不报外部可比成绩（口径声明）；b) 跑批前任务审计标记环境敏感任务，报告分数分含/不含两列；c) 需外部可比结论时再立容器 harness 项 | a/b 入 D 阶段跑批前置；c 延后 |
| 4 | bm25 字面检索对措辞差异不敏感，判据②泛化测量受限 | 登记 issue-014，延后至全部实验完成后由用户确认是否立项语义检索 | **已登记 deferred（用户 08-14 裁决）** |
| 5 | 9B 行为分布未验证前，按 27B 数据外推的工期/判据预期 | pilot 校准（max_tokens、length 门控 <5%）为全量前置；预期值标注待重估 | 入 D 阶段跑批前置 |

## §10 用户问答与解释纪要（v5 补充，2026-08-14 会话）

| # | 用户问题 | 解释要点 | 对方案的影响 |
|---|---|---|---|
| 1 | 为什么没有能力的绝对提升？+10.3pp 如何解读？pp 是什么？ | pp=百分点。+10.3pp 是双重差分：实验臂 D7−D1=−0.035，对照臂=−0.138，差值 +0.103。实验臂未破自身 D1 基线（0.532<0.567），故无绝对提升证据；记忆抵消了约 75% 自发劣化——抗劣化效应，非增益上限突破。边界：n=20、对照臂两点测量、漂移未定性 | D 阶段四臂设计（X3/X4 每日运行）与 Q4 绝对提升判定的来源 |
| 2 | 轨迹学习提升能力？换小模型能否测到？ | C 阶段只见抗劣化。小模型有两股对冲力：headroom 更大（有利）vs 卡片利用能力更弱（不利，issue-010 显示 27B 都有照卡挤占交付）；+10.3pp 依赖对照臂漂移幅度，跨模型不可直接比较 | 直接促成用户 9B pivot 裁决（§6-1）；F1 修复先行降低"卡片利用能力"风险 |
| 3 | agent 休眠时整理记忆，是否同样对抗长程记忆劣化？ | 需区分两种"劣化"：C 观察到的对照臂下滑是**长程行为漂移**（无记忆臂的环境/顺序/judge 漂移），记忆注入是锚点；休眠蒸馏对抗的是**记忆自身的干扰/膨胀/陈旧**（卡片冲突、注意力稀释、照卡挤占交付）。前者已证（+10.3pp），后者机制必要但收益未独立测量。两者均为防守性证据，进攻性（绝对提升）仍无 | F2 归因奖惩与 F4 验证闸统一是为"记忆质量"建立测量与负反馈通道 |
| 4 | 方案四条限制是否有对应解决方案？ | 见 §8 对照表：n=20 分辨力（配对设计/趋势拟合/请求级次级指标/扩 n≥60）、对照臂两点（四臂每日对照结构性解决）、host harness 口径（内部 A/B 纪律+环境敏感任务审计两列分数）、bm25 措辞（issue-014 deferred） | §8 落盘；issue-013/014 登记；扩 n 决策待用户按预算定 |

## §9 文档纪律

- INDEX.md 已登记：五份 08-13 plans + 本方案（2026-08-14 同工作区完成；本方案条目已随 v2 定稿刷新，审查 F-16/F-20 标注）
- issue-013 登记与 index 更新随 F0 实施同 commit；issue-010 修复落地时同步更新 issue 文件状态与 INDEX 台账摘要

## 执行顺序与测试策略

**F0 → 最小断点（§5）→ F1 → F2 → F3，F4 在 F1/F2 完成后**；quick wins 搭车最近批次。每批次：先写回归测试（红）→ 实施 → 绿 → `./test.sh` 全量 + `npm run check` 干净 → 决策记录 `doc/design/<date>-<topic>-changes-and-decisions.md` → 按 COMPLETED/TODO/Refer Spec 格式提交（届时用户确认后执行）。

Refer Spec：doc/design/2026-08-13-agent-server-high-level-design-v2.md（§5 演进方案、§6 红线、§7 台账）；doc/design/2026-08-14-agent-server-c-campaign-final-report.md；doc/design/plans/2026-08-13-plan-{card-deliverable-fix,outcome-attribution-reward,scenario-tags,b-rerun-pure-27b,pipeline-checkpointing}.md；doc/issues-snapshot/issue-002/003/010/012；doc/design/reviews/2026-08-14-fix-batch-adversarial/（round-1/round-1-response/round-2）；doc/design/progress/2026-07-24-eval-benchmark.md（08-12 用户指令）
