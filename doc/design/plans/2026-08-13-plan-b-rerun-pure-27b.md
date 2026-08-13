# 方案：B' 重跑——纯 27B 基线与注入净效应（issue-003 收口）

- 状态：**待启动（C 阶段完成后询问用户确认；内含 A/B/C 三选）**
- 来源：issue-003（门控 length 缺陷）；08-09 findings 文档 §5
- 预估：pilot 0.5 天 + 双臂 ~4 天（方案 A）

## 问题

B 阶段两臂 84-87% 请求因 `finish_reason_length` 误升级 DeepSeek（max_tokens=200 × 27B 叙述截断），纯 27B 能力从未被测；四项结论已撤回待重测。

## 前置：pilot 校准（0.5 天）

冷库 5 局 ×（max_tokens 800 / 1024）对照，实测 finish_reason 分布与升级率，定最终 max_tokens；`gate_length_escalation.py` 门控（<5%）通过才进全量。

## 三选方案

| 方案 | 内容 | 耗时 | 产出 |
|---|---|---|---|
| A（推荐） | 冷+热双臂 134 局重跑（max_tokens 修正值） | ~4 天 | 纯 27B 基线 + 注入净效应 |
| B | 不重跑，混合口径定稿 | 0 | 无纯 27B 结论 |
| C | 仅冷库重跑，热库视结果再定 | ~2 天 | 先拿基线，风险分段 |

## 口径要点

- 冷库臂可用 `agent-local` 路由（绕开门控，绝对纯净基线），热库臂保持 `agent-auto`（生产真实路径）——两口径一次拿到
- 与 C 结论交叉：ALFWorld 域 + 办公域的双域对照，规模-学习曲线终版

## 验收

- 升级率全量口径（model_runs）<5%
- issue-003 关闭；撤回的四项结论以新数据重新定性

Refer：doc/issues-snapshot/issue-003；doc/design/2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md
