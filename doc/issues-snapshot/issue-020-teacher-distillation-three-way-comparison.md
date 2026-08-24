# issue-020: 教师单一来源验证——三教师蒸馏对照实验（flash / pro / Kimi K3，D7 后验证）

- 状态：**deferred（2026-08-24 用户裁决：登记待办，D7 后延后验证；非故障项，属实验设计评估）**
- 报告：2026-08-24（用户提出：换 v4-pro 或 Kimi K3 做进化教师是否更好）
- 影响面：离线进化管线教师口径（`LLM_MODEL`/`TEACHER_MODEL` env）、D 阶段收口报告的教师质量章节、ALFWorld 阶段教师选型

## 背景与问题

D 阶段经验卡的蒸馏、打分、判分全部由 DeepSeek 一家承担（进化教师=v4-flash，judge=v4-pro，升级腿=v4-flash）。已知风险（preview §13、GPT 评审 §七）：

1. **Teacher/Judge 同源**：判卷老师可能偏爱自家风格（D2 Kimi audit verdict=consistent 暂未显现，n=6 样本小）；
2. **教师质量即上限**：若 DeepSeek 的提炼有系统性偏差，学生学到的就是偏见。

用户问题：用 v4-pro（推理更强）或 Kimi K3（K2.7 Coding，外校视角）做进化教师是否更好？主会话评估：D 阶段中途不换（口径一致性优先，pro/flash 混合打分曾致废库——issue-017 教训；Kimi 打分链路 logprobs/temperature 口径未验证），但值得 D7 后离线对照验证。

## 验证设计（D7 后执行，离线、不动主线）

**对象**：D 阶段同一批轨迹（取 D3/D4 重复集 transcripts 中 ≥10 个任务，覆盖易/中/难三档）。

**三臂蒸馏**：
- A 臂：deepseek-v4-flash（现役口径，对照基线）
- B 臂：deepseek-v4-pro
- C 臂：Kimi K3（kimi-for-coding，`https://api.kimi.com/coding/v1`）

**评估口径（预注册，执行前冻结）**：
1. **卡质量**：同一 verifier 对三臂卡逐张打分（G 刻度偏好概率；Kimi 臂若 logprobs 不可用走文本回退并标注；K2.7 temperature 固定 1.0 的口径差异入报告 notes——2026-08-21 audit 实测）；
2. **学生效用**（决定性指标）：三臂卡分别注入同批 held-out 风格任务跑 9B 学生（各 ≥3 任务），比较注入后 Δscore；
3. **成本**：每臂蒸馏 token 与单价（台账口径）。

**裁决规则**：学生效用差 >0.05 且卡质量同向 → 教师升级（ALFWorld 阶段换教师或双教师交叉蒸馏）；否则维持 flash（便宜稳定）。若 Kimi 打分链路验证失败（logprobs 不可用且文本回退不稳定），C 臂降级为"仅定性对比"并在报告声明。

## 前置依赖

- D7 完成（主线数据定型）；
- Kimi 打分链路口径冒烟（logprobs 支持验证，复用 kimi_audit.py 的本地调用函数改造）；
- issue-017 的打分指纹含模型字段已生效（三臂断点天然隔离，可安全 --resume）。

## 回归测试

执行时补：三臂蒸馏产物互不相同（防"换模型没换结果"假对照）；学生效用对比的配对完整性（同任务同 workspace 克隆）。

Refer Spec：doc/design/D阶段实验设计补充评审_指标与条件检查.md（§七 教师计划质量）；doc/design/preview.html（§13 Teacher/Judge 同源）；doc/issues-snapshot/issue-017（混合打分教训）
