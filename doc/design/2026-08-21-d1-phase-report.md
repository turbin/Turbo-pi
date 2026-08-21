# D 阶段 D1 阶段报告（9B 空库起跑日）

日期：2026-08-21 ｜ 状态：**D1 完成（跑批 52 任务 + 干净进化 + frozen 快照）；D2 四臂日待启动**
数据：`eval/results/campaign-20260819/`（D1 批次，跨自然日 08-19 15:00 ~ 08-20 21:06，含暂停/修复窗口）；进化 `ckpt-45681493a02f71ec`；frozen 快照 `var/eval/snapshots/snapshot-20260821-102512.db`
判据与设计：`doc/design/preview.html`；分析包：metrics_v2 / trajectory_metrics（Addendum v1+v2）

## 1. 判据读数（预注册口径）

| 判据 | D1 | 阈值 | 状态 |
|---|---|---|---|
| ① 重复任务升级率 | 0.0% | D7≤5% | 当前达标（协议级口径，issue-019 纪律） |
| ② 新任务升级率 | 0.0% | <20% | 当前达标 |
| ③ RawMemoryGap | exp 0.400 − ctl 0.494 = **−0.094** | D7>0 | **D1 基准差登记**（空库日无记忆信号，DiD 参照） |
| ④ C 式劣化 | — | D7≥D1−0.05 | D1 起点 0.400（重复集实验臂） |
| ⑤ 趋势 | 见 §2-§4 | 软呈现 | — |

## 2. Outcome 层

- 实验臂 32（重复 20 + 新 12）：均分 0.380，通过 11/32；对照臂 20：均分 0.494，通过 9/20
- 新任务集：均分 0.348，3/12 过线
- **Success@K**（全 52）：K5=0% / K10=1.9% / K15=5.8% / K20=9.6% / K30=42.3%——成功高度右移（9B 慢热，前 20 轮几乎无成功），Memory 若有效应看到分布左移
- **Functional vs Judge**：FunctionalScore 均值 0.621 vs JudgeScore 0.485；HardPass 仅 3/52（5.8%）；Judge↔Functional 背离 28 任务——**judge 给分系统性宽于硬检查**，最终报告以 FunctionalSuccess 为硬口径（评审 §五 生效）
- 难度分层：hard 档（D1<0.3）含 task_00021/00022/00029/00034 等 8 个重复任务——D 阶段改进的主战场

## 3. Autonomy 层（issue-019 纪律：联合报告，禁止单独宣告）

- AutonomousSuccessRate 22/52 = 42.3%；MissedEscalationRate 23/23 = 100%；EscalatedSuccess n=0
- **判读**：协议级升级率 0% 但 23 个明显失败全部未升级——门控对 9B 任务级失败失明（issue-019，D1-D7 线上门控不动，shadow-only 诊断允许）

## 4. Trajectory 层

- CapRate 53.8%（28/52），三档拆分：**cap_success 15.4%（8 任务磨满交付）/ cap_failure 38.5%（20 任务无效绕圈）**
- RoundCount P50=30（半数任务打满预算）；RepeatToolRate 0.5%；StateRevisitRate 3.3%；ProductiveRoundRatio 84.0%
- **RetryRate 0.989 为口径伪影**（单工具 harness 只有 bash，"错误后仍调同名工具"恒真）——该指标在本 harness 无区分度，最终报告注明
- 判读：9B 的问题不在重复调用，而在"长链规划中的状态推进质量"（productive 84% 但成功右移）

## 5. Retrieval / Context 层

- D1 空库：hit=0、injected_tokens=0、MemoryTokenRatio=0（有效零值，机制已采数，D2 起有真实读数）

## 6. Memory Quality / Economics 层

- 干净进化（全 flash，1362 调用，5.61M prompt + 113K completion tokens）：**active 235 卡（17 ABILITY + 218 EVIDENCE）**；dormant 池 10,000（cap）；removed 41,897（dormant cleanup 按 M3/F2 机制淘汰弱候选——机制实战触发）
- 教师成本（干净窗口）：约 5.6M+0.11M tokens（flash 单价见 metrics_v2 常量）；AmortizedTeacherCost 随复用次数 D2 起有意义
- **已废弃产物**（口径污染，仅供审计）：混合 pro/flash 打分版 28 卡 + snapshot-20260820-215037.db + run 目录移 /tmp（issue-017 指纹修复的动因）

## 7. 工程事件（本日三次故障，全部闭环）

issue-017（verifier 零重试随机炸批）→ **已修复**（temperature=0+重试 3 次+指纹含模型）；超时配置遗漏 → 已固化（TIMEOUT_MS 实测校准 90min，runbook）；issue-018（合成器无闭合标记、ETL 全隔离）→ **已修复**（闭合条目同构线上，ETL 实测 inserted=52,077/isolated=0）。issue-016 deferred（跨日显式 run-id 纪律执行中）。

## 8. D2 门槛（交叉日 runbook）

零差校准预期：X2−X1≈0（D2 时 current=frozen 同库）、X3−X4≈0、sanity |diff|≤0.05、TreatmentCompliance=100%；不达成即停批查混淆。

Refer Spec：doc/design/preview.html；doc/design/2026-08-19-d-stage-addendum-v2-main-review-and-decisions.md；doc/design/2026-08-21-d1-zero-cloud-escalation-diagnostic-report.md（issue-019）
