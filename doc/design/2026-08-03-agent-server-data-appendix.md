# 数据附录：学生-老师管线与经验飞轮实验全量数据表

日期：2026-07-30 ~ 08-03
用途：论文写作数据留存。所有表格均可由原始数据复算（§6 数据清单含路径与复算方法）。
实验平台：Mac mini M-series（64GB），omlx gemma-4-12B-it-4bit（学生），DeepSeek v4-flash（老师/agent 模型），agent-gateway（质量门控路由），agent-server（经验注入）

---

## 1. 三腿 A/B 总表（ALFWorld valid_unseen 134 局，ReAct 2-shot，temp=0）

| 指标 | L1 DeepSeek 直连 | L2 学生基线 | L3 学生+注入（冷库） | R2 学生+注入（热库） |
|---|---|---|---|---|
| SR (won/134) | 9 (6.72%) | 8 (5.97%) | 10 (7.46%) | 11 (8.21%) |
| 平均步数 | — | — | 47.5 | 46.5 |
| 无效动作率（obs="Nothing happens."） | — | — | 41.2% (2625/6367) | 28.6% (1782/6225) |
| 升级率（primary→escalation） | — | 74.3% (4823/6487) | 72.6% (4706/6484) | 54.4% (3376/6204) |
| omlx primary input tokens | — | 14.44M | 15.26M | 16.88M |
| DeepSeek escalation input tokens | 14.04M（全量直连） | 10.94M | 11.11M | 9.10M |
| output tokens（client 侧） | 89k | 96k | 0（透传缺陷，见 §5） | 74k（升级侧） |
| 检索命中率（请求级） | — | — | 0%（冷库） | 100% (6231/6231) |
| 平均注入条数/请求 | — | — | 0 | 8 |
| 墙钟 | 1.5h | 8.0h | 9.3h | 10.1h |
| 云端成本估算（$0.14/1M in, $0.28/1M out） | ~$2.0 | ~$1.5 | ~$1.6 | ~$1.3 |

注：L1 的 in/out 为 client 记录全量；L2/L3/R2 的模型侧 token 按 gateway model_runs 时间窗聚合（CSV 见 §6）。

## 2. 分任务类型 SR（won/n）

| 任务类型 | L1 | L2 | L3(冷) | R2(热) |
|---|---|---|---|---|
| look_at_obj (18) | 6 | 6 | 9 | 9 |
| pick_cool_then_place (21-25) | 2 | 1 | 1 | 2 |
| pick_heat_then_place (23) | 1 | 0 | 0 | 0 |
| pick_clean_then_place (31-32) | 0 | 1 | 0 | 0 |
| pick_and_place (22-24) | 0 | 0 | 0 | 0 |
| pick_two_obj (14-17) | 0 | 0 | 0 | 0 |

## 3. E5 飞轮冷/热对照（判据②）

| 指标 | R1 冷库 | R2 热库 | Δ |
|---|---|---|---|
| SR | 7.46% | 8.21% | +0.75pp（+1 局，<1 SE≈2.3pp） |
| 胜负翻转 | — | +6 / -5（净 +1） | 见 trials.csv |
| empty_output 升级次数 | 4691 | 3342 | **-28.8%** |
| finish_reason_length 升级 | 13 | 28 | +15 |
| 无效动作率 | 41.2% | 28.6% | **-12.6pp** |
| 升级率 | 72.6% | 54.4% | **-18.2pp** |
| DeepSeek input tokens | 11.11M | 9.10M | -18.1% |
| 检索命中率 | 0% | 100% | — |
| 进化产出 | — | 238 active EVIDENCE（均 quality 0.547） | 见 §4 |

## 4. 经验库形态（热库轮注入内容）

| 维度 | 数值 |
|---|---|
| active 经验总数 | 238（全部 EVIDENCE 类型） |
| ABILITY Method/Guard | **0**（未产出） |
| 平均 quality | 0.547 |
| dormant（quality=0 候选） | 10000（cap） |
| removed | 8076 |
| 内容形态 | 轨迹句子碎片（"Action: ..."/"Observation: ..."），含可复用格式示范与位置暗示（双刃剑，见 E5 §7） |
| 进化输入 | 134 局合成任务级轨迹（从 per-request session 前缀匹配回構） |

## 5. empty_output 根因实验（gemma-4-12B-it-4bit，直连 omlx，temp=0）

### 5.1 步数扫描（同一局、同一 2-shot head）

| 历史步数 | 0 | 3 | 5 | 8 | 10 | 12 | 15 | 18 | 20 |
|---|---|---|---|---|---|---|---|---|---|
| 结果 | EMPTY | ok | ok | EMPTY | ok | ok | ok | ok | EMPTY |

### 5.2 prompt 消融（steps=20 的 EMPTY 案例）

| 变体 | 结果 |
|---|---|
| 原始（范例+历史，含 `>`） | EMPTY（completion_tokens=2，content 缺失） |
| 去范例（仅历史） | 正常（65 tok） |
| 仅范例（无历史） | EMPTY |
| 尾部 `>`→`Action:` | EMPTY |
| 全部 `>`→`Action:` | 正常（36 tok） |
| 同 prompt 换 Qwen3.5-27B-Distilled | 正常 |

### 5.3 排除项（均实证阴性）

stop 参数（3 变体均 EMPTY）｜长 prompt（2-4k tokens vs 上限 262k）｜模型换载（27B 换入后 5/5 正常）｜reasoning_content 被丢弃（原始响应无该字段）｜gateway 链路（复现内容为升级后 DeepSeek 产物）｜历史诱导（连续 10 次 "Nothing happens." 正常）｜rapid-fire（20/20 正常）

## 6. 数据清单（原始数据与复算路径）

| 数据 | 路径 | 说明 |
|---|---|---|
| 逐局明细（536 行：腿×局×胜负/步数/无效动作/token/耗时） | `doc/research/data/alfworld-trials.csv` | 由 §7 四处 JSONL 直接生成 |
| 升级统计（窗口×provider×purpose×原因） | `doc/research/data/escalation-stats.csv` | gateway var/agent_gateway.db model_runs |
| L1 轨迹 | `packages/agent-server/eval/results/alfworld-20260730/control-full.jsonl` | 134 局全轨迹 |
| L2 轨迹 | `.../student-full.jsonl` | 同上 |
| L3 冷库轨迹 | `.../experiment-full.jsonl` | 同上 |
| R2 热库轨迹 | `.../experiment-round2-warm.jsonl` | 同上 |
| R1 原料 session（6372） | `.../sessions-archive-l3/` | 防泄漏归档 |
| R2 session（6231） | `.../sessions-archive-r2-warm/` | 同上 |
| 进化合成输入（134 局） | `packages/agent-server/var/eval/sessions-r1/` | pi v3 格式 |
| 评估经验库 | `packages/agent-server/var/eval/experience.db` | 238 active + checkpoints |
| 检索命中记录 | 同上 `request_traces` 表 | 6231 行（hit/retrieved_ids/kinds） |
| 门控调用明细 | `packages/agent-gateway/var/agent_gateway.db` `model_runs` | sequence/purpose/provider/signals/tokens |

复算示例：`alfworld-trials.csv` 任意指标 = 对 leg 列 groupby；升级率 = escalation-stats 同窗口 escalation/primary。

## 7. 方法论备注（论文写作时必须同报的限定）

1. 单臂 134 局、SR ~6-8%，腿间差 <2.3pp（1 SE）——所有 Δ<2 局的比较均为噪声级，本文仅报告方向与强次级信号（升级率/无效动作率/成本）
2. R2 热库轮 L3 冷库轮基线为同一 sorted 游戏序、同 agent、同参数；唯一变量=经验库冷热
3. 学生腿 = gemma + 门控升级混合管线（升级率 54-74%），非纯本地模型成绩
4. L3 冷库轮注入为空块（评估库经验=0），是"注入无害"的有效对照而非"有益"对照
5. L3/R2 client 侧 usage 透传存在缺陷（§1 标注），token 成本一律以 gateway model_runs 为准

Refer Spec：`doc/design/2026-07-31-agent-server-alfworld-three-leg-report.md`；`doc/design/2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md`；`doc/design/2026-07-31-agent-server-student-empty-output-analysis.md`
