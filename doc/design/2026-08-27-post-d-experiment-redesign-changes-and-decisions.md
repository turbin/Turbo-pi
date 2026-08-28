# D 阶段后续实验重设计决策记录

日期：2026-08-27

引用：`2026-08-27-9b-campaign-d-phase-final-report.md`、`plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`、`2026-08-27-post-d-experiment-redesign-adversarial-review.md`

## 结论

完成最多 5 轮 Kimi 工程调查 × Codex 批判审查。新方案在设计层通过，但现有工程不具备直接跑批条件；下一步只允许在用户批准后实施 P0 + E0，E0 验收通过后再批准 E1。v1 记忆继续冻结，ALFWorld 继续阻断。

## 决策

### D-01：先证明测量系统，再判断记忆能力

在 E1 前增加 P0 + E0：独立 workspace、臂指纹、canonical request hash、注入覆盖探针、真实 token 计量、trace 关联和 issue-023。原因是当前 T9 重复共享目录，且注入开关不能隔离 wrapper、Skill/SOP 和卡片内容；继续跑会把 harness 差异误判为模型能力变化。

### D-02：E1 使用“裸基线 + 内容 × 剂量”设计

删除 top-2/top-4/top-8 单因素梯度，改为低/高剂量 × 中性/真实内容的 2×2，另保留裸基线。原因是原设计同时改变内容与剂量，无法区分上下文占用和卡片语义的效应。

### D-03：E2/E3 由 E1 结果触发，不再自动执行

真实内容劣于等剂量中性内容时必须做内容治理；无收益且无伤害时可直接 No-Go；只有剂量伤害时优先做最小剂量修法。原因是全流程无条件串行既昂贵，也会在已经足够作出停止决策后继续消耗样本。

### D-04：E2 使用版本化 sidecar 和序贯标注

第一阶段标注 120 张，覆盖 D7 注入、高复用、高风险及随机分层样本；证据不足才扩至 200/500。标签先写 sidecar，不修改生产 `experiences` schema。原因是实验标签需要可撤销、可双盲和可版本化，尚无证据支持污染运行时 schema。

### D-05：交付一致性以任务/grader manifest 为真值

从任务正文、grader 和人工裁决生成带哈希的 `deliverable_manifest`，卡片自报的 deliverables 不能作为官方要求。原因是 D7 已出现攻略卡改变交付要求的致害案例。

### D-06：v2 只能从冻结 v1 可复现派生

采用“v1 SHA256 + sidecar 规则版本 → 新 SQLite + manifest + SHA256”的 builder，禁止手改 live DB。原因是只有这样才能复算过滤规则并避免污染冻结证据。

### D-07：20 个从未执行任务是严格确认集

生成 `confirm-task-manifest.json`，E0–E3 runner 必须以 denylist 技术阻断；原 8 个 held-out 已执行，只能作为未进 evolution 的次级验证。跨日重复不增加独立任务 n。原因是计划分片不等于实际暴露，且伪重复会夸大统计功效。

### D-08：E4 使用共同主效用与主安全指标

主效用为 C2−C0 paired `score_simple` 的单侧 CI 与 +0.05 最低实用点估计；主安全为灾难率差上界不超过 +5pp 且绝对率不超过 10%。FunctionalSuccess 非劣及 C2−C1 为次级检验。原因是平均收益不能掩盖尾部灾难，`p>0.05` 也不能证明安全或非劣。

### D-09：任务级 gate 位于轨迹/agent 层，并在 E4 前冻结

E5a 使用 D1–D6 开发、D7 验证并冻结 detector；E5b 随 E4 做前瞻 shadow。不得把任务级 detector 塞进只看单请求的 gateway `quality.py`。原因是跨回合无进展、工具失败和交付缺失不是 request-level 信号，E4 后再训练会丢失前瞻性。

### D-10：三教师与 plan-to-file 不进入主线默认路径

issue-020 仅在 E2 表明教师生成是主要问题且质量闸冻结后执行；issue-021 保持独立实验。原因是教师语言质量不能替代学生效用证据，脚手架也会引入新的因果变量。

### D-11：采样控制采用支持矩阵

显式固定链路支持的 `temperature=0` 和 `max_tokens`；不可观测或不支持的 `seed/top_p` 标记为 unsupported，并保证各臂使用相同 provider 默认值。原因是伪造“已控制”的字段比诚实记录限制更危险。

### D-12：本轮不授权实施或真实跑批

本轮只完成实验重设计、五轮对抗审查和文档索引更新；没有改代码、没有启动 campaign/pilot/eval。下一授权点为 P0 + E0 实施包，且任何真实运行仍须通过七类 preflight。

## 被取代的方案

`plans/2026-08-27-post-d-phase-next-steps-plan.md` 的 A/B/C 路线和“先三教师、再 v2”的串行建议被本决策取代。其 D 阶段事实摘要保留为历史背景，不再作为执行入口。
