# M4（T4+T5）开发决策记录：F3 情景标签与检索过滤 + F4 晋升机制统一

日期：2026-08-14
状态：**已实施，测试全绿（TS 325 + Python 75 + eval 71）**
依据：`plans/2026-08-14-post-c-unified-fix-batch-plan.md` v5（§4 F3、§4.5 F4）；`plans/2026-08-14-fix-batch-dev-tasks.md`（T4/T5 行）；`doc/design/reviews/2026-08-14-fix-batch-adversarial/m3-test-review.md`（口径确认项顺延）；issue-012（采纳项 5 落地）；`doc/design/2026-08-13-agent-server-high-level-design-v2.md`（红线 3 / §3.3）

## T4：F3 情景标签与检索过滤

### 1. TDD 过程记录（先红后绿）

- **TS**（`test/domain-tagging.test.ts`，11 例）：首跑 10 红 1 绿（绿例为无过滤基线）——检索域过滤（跨域排除/无标签放行/空 domain 参数不过滤）、ETL 打标（session task_id → payload.domain，含臂前缀形态）、collectTrajectories domain 透传（元数据优先/注册表回退）、cardsToStaged domain/task_pattern 映射、在线通道集成（/v1 带 domain → session 头元数据 + 注入集不含跨域卡）。实现中 1 处漏 import（domainForTask 未引入）由红例抓出。
- **Python**（`python/tests/test_issue012_domain_tags.py`，6 例）：首跑收集期 ImportError 全红（domains 模块不存在）——CARD_SCHEMA 可选标签字段、ExperienceCard 往返、EXTRACTION_PROMPT task_pattern 哨兵、蒸馏自动打标（traj.domain → card.domain）、wire 注册表回退、注册表规则。

### 2. 设计决策

**T4-1 domain 注册表双副本（TS/Python 镜像）**：`src/offline/task-domain.ts` 与 `python/verification_selection/domains.py` 同规则——`alfworld`（task_id 含 alfworld）→ "alfworld"；`task_\d+`（QCB office 语料，含 control-/experiment- 臂前缀形态——C 库 evidence.task_id 实测）→ "office"；其余 → ""。两侧测试锁定同一期望表（含臂前缀用例）。理由：TS 侧服务 ETL 打标与 collectTrajectories（离线），Python 侧服务 restill 重蒸回退；规则极简（2 条），镜像成本低于跨语言共享。

> **修正声明（2026-08-14，m4-test-review 缺陷-1 打回修复）**：初版实现规则漂移——TS 用 `\btask_\d+`（词边界）、Python 用 `task_\d+`（子串搜索），"mytask_00001"/"footask_7_bar"/"x_task_5_y" 在 TS 判无域、Python 误判 office，违反本节"同规则镜像"声明。已修复：`domains.py` 正则改 `\btask_\d+` 与 TS 完全一致（一行）；pi-test 补测 `test_issue012_domain_registry_parity.py`（11 组输入同一期望表）3 红转绿并永久保留，作为双副本一致性回归；grep 核查无第三副本（restill.py/pipeline.py 均 import 注册表模块，无内联规则）。修复后全量：TS 332 / Python 89 / eval 71 全绿。

**T4-2 写入双路径**：
- 蒸馏路径：合成器（synthesize_campaign_sessions.py → domain:"office"；synthesize_alfworld_sessions.py → "alfworld"）写 session 头元数据 → collectTrajectories 透传（SessionTrajectory.domain：metadata.domain 优先、注册表回退）→ trajectories.json wire（全量序列化，sop_lifecycle 消费 toolCalls 不受影响）→ TeacherTrajectory.domain → `_extract_card` 管线写入 card.domain（**不信任 LLM 自报 domain**）；task_pattern 由 EXTRACTION_PROMPT 要求 LLM 提取（可选字段，空串容忍）。
- ETL 路径：etlSessionFiles 读 session 头 metadata.task_id（复用 M1 透传键）→ 注册表 → payload.domain；无任务归属的 session（生产 pi 客户端）→ ""（无标签）。
- CARD_SCHEMA：domain/task_pattern 为**可选字符串**（无 minLength）——存量卡与未知来源不强制，与"无标签不过滤"语义一致。

**T4-3 检索过滤落点 = retrieval.ts（bm25 候选池后、余弦重排前）**：store.search 保持 bm25 纯候选（延续 T3 决策）；`retrieve(store, query, limit, domain?)`：domain 给定时，payload.domain 非空且 ≠ 请求 domain 的候选被排除（**跨域排除而非降权**——F-18-a 验收"跨域注入为零"要求排除语义）；无标签（空串/缺字段）恒通过（存量 920 卡向后兼容）；domain 参数缺省 = 不过滤。候选池不扩（limit×3 不变）——过滤后池可能变空，接受（同域命中率不退化仅对未打标存量库成立，已声明）。

**T4-4 在线 domain 通道（沿 task_id 先例，非计划字面的 ProxyStreamOptions）**：StreamRequest.domain（顶层，/api/stream 与 /v1 均读 body.domain）→ ProxyHandlerOptions.domain → session 头 metadata.domain + retrieve(..., domain)。理由：M1 的 task_id 已确立 StreamRequest 顶层先例（计划写于 M1 实施前），保持一致优于按字面走 options；request_traces 不加 domain 列（归因 join 键是 task_id，domain 可由任务推导，避免冗余迁移）。

**T4-5 harness 必选 domain**：campaign.py `run_agent` 增**必选** domain kwarg（M1 task_id 纪律先例：缺情景键是静默数据质量损失）→ extra_body；office campaign 传 "office"；alfworld_agent.py extra_body 传 "alfworld"。restill 重蒸顺带打标（session 元数据 domain 优先、注册表回退）——C 库冒烟实测 41 卡全部 domain="office"（存量回填默认域，方案 F3-3）。

### 3. 验收与边界

- 验收口径（F-18-a）：带标签跨域卡注入为零——检索层测试 + 服务器集成测试（注入集不含跨域卡）实证；**存量未回填卡（无标签）的跨域可见窗口期**：重蒸排期前存量卡无标签、跨域可见——显式声明并接受（方案 F3 原文）。
- 同域命中率不退化：存量 C 库无标签 → 过滤不生效 → 检索行为逐位不变（过滤仅在带 domain 参数时激活）。
- 遗留：wenshu 等未来域需扩展注册表（2 条规则 + 测试即改即绿）。

## T5：F4 晋升机制统一

### 1. TDD 过程记录（先红后绿）

- **TS**（`test/promotion-gate.test.ts`，6 例）：首跑 3 红 3 绿——SOP 预验证标记常量、SKILL 暂缓拦截（verifyAndCanonicalize 零晋升 + 库内零条）、EVIDENCE 0.5 闸、Method/Guard 过闸（F1 deliverables + F2 confidence 默认）、五类混合批次（SKILL 拦 / SOP+EVIDENCE+Method+Guard 各 1）。
- 旧契约测试更新 4 处（SKILL 晋升断言 → 暂缓断言；scheduler metric 3→2；混合批次计数）——SKILL 晋升是旧契约，新语义下改断言即改契约。

### 2. 设计决策

**T5-1 SKILL 定案：暂缓入库**（否决 utility→可验证任务映射——当前 benchmark 恒为空、无验证对象，映射无对象可挂；建了也是纸面映射）。落地：`verifyAndCanonicalize` 过滤 SKILL 类型（晋升闸统一层，非 mapper 层——保护所有晋升路径）；skill_evolution 阶段与 skill-catalog 渲染保留（通道本身不拆，验证通道建立后解除暂缓）。附带效果：SKILL 不再出现在目录渲染（catalog 空壳）。

**T5-2 SOP quality=1 语义 = "预验证通过标记"**：`SOP_PREVETTED_QUALITY = 1` 导出常量 + 文档化——SOP 经生命周期管线（构造→合并→重执行）预验证，quality=1 是预验证通过的标记而非绕过闸门的直通值；行为不变。SOP 是统一验证闸框架下"以生命周期管线预验证为判据"的类，与 EVIDENCE/ABILITY 的自评闸同属"有验证判据才准入"。

**T5-3 统一框架表述**（红线 3 修订 + §3.3 局限声明更新，v2 设计文档）：晋升统一过验证闸——EVIDENCE/ABILITY 0.5 闸（ABILITY 另含 F1 交付物检查 + F2 实战归因信号）、SOP 预验证标记、SKILL 暂缓（验证通道建立前无准入）。台账 5 闭环。

### 3. 边界

- SKILL 暂缓是**闸门级**决定：手写 verifyAndCanonicalize 直调 SKILL 也被拦（测试实证）；未来 utility→可验证任务映射落地时解除（需反向测试更新）。
- 五类卡序列测试锁定过闸/拦截/豁免三路径，作为红线 3 修订的回归哨兵。
- **M3 review 确认项顺延**：样本单位"任务日 vs ≥3 个不同任务"（m3-test-review §2a）待用户裁决，T4/T5 不触及归因规则；若裁决为 distinct-task 口径，改 attribution 规则并同步回放验收，与本批次无耦合。

## 测试与检查结果

- TS：`packages/agent-server` 全包 **325 通过**（33 文件；新增 domain-tagging 11 例 + promotion-gate 6 例；旧契约更新 4 处）；Node 25 经 `scripts/with-node25.sh`。
- Python：`python/tests/` **75 通过**（新增 test_issue012_domain_tags 6 例）；eval `tests/` **71 通过**（campaign run_agent domain 必选参数 4 处调用点更新 + extra_body 断言）。
- 冒烟：restill 真实 C 库导出（83 ABILITY 卡）结果与 T2/T3 逐项一致（41 restilled / 6 无交付 / 36 低分 / 0 缺源），**41 卡全部 domain="office"**（存量回填默认域生效）。
- `npx tsgo --noEmit` 0 错误；biome 0 问题（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/browser-smoke 全过。
- 唯一 check 失败项：`check:pinned-deps`（pre-existing，eval/results 工件，M1-M3 同口径）。

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§4 F3、§4.5 F4）；plans/2026-08-14-fix-batch-dev-tasks.md（T4/T5）；doc/design/2026-08-13-agent-server-high-level-design-v2.md（红线 3 / §3.3）；doc/issues-snapshot/issue-012-ewc-memory-design-review.md（采纳项 5）；doc/design/2026-08-14-m3-t3-changes-and-decisions.md（T3 先例）
