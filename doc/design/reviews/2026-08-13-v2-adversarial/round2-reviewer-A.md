# Round 2 复核结论 — 审查员甲（实现一致性 / 代码对照）

对象：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`（修订后）
输入：`round1-defense.md` 答辩记录 + 修订后 v2 全文 + 现役源码复核。
范围：仅核验我 Round 1 的 9 条 finding 是否消解（文字部分），不新开主题。

裁定图例：**认输**（消解）｜**认输 + 修订不到位**（主点消解，但某处文字未改净）｜**坚持**（附证据）。

---

## A1 端口 8789/8788 — 认输

§2.1 新增"口径说明"（v2 行 63）："agent-server :8789 为评估实例口径（`PORT` 环境变量覆盖），代码默认 8788；gateway :8787 为配置确定值"。与代码事实一致（`server.ts:593` `startServer(port=8788)`、`start.ts:3` `PORT ?? 8788`）。图内 :8789 保留为评估语境，有脚注自含说明，问题消解。

## A2 CloudProvider 类名 — 认输（图待重渲染）

模块表（行 245）本就写"DeepSeek 复用 KimiProvider"，正确。时序图/调用图 mermaid 源仍为 `CloudProvider.complete()`（行 102、196），但已明确归入统一重渲染批次（答辩 A2 行 + 任务说明"图内修订 A2/A8/A9"）。正文无残留错误类名。认输，仅提醒：重渲染批次须把这两处 `CloudProvider` 改为 `KimiProvider`（`providers/kimi.py:26`）。

## A3 EVIDENCE 上限 5 — 认输

§3.4 已改为"EVIDENCE（受 top-8 总量约束，无单独条数上限）与 Method/Guard（各上限 5 条）"。与 `injection.ts` 一致（`:11-12` METHOD_LIMIT/GUARD_LIMIT=5，`:64` evidence 全量拼接无截断）。问题消解。

## A4 rescore 降级未实现 — 认输（主点）+ 1 处修订不到位

主点已消解：§3.3 局限声明 (2)（行 271）明确"'rescore 降级'未实现：现役 rescore 仅复评 dormant，active 卡无降级/淘汰通道，一旦晋升即长期滞留"；§7 台账新增第 1 项（行 334）如实登记 active 无降级/淘汰通道。均与代码一致（`scheduler.ts:106` 仅 `listDormant`；`experience-store.ts` 仅 dormant→active / dormant→removed）。

**修订不到位 1 处**：§3.6 表（行 293）"经验卡 | 晋升、留观、降级、淘汰"仍把"降级"列为现役经验卡层机制，未加任何"未实现/待建"标注，与 §3.3 行 271 的新表述直接矛盾。答辩 A4 行承诺"§3.6 措辞改为如实状态"，但该行未动。建议改为"晋升、留观、淘汰（降级未实现，见 §3.3 / §7 台账）"或同等标注。

（附带提醒，非新反驳：图内 §2.1 `PROM["晋升 降级 清理"]`（行 34）与 §2.3 `RES["rescore 降级 + TTL 清理"]`（行 139）仍含"降级"，且不在任务点名的 A2/A8/A9 重渲染清单内，请一并纳入重渲染批次核对。）

## A5 归因奖惩与 confidence 未实现 — 认输

§2.3 文本补"注意：归因流为待建（演进方案 2），当前 retrievedIds 仅落盘不回写"；§4 标"归因（待建，演进方案 2）"；§3.6 表"实战归因（待建，演进方案 2）"与"元数据（待建）…（当前仅 quality 单字段，无 confidence 列）"。与代码一致（`types.ts:35` 无 confidence 字段；无 retrievedIds 回写代码）。问题消解。

## A6 局级胜负/三路合并未实现 — 认输

§3.5 拆为"运行方式（现役）"（外部 cron/launchd 全量批次、不消费胜负信号）与"设计意图（未落地）"（局级胜负迁移、三路合并为 R2 设计，现役代码无胜负过滤与三路分流），并在"有效作用"明示"'败局对照提取差在哪'的作用当前不成立"。与代码一致（`scheduler.ts` 注释"Triggering is external"；`etlSessionFiles`/`collectTrajectories` 全量读 *.jsonl 无胜负过滤）。问题消解。

## A7 toolcall-validator 非纯观察 — 认输（图待重渲染）

模块表（行 242）已改："/v1 透传路径仅观察不拦截；/api/stream 路径（validateToolCallStream）会整批拒绝非法 toolCall"。与代码一致（`toolcall-validator.ts:347/370` emit error 整批拒绝；observe-only 仅 `validateAccumulatedToolCalls` 路径）。调用图 mermaid（行 180）仍标"观察模式"，归入重渲染批次。问题消解。

## A8 create_trace 状态归属 — 认输（图待重渲染）

时序图（行 95）与调用图（行 191）仍写"create_trace() queued→leased→run_started"，归入重渲染批次。正文无此断言残留（正文仅模块表"请求状态机、model_runs 双印证、幂等与租约恢复"，准确）。问题消解（待图改）。

## A9 离线调用图边关系 — 认输（图待重渲染）

模块表已改净：行 247"offline/scheduler + pipeline + etl … dormant 复评与 TTL 清理（各阶段为 runDailyEvolution 的平级顺序调用）"；行 248"offline/verifier + canonicalize + checkpoint | 0.5 双阈值晋升、确定性去重、幂等 checkpoint"（已移除"dormant 复评与 TTL 清理"）。与代码一致（`scheduler.ts:90-148` 各阶段平级顺序调用）。离线调用图 mermaid 边关系（PY→PSO、VAC→RDS→CLN→WCK）归入重渲染批次。问题消解（待图改）。

---

## Round 2 汇总

| # | 裁定 | 备注 |
|---|---|---|
| A1 | 认输 | 脚注已补且准确 |
| A2 | 认输 | 图待重渲染（行 102/196 仍 CloudProvider） |
| A3 | 认输 | §3.4 已改 |
| A4 | 认输 + 1 处修订不到位 | §3.6 表行 293"晋升、留观、降级、淘汰"仍列"降级"未标注 |
| A5 | 认输 | §2.3/§3.6/§4 已标待建 |
| A6 | 认输 | §3.5 已拆现役/未落地 |
| A7 | 认输 | 模块表已改；图待重渲染 |
| A8 | 认输 | 图待重渲染 |
| A9 | 认输 | 模块表已改；图待重渲染 |

结论：9 条中 8 条完全消解，A4 主点消解但 §3.6 经验卡行（行 293）"降级"标注未改净，属修订不到位而非新问题。重渲染批次需核对：A2（行 102/196）、A4 图内"降级"（行 34/139）、A7（行 180）、A8（行 95/191）、A9（离线调用图边关系）。
