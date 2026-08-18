# 答辩回复：round-1 发现逐条响应（答辩方：主会话）

日期：2026-08-14
方法：全部 critical/major 发现的代码证据由答辩方独立复核（experience-store.ts:385-397、server.ts:165/404、injection.ts:33/56/88-102、proxy-handler.ts:74、verification_selection pipeline.py:24/experience.py:31、verifier.ts:60/147/169 均复看原文）；F-1 数据实证独立复跑（`sqlite3 experience-c-final.db`：860 行、ts 仅 08-09(491)/08-10(369)、hit=1 仅 4 行、request_id 860  distinct——确认碰撞合并）；F-11 标签证据独立复核（`git tag` 空、changelog 最新 [0.80.10] 2026-07-16、remote tags 无）。

## 裁决请求汇总

| # | 严重度 | 答辩立场 | 备注 |
|---|---|---|---|
| F-1 | critical | **接受** | 独立数据实证复核通过 |
| F-2 | major | **接受** | 代码复核通过 |
| F-3 | major | **接受** | 代码复核通过 |
| F-4 | major | **接受** | 代码复核通过 |
| F-5 | major | **接受** | 代码复核通过 |
| F-6 | major | **接受** | 代码复核通过 |
| F-7 | major | **接受** | 含走向调整（见下） |
| F-8 | major | **接受** | |
| F-9 | major | **接受** | 回填策略有具体化补充（见下） |
| F-10 | major | **接受** | |
| F-11 | major | **结论接受，证据反驳** | 仓库无 git tags，"v0.81.0 (2026-07-21)"不存在；changelog 最新 0.80.10（07-16）。但"修复后零发布周期"实质结论成立 |
| F-12 | minor | **接受** | |
| F-13 | minor | **接受** | 重蒸 vs 补字段定案为重蒸（LLM 回填无验证通道，质量风险不可控） |
| F-14 | minor | **接受** | |
| F-15 | minor | **接受** | |
| F-16 | minor | **接受** | §7 标注为已完成 |
| F-17 | minor | **接受** | |

接受 17/17（F-11 证据修正但不改结论）。无维持对抗项。

## 关键补充说明（超出审查建议的部分）

1. **F-1 应升格为 issue 登记**：requestId 碰撞致跨日 trace 静默合并是系统性数据收集缺陷，影响面超出本方案（凡依赖 request_traces 的分析均受污染），建议登记 issue-013（归因数据通道缺陷），按仓库纪律配回归测试。方案修订为新增前置批次 **F0 归因数据通道修复**：requestId 改 randomUUID、落实际注入集（响应 F-2）、task_id 经 harness→session 头→request_traces 透传（响应 F-3）。
2. **F-1 对 C 既有结论的回溯影响声明**：C 报告的 +10.3pp 归因与升级率口径以 model_runs（gateway 侧）全量为准（红线 6），不经 request_traces，故 C 判据结论不受此缺陷污染；受影响的仅是 F2 规划的"历史回放后验"验收。建议在方案中显式写此边界，避免过度回溯恐慌。
3. **F-7 走向**：接受"独立任务数 ≥3（预注册取值）+ 首版仅降权不自动降级"的保守路径；active→dormant 降级通道仍建（F-14 的复升排除机制配套），但触发条件改为人工确认或更高证据门槛，全自动降级待样本量充分后启用。
4. **F-9 具体化**：域过滤规则定为"卡无 domain 不过滤（向后兼容存量 920 卡），有 domain 才参与过滤"；存量卡回填走 F1 重蒸顺带打标（域=office），不做单独 LLM 回填。在线 domain 通道改动点清单（types/server/proxy-handler/retrieval/harness）列入 F3 改动点，工期上修至 1-2 天。
5. **F-11 措辞修正**：§6 改为"全部保持 fixed，下一发布周期后评估 closed"；issue-008/009 表述改为"修复后（D1/D2 起）无复发"。

## 方案修订承诺

答辩方将按上述全部接受项修订 `doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md`（新增 F0、F1 模块落点三处修正、F2 注入集/样本单位/保守降级/迁移方案/检索侧改动点、F3 回填与通道、§5-1 口径修正、§6 措辞、§7 完成标注、测试落点补 Python 侧），修订稿交 round 2 复核。

请审查员对本答辩逐条裁决：维持 / 关闭 / 降级，并对"补充说明"中的 5 点（尤其 F-1 升格 issue-013 与 C 结论回溯边界声明）表态。
