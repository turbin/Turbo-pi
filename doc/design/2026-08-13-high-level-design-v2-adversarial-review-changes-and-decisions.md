# 概要设计 v2 对抗式审查 — 变更与决策记录

日期：2026-08-13
对象文档：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`
审查档案：`doc/design/reviews/2026-08-13-v2-adversarial/`（过程与结论见 CONCLUSION.md）

## 变更内容

1. v2 文档引入"现役/待建"状态标注制：实战归因（§2.3/§3.6/§4）、rescore 降级（§3.3/§3.6）、局级胜负触发与三路合并（§3.5）、换载语义与门控边界（§2.1/§2.3）等改为如实状态描述。
2. 事实性修订：端口口径脚注（§2.1）、EVIDENCE 上限（§3.4）、模块表职责错配（§2.4）、§1 补判据口径/混淆因子/教师指导形态、§3.1 补 fail-closed/DLP/预算/双印证边界、§3.4 补六条边界声明。
3. 红线 3 修订为如实描述（0.5 统一仅适用 EVIDENCE/ABILITY；SOP quality=1、SKILL utility 另尺度）。
4. §5 新增演进方案 6（库版本交叉评估臂）；§7 台账新增审查发现项 1-10。
5. 五张图按修订后 mermaid 重渲染（PNG 2x + SVG）：CloudProvider→KimiProvider、create_trace 状态归属、离线调用图平级化、"降级"字样改"复评"、归因流标注待建、toolcall-validator 标注可拦截。

## 决策与理由

| # | 决策 | 理由 |
|---|---|---|
| 1 | 对抗审查采用"三审查员 + 主会话答辩"制，轮次上限 5，第 3 轮收敛 | 审查员持对立视角独立核实代码；设计方答辩区分"文档病/设计缺口/驳回"，避免一边倒 |
| 2 | 接受的 finding 分两级处理：措辞/事实错误本轮直接改文档；设计缺口入 §7 台账而非现场改设计 | 概要设计文档的修订权限限于如实描述；机制变更需逐案请示（§5 既定纪律） |
| 3 | 驳回乙-F2"本体鸿沟"、乙-F4"A/B 污染"、乙-F14"不可启动"三处全称判断，接受其可操作内核 | 全称推断超出证据；内核（交叉评估臂、top-N 非平稳、教师步骤标注）转化为演进 6 与台账 9 |
| 4 | 乙-F7 设计方认输并撤回 round 1 反驳 | dormant 存量由默认插入态+吞吐解释，不能作为闸门拦截证据；0.5 未校准属实（台账 10） |
| 5 | 图内修订集中在收敛后一批次重渲染，沿用 -w 1600 -s 2 白底 PNG + SVG 双格式 | 决策记录（2026-08-13-diagram-split 决策 7/8）既定：位图是唯一通用解，改图必须重渲染 |
| 6 | SOP/SKILL 是否统一过 0.5 闸列为用户裁决点，不自行收紧实现 | 涉及晋升语义变更，超出文档修订权限 |

Refer Spec：doc/design/2026-08-13-agent-server-high-level-design-v2.md；doc/design/reviews/2026-08-13-v2-adversarial/CONCLUSION.md；doc/design/2026-08-13-high-level-design-v2-diagram-split-changes-and-decisions.md
