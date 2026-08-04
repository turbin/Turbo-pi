# Agent-Server E5：飞轮实验（冷库→进化→热库）——变更与决策记录

日期：2026-08-03
SPEC：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 总任务书判据②）；`doc/design/2026-07-25-agent-server-eval-report-design.md`（报告设计）
进度：`doc/design/progress/2026-07-24-eval-benchmark.md`
状态：**已完成（判据②方向成立，效应量为噪声级——详见 §3 诚实判定）**

---

## 1. 实验设计

| 轮次 | 内容 | 数据 |
|---|---|---|
| R1 冷库轮 | L3 学生+注入 134 局（评估库经验=0，注入空块） | SR 10/134 = 7.5%（已完成于 07-31） |
| 进化 | `runDailyEvolution`（DeepSeek teacher：v4-flash 评分/v4-pro 抽取） | checkpoint metric=**238**（active EVIDENCE 238 条，均 quality 0.547；dormant 10000 cap/removed 8076） |
| R2 热库轮 | 同 134 局同 agent 同参数，注入开启 | 检索命中 **6231/6231（100%）**，平均每请求注入 8 条 |

两臂严格控制：同 sorted 游戏序、同 ReAct agent、同参数（temp=0/stop/max_tokens=100/thinking=disabled）、同学生管线（8789→8787→omlx+升级）。唯一变量 = 经验库冷/热。

## 2. 结果

| 指标 | R1 冷库 | R2 热库 | Δ |
|---|---|---|---|
| **SR** | 10/134 = **7.5%** | 11/134 = **8.2%** | +1 局（+0.7pp） |
| 平均步数 | 47.5 | 46.5 | -1.0 |
| 胜负翻转 | — | +6 / -5 | 净 +1 |
| 升级率（gateway） | 72.6% | 54.4%（3376/6204） | **-18.2pp** |
| 云端 token（DeepSeek 计费面） | 11.11M | 9.10M | -18% |
| omlx 本地 token | 15.26M | 16.88M | +11% |
| 检索命中率 | 0%（冷库） | 100% | — |

分类型 SR：look_at_obj 9/18 → 9/18；pick_cool 1/21 → **2/21**；其余四型两臂均 0。

## 3. 判据②判定（诚实声明）

**判据②（轮2 > 轮1）：方向成立（8.2% > 7.5%），但效应量（+1 局）在单 SE（~2.3pp）以内，统计上不可归因。**

有价值的次级证据（同一方向）：
1. **升级率 -18.2pp**（72.6%→54.4%）——注入的经验使学生更多步通过门控，升级率下降幅度远超 SR 变化的噪声级，是"经验在帮助学生"的更强信号
2. 云端 token -18% 与步数 -1.0 同向
3. 翻转 +6/-5 覆盖 5 个 look_at_obj 局改善——注入内容恰含大量 look/examine 类 Action/Observation 证据（与 238 条 EVIDENCE 的来源一致）

结论：**飞轮有效性的首次正向信号已出现（判据②方向成立），但单轮效应量不足以作强结论；建议进化 2-3 轮后复测（轮次累积效应）或用更大样本确认。**

## 4. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| E5-D1 | 进化输入用**合成的 134 局干净 session**（`var/eval/sessions-r1/`），不用 6372 个 per-request session 原文件 | 原文件每请求一文件、6372 条轨迹喂管线两次超时/SIGKILL（300s 与 7200s 均失败）；合成方式：L3 JSONL 轨迹 + session 任务行前缀匹配回構（132/134 自动覆盖 + 2 局任务行补全），ETL/管线幂等兼容 |
| E5-D2 | 进化前评估库重置为 07-29 备份（0 经验状态） | 第一次失败运行遗留 9718 条 quality=0 dormant 污染，会挤占 rescore 与检索 |
| E5-D3 | 判据②判定为"方向成立+效应量噪声级"，不宣告强胜利 | 134 局单轮 +1 局 < 1 SE；按预注册判据与 Harness-Bench 纪律如实报告 |
| E5-D4 | R2 session 6231 个已归档 `sessions-archive-r2-warm/`（归档纪律） | 防泄漏；也是进化第 2 轮的候选原料 |
| E5-D5 | 坑记录：管线超时与输入规模强相关；合成轨迹是标准做法 | 写入 progress 交接，后续 benchmark 复用 |

## 5. 产出清单

- 数据：`eval/results/alfworld-20260730/experiment-round2-warm.jsonl`（134 局全轨迹）、`sessions-archive-r2-warm/`（6231）、`sessions-archive-l3/`（6372，R1 原料）
- 经验库：`var/eval/experience.db`（238 active EVIDENCE）
- 合成输入：`var/eval/sessions-r1/`（134 局，可复用于进化第 2 轮）

## 6. 下一步建议（交还用户拍板）

1. **进化第 2 轮**（R1+R2 轨迹合并再进化 → R3 轮）——看效应量是否随轮次放大（飞轮的复利性质才是真判据）
2. R2 S1 学生换型（27B）——与飞轮独立，可并行
3. 或者按路线推进 R4 QwenClawBench

## 7. 追加分析：为什么热库只领先 1 局（2026-08-03 用户追问）

**数据事实**：

1. **经验形态**：238 条 active 全部是 EVIDENCE 原始碎片（Action/Observation 句子），Method/Guard/guidance 类 = **0 条**；检索命中的是同类游戏的位置/动作描述（如 "On the desk 1, you see a desklamp 1"）
2. **效应分解**：empty_output 升级 4691→3342（**-29%**）；轨迹无效动作率（obs="Nothing happens."）41.2%→28.6%（**-12.6pp**）；SR 仅 +1 局

**结论（分层瓶颈解释）**：注入碎片是 gemma 缺失的**格式示范**，大幅修复了生成层（空输出/无效动作）——升级率 -18.2pp 的来源即此；但 SR 天花板在**规划层**（valid_unseen 物体位置未见，探索策略弱），位置类碎片对规划既不可用还可能构成错误暗示（正负对冲）。净值 = 大格式收益 × 规划对冲 = +1 局。**这不是飞轮无效，而是当前经验形态（原始碎片）够不到规划瓶颈。**

**改进路径**（优先级序）：

1. 经验提炼升级方法级：Method/Guard ABILITY 或 Skill-DISCO 式过程技能（当前 pipeline 未产出，因 R1 成功轨迹仅 10/134——稀疏，Skill-DISCO 论文同样警告）
2. 位置类碎片过滤/降权（检索侧加类型权重或 payload 黑名单）
3. 成功轨迹富集先行：S1 换型 27B 或老师直连跑出更多成功局，再进化——先解决"无米下锅"

Refer Spec：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`；`doc/design/2026-07-31-agent-server-alfworld-three-leg-report.md`；`doc/design/2026-07-31-agent-server-student-empty-output-analysis.md`
