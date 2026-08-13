# 概要设计 v2 架构图拆分 — 变更与决策记录

日期：2026-08-13
对象文档：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`

## 变更内容

1. 原单一"总体架构图"拆分为四张图（§2.1–2.4）：
   - 2.1 模块分层架构图（保留原 L0–L4 五层图，补充各层职责一句话说明）；
   - 2.2 时序交互图（在线请求全链路 sequenceDiagram，含升级分支与双库落盘）；
   - 2.3 数据流图（在线流 / 离线每日循环 / 归因流三条流合一图）；
   - 2.4 调用图与模块职责（在线+升级链路、离线进化链路两张函数级 call graph + 模块职责一览表）。
2. 核心机制（§3.1–3.6）每节统一按"模块构成 / 运行方式 / 有效作用"三要素展开。
3. §4 关键数据流保留原文，逐条指向 2.3 对应子图。
4. INDEX.md 该文档一行摘要同步更新。

## 决策与理由

| # | 决策 | 理由 |
|---|---|---|
| 1 | 图内函数名、文件名、阈值（0.5、top-24/top-8、TTL 30 天、容量 10000、错误码 422/403/429）全部按 packages/agent-server 与 packages/agent-gateway 现役代码核实后标注 | 设计文档与实现脱节是历史问题来源；函数级 call graph 必须可对照源码 |
| 2 | model_runs 画在 gateway SQLite、experiences/request_traces 画在 agent-server SQLite，时序图分两个 DB participant | 两库物理分离是实现事实，单画一个"存储"会误导归因口径 |
| 3 | 分层图保留原五层结构不改层定义 | 层划分是既有共识（见 Refer 文档），本次任务仅拆分图示，不做架构重设计 |
| 4 | 核心机制只补充事实性描述，不新增设计内容；奖惩机制维持原表格 | 用户要求"详细说明"现役机制，不是修订机制本身 |
| 5 | 端口沿用文档既有口径（gateway :8787 / agent-server :8789 评估实例） | 与 v2 文档上下文及 eval 运行实例一致；默认 8788 为实现细节，不在概要层展开 |
| 6 | 时序图别名去引号、去 `<br/>`、去文本内 `→`（2026-08-13 第一次修订） | 带引号 participant 别名仅 mermaid 10+ 支持，旧版渲染器直接解析失败；修订后 mermaid 8.14 / 9.4.3 / 11 三版本 `mermaid.parse` 全通过 |
| 7 | 五张图预渲染为位图嵌入正文，mermaid 源码收入 `<details>` 折叠块（2026-08-13 第二、三次修订） | 用户使用 Warp 内置 markdown 预览，mermaid 渲染报错改为 SVG 后文字全部消失：mermaid 流程图标签默认输出 `<foreignObject>`（内嵌 HTML），非浏览器渲染器不支持；`htmlLabels:false` 配置对节点标签不生效。位图是唯一通用解 |
| 8 | 正文嵌入 2x PNG（-w 1600 -s 2，白底），SVG 副本保留在同目录 | PNG 任何查看器可见且高分屏清晰；SVG 供浏览器场景使用。资产目录 `doc/design/assets/2026-08-13-high-level-design-v2/`；改图流程：改折叠块内源码 → 重新渲染同名 PNG/SVG |

Refer Spec：doc/design/2026-08-13-agent-server-high-level-design-v2.md；doc/design/2026-08-13-agent-server-system-design-and-issue-inventory.md
