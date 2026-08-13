# 2026-08-11 会话记录：SIA 论文对比与自我改进设计

本文档保存 2026-08-11 会话的完整讨论脉络，供回头翻看。按主题分节。

---

## 1. SIA 论文 vs 本工程（pi）对比

SIA 核心：Feedback-Agent 双杠杆闭环——同时迭代支架（prompt/工具/重试逻辑）与权重（LoRA RL），三任务实证权重更新带来支架无法企及的增益（LawBench +20.1pp 等）。名言："支架决定智能体如何搜索，权重决定模型知道什么"。

pi 现状定位：固定权重 + 可自改支架的 coding agent。
- 支架自改面完整：agent 可写 `.pi/extensions|skills|prompts`，`/reload` 或 `ctx.reload()` 热生效；extension API 可运行时 registerTool/setModel 等。
- 无元智能体闭环：orchestrator 只是进程监督/RPC 路由。
- 无权重更新：全仓无微调代码，omlx 不可动。
- 自我改进能力外挂在 agent-server/agent-gateway：在线检索注入（retrieval.ts/injection.ts）+ 离线提炼管线（offline/pipeline.ts，teacher=DeepSeek）+ 质量门控（verifier.ts，PROMOTION_THRESHOLD 0.5）+ judge 评估（eval/campaign.py）。

优劣结论：pi 胜在安全可审计、零训练成本、人在环治理；天花板是无法内化领域知识。SIA 胜在双杠杆增益与全自动闭环；代价是训练基础设施、只能优化可验证任务、耦合古德哈特风险（§8）。

## 2. self-improve 回路设计（两层）

**Skill（策略层）= 规矩与习惯**（何时反思/改什么/怎么验证/禁区）；**Extension（机制层）= reflect 工具 + 验证闸 + reload + evolution-log + 安全预算**。

与经验库的分工（小孩版）：经验库是错题本（老师整理的知识，做事前被提醒）；skill 是铅笔盒里的纸条（行为习惯："做完作业要检查"）。skill 反思的产出最终进经验库。

关键设计：
- 触发信号：用户纠正同类 ≥2 次 / 工具同类失败 ≥3 次 / 新任务流程值得固化。
- 改进优先级：skill > prompt 片段 > extension；小步单点。
- 禁区：验证器、回归测试、AGENTS.md 不可改；不为过验证降低标准；防古德哈特硬约束。
- 快环自反思 + 慢环 teacher 分层；同一问题自改 ≥2 次仍复发则升级 teacher。
- evolution-log 是快慢环接口；schema 方案的 scaffoldHash 支撑"支架变更后旧经验降级重审"。

## 3. 教师模型选择讨论

反思要求四种元认知能力：错误定位、因果归因、反事实推理、克制。教师推理能力决定反思产出上限。

- 推理模型明显占优：多跳因果链失败、隐性失败（无报错信号的错答案）、judge/verifier 打分。
- 差异不大：显性浅层失败（格式/参数错）、大批量模式归纳（边际收益递减，非推理模型成本低一个数量级）。
- 推理模型风险：贵、慢（不适合在线环）、过度推理（把偶然失败合理化成不存在的模式——比不反思更危险，错经验会入库被注入）。
- 原则：**教师的短板是学生的天花板，教师的过度自信是学生的污染源**。
- 分层建议：快环=任务模型自身；升级反思=推理模型；离线批量提炼=强非推理先试；judge=推理模型或经校准强模型。
- 可实测：eval/campaign.py 支持配置 judge，可做三腿对照（自反思 / 强非推理 / 推理模型）比较晋升率、注入命中率、任务成功率。

## 4. 符号表对入库数据的启发

SIA 符号表（§3.4）一半概念有迁移价值。勘察发现 agent-server 现状：`Experience` 缺三层信息——支架指纹（A_g）、谱系（g）、评分可审计性（V/E_g）；且 DB 有 `branch_path`/`times_selected` 两个类型未声明的历史死列。

产出两份待评审方案（已登记 doc/design/INDEX.md，未动代码、未提交）：

1. `doc/design/plans/2026-08-11-experience-schema-evolution-plan.md`——Experience 加三字段：`scaffoldHash`（支架指纹，最重要：支架变更后批量降级旧经验交 verifier rescore）、`supersedesId`（演化谱系）、`verification`（quality 可审计来源）；PRAGMA+ALTER TABLE 增量迁移；分 T1/T2/T3 交付，T1 对实验零影响。
2. `doc/design/plans/2026-08-11-self-improve-skill-plan.md`——S1 仅 SKILL.md（可即行）→ S2 extension 机制层（与 schema T2 后）；对齐 roadmap R3 人工审批门。

排期：用户评审后，根据实验完成情况安排实施时间。

## 5. 反思流程总结（设计口径）

- 快环（session 内）：触发（SKILL.md 信号）→ reflect 工具取轨迹诊断+支架快照 → 自指反思 → 最小改动 → 验证闸（jiti 加载+最小测试）→ reload 生效 → evolution-log 留痕。
- 慢环（离线）：session JSONL + evolution-log → ETL → teacher 提炼卡片 → 质量门控晋升 → 检索注入回流。
- 一句话：快环是"当事人写检讨"，慢环是"老师批改作业并更新错题本"，evolution-log 与 scaffoldHash 是纽带。

