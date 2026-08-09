# 2026-08-09 B 阶段（27B 冷/热库）结果与门控 length 缺陷分析

状态：**结果已定稿，结论已修正；双臂重跑方案待用户拍板（A/B/C）**。
数据：`eval/results/alfworld-20260804/student27b-cold-v2.jsonl`、`student27b-hot.jsonl`、`doc/research/data/alfworld-27b-round-comparison.csv`、gateway `var/agent_gateway.db`（model_runs）。

## 1. 表面结果（冷/热对照）

| 指标 | 冷库 v2 | 热库轮 | Δ |
|---|---|---|---|
| SR | 21/134（15.7%） | 21/134（15.7%） | **0** |
| look_at_obj | 17/18 | 18/18 | 热 +1 |
| pick_heat | 1/23 | 0/23 | 冷 +1 |
| 其余类型 | 持平（0 或极少） | 持平 | 0 |
| 独胜局 | 冷独胜 #63 | 热独胜 #94 | 各 1 局互翻 |
| 总步数 | 5,892 | 5,840 | ≈ |
| 墙钟 | 39.8h | 45.0h | 热 +13%（8789 一跳+注入 prompt 变长） |
| 注入命中 | — | 5,859 次命中 / 251 个不同注入集合 | 头部集合集中但非完全不分任务 |

按预注册判读纪律：Δ=0 落在 ±3pp 噪声带——**注入对该系统无净效应**。

## 2. 重大发现：两臂均为 27B+DeepSeek 混合体（门控 length 缺陷）

### 证据链

1. gateway `model_runs`：冷库窗口（08-04 21:00~08-06 14:45）4,991 次本地调用 + **4,175 次升级（84%）**；热库窗口（08-07 12:50 起）4,915 次本地 + **4,278 次升级（87%，含 9 次失败）**。两臂混合比例几乎相同。
2. 升级原因 100% = `finish_reason_length`（2,991/3,000 抽样）。
3. 门控规则：`packages/agent-gateway/src/agent_gateway/quality.py:90`——`finish_reason == "length"` 即升级。
4. 触发链：`alfworld_agent.py` 设 `max_tokens=200`（v1 叙述泄漏修复时为提取命令所设），27B 蒸馏模型的叙述风格（"Let me think..." 后给命令）频繁超 200 token → 截断 → 门控判截断为不合格 → 升级 DeepSeek。

### 定性

**harness 配置缺陷，非模型能力问题**：27B 的本地回答约 85% 被门控丢弃，B 阶段从头到尾没有测过"纯 27B"。A 阶段 bisect 的"27B 升级率 0/147=0%"结论系样本不具代表性，**作废**。

## 3. 结论修正清单（撤回先前报告的说法）

| 原说法 | 修正后 |
|---|---|
| 27B 升级率 0%（A 阶段 bisect） | 全量口径 84-87%；bisect 结论作废 |
| 本地小模型独立工作已下定论 | 未验证——尚无纯 27B 数据 |
| 27B SR 是 DeepSeek 老师 2.3 倍 | 15.7% 是 DeepSeek 主导混合体的成绩，不能归因 27B |
| 云端成本归零 | 相反：热库轮 DeepSeek 输入 12.9M token（冷库 9.2M） |
| 注入对纯 27B 无净效应 | 改为：注入对"DeepSeek 主导混合体"无净效应（Δ=0，两臂同混合比，A/B 有效性不受影响） |

## 4. 仍然成立的结论

1. 冷/热 Δ=0 的 A/B 对照本身有效（两臂混合比例相同，唯一变量是注入）。
2. 进化管线可产出程序级卡片（41 Method + 62 Guard active，E5 为 0），注入通路正常（98%+ 命中率，构成 工作流×5+方法×2+护栏×1）。
3. 卡片"自评通过"不等于"行为效用"——本轮是对验证闸门预测力的一次负证据。
4. gemma 时代三腿/E5 结论不受本轮影响（其升级为 empty_output 真实触发，D3 已判）。

## 5. 补救方案（待用户拍板）

| 方案 | 内容 | 成本 | 产出 |
|---|---|---|---|
| **A（推荐）** | `alfworld_agent.py` max_tokens 200→800，冷+热双臂重跑 | ~4 天 | 首批纯 27B 基线 + 注入净效应 |
| B | 接受混合体为系统真实行为，报告按混合口径改写 | 0 | 无纯 27B 结论 |
| C | 仅冷库重跑拿纯 27B 基线，热库视结果再定 | ~2 天 | 基线先行，风险分段 |

补充技术观察：若选 A，可同时把冷库臂改为 `agent-local` 路由（绕开门控）以获得绝对纯净基线，热库臂保持 `agent-auto`（生产真实路径）——两个口径的数据一次拿到。

## 6. 方法论教训（沉淀）

1. **"升级率"必须以 gateway model_runs 全量口径核验**，任何小样本外推（147 请求）都可能失真；验收纪律已要求直查原始数据，本次是执行漏洞（bisect 替代了全量核验）。
2. harness 参数（max_tokens）与模型输出风格的兼容性是门控系统的隐含耦合点，换模型必须重验门控触发率。
3. 门控 `finish_reason_length` 规则对"叙述型模型 + 小 max_tokens"场景存在系统性误杀——规则本身可讨论（有内容输出的 length 是否该升级），记入技术债。

Refer Spec：2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md；2026-08-07-agent-server-experience-production-line.md；2026-07-31-agent-server-student-empty-output-analysis.md（empty_output 门控起源）
