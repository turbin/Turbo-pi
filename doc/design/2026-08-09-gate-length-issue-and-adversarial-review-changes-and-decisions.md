# 2026-08-09 issue-003 登记 + 对抗性审查 — 决策记录

任务：门控 length 缺陷登记为本地 issue 并引用改造方案；对抗性审查全链路代码，找出其他可导致实验失败的 bug 并提供修复建议。

## 决策与理由

1. **登记为 issue-003（open）**：缺陷属"监控/复盘发现的实验有效性事故"，符合 issues-snapshot 登记范围；修复节引用 findings 文档 §5 方案 A/B/C + 本次代码核查修正，不重复描述方案细节（单一事实源）。
2. **方案 A 补充观察"冷库臂 agent-local 绕门控"被否定**：`routing.py:31` `del envelope`——V1 路由完全忽略 model 名，agent-local 无绕门控语义，实现需改 gateway 代码。理由：max_tokens 校准后门控≈不触发，保留门控（empty_output/invalid_tool 为真实质量信号）更接近生产口径，不值得为重跑引入 gateway 变更。
3. **max_tokens 不定 800，先 5 局 pilot 校准**：800 无依据，若仍系统性截断则全量成本再次作废；验收预注册门槛 model_runs 全量口径 length 升级率 <5%——制度化"拒绝小样本外推"教训（findings §6.1）。
4. **对抗审查采用 3 路并行（gateway / eval harness / agent-server 链路）**：缺陷跨三层，单层审查会漏跨层交互（如 M2 usage=0 根因在 agent-server 未请求 include_usage 而 gateway 按需发送；M9 thinking 臂间不对称横跨 provider 实现）。
5. **39 项发现不分拆为独立 issue**：一次性产生 39 个 issue 会淹没 index；审查报告作为单一文档承载，issue-003 引用之。用户拍板 P0-P2 分批后，实施时再将进入修复批次的项按 issues-snapshot 流程单独登记（含 red-first 回归测试）。
6. **不改 quality.py 门控规则**："有内容输出的 length 是否升级"是策略问题（tool_call JSON 截断必须升级 vs 纯文本可争论），需独立设计评审；与重跑混杂会污染 A/B 对照。记技术债。
7. **历史数据不回溯修改**：C3 证实的 alfworld-20260730 控制臂 17 局重放错位仅在报告中注明口径，不改原始数据（实验数据不可变原则）。
8. **文档纪律**：审查报告入 `doc/design/`、计划入 `doc/design/plans/`、INDEX.md 同步登记（文件索引 + 决策时间线 + living decisions 未变）、progress 交接节追加——同批完成。

## 待办（移交用户决策）

- 重跑方案 A/B/C 拍板（原 findings §5，含本次两处修正）。
- P0/P1/P2 修复批次拍板（P0=下轮跑批前必修，否则结果仍不可信）。
- issue-003 回归测试随修复落地（升级标记 pytest red-first + 升级率 gating 脚本）。

Refer Spec：2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md；2026-08-09-adversarial-review-experiment-validity.md；plans/2026-08-09-gate-length-issue-and-adversarial-review-plan.md；doc/issues-snapshot/README.md（登记流程）
