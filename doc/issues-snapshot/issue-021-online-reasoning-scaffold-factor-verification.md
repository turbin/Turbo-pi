# issue-021: 在线推理脚手架因子验证（ST MCP / plan-to-file × Memory 2×2，D 收口后执行）

- 状态：**deferred（2026-08-24 用户裁决：登记待办，D 阶段收口后执行；非故障项，属实验设计评估）**
- 报告：2026-08-24（用户提出 ST MCP / plan to file 是否可改善 9B 在线推理）
- 影响面：campaign harness（提示词/工具表面）、D 收口后的因子实验设计、ALFWorld 阶段 harness 选型

## 背景与问题

D 阶段数据一致显示 9B 的瓶颈在**在线推理**而非生成质量：规划绕圈、状态跟踪丢失、收束失败（触顶率 50-70%、失败模式以 planning/state-tracking/stopping 为主，preview §16）。用户提出两个候选脚手架：

1. **ST（Sequential Thinking）MCP**：外挂结构化思考工具（拆步骤/修正/分支）——在线提示工程；
2. **plan-to-file**：任务内计划落盘（先写 plan.md、逐步更新、随时回读）——任务内外置工作记忆，与经验卡（跨任务外置记忆）同族互补。

主会话评估：两者对症（规划/状态/收束正是病灶），plan-to-file 零基建（harness 只跑 bash，纯提示词改动）成本最低；但任何 harness/提示词中途变更都会作废 D 阶段时间序列，**必须 D 收口后验证**。共同风险（须入设计）：①脚手架本身消耗 30 步回合预算（可能治绕圈却加剧触顶）；②计划/思考维护挤占交付本能（issue-010 教训：C 阶段卡片指导致交付分数连续下滑，防范=提示绑定"每步必更新交付物"+评估盯 FunctionalSuccess）。

## 验证设计（D 收口后执行）

**主设计 2×2**：Memory（有/无）× 脚手架（有/无）——一次回答三个问题：跨任务经验值多少、在线脚手架值多少、能否叠加。

| 臂 | 说明 |
|---|---|
| M0S0 | 无记忆 + 无脚手架（= 现役对照臂口径） |
| M1S0 | 有记忆（现役实验臂口径） |
| M0S1 | 无记忆 + 脚手架 |
| M1S1 | 有记忆 + 脚手架 |

**脚手架实现优先级**：plan-to-file 先行（零基建，提示词变体："先写 plan.md，每完成一步更新计划与交付物"）；ST MCP 作为第二实现另立批次（需 harness 加 MCP 工具通道，成本另估）。

**评估口径（预注册，执行前冻结）**：
1. 主指标：score（judge+functional 双口径）、**EfficientSuccessRate**（成功∧¬触顶——§十九"突破 30 轮"组合判定的核心）、cap_failure_rate；
2. 机制指标：StateRevisitRate、RepeatToolRate、ProductiveRoundRatio（脚手架若有效应三者下降）；
3. 副作用指标：计划/思考相关回合占比（防"维护计划挤占交付"）、交付物硬指标 FunctionalSuccess 不得下降（issue-010 红线）；
4. 任务集：重复集 + held-out 子集（评估脚手架对未见任务的泛化——脚手架理论上无跨任务效应，若 M0S1 在 held-out 也涨，说明它补的是通用推理而非经验）。

**裁决规则（预注册）**：S 主效应 >0.05 且 FunctionalSuccess 不降 → ALFWorld 阶段 harness 纳入脚手架；M×S 交互 >0 → 叠加设计（脚手架+记忆并用）入生产；均不显著 → 维持纯 Memory 路线。

## 前置依赖

- D 阶段收口（时间序列定型）；
- issue-020（三教师对照）同窗口合并排期可省 preflight。

## 回归测试

执行时补：脚手架提示词变体不改变 judge/判据口径（对照臂可复算）；plan file 产物不污染 workspace 评分（QCB grader 对多余文件的容忍度冒烟）。

Refer Spec：doc/design/preview.html（§16 pilot 行为分析、§19 组合判定）；doc/issues-snapshot/issue-010（交付挤占教训）；doc/issues-snapshot/issue-020（同窗口教师对照）
