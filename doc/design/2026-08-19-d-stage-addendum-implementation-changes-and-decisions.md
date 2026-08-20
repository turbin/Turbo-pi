# D 阶段增强设计落地（T1-T4）决策记录 + 主会话验收报告

日期：2026-08-19
状态：**已实施，主会话验收通过（eval 149 + vitest 346 + gateway 195 + check 链全过）**
依据：`doc/design/preview.html`（D 阶段设计主稿）；`plans/2026-08-19-d-stage-addendum-dev-tasks.md`（任务拆分与裁决登记）；用户 08-19 指令（pi agent 开发+测试、主会话验收）

## 执行模式

pi-dev-1（T1+T2+cross 修复）/ pi-dev-2（T3+T4）并行开发（TDD 红先绿后、不 commit）→ pi-test 独立复核（全量复跑 + 假绿审计 + 补 5 用例）→ 主会话里程碑门禁：diff 全读逐节对账 + 独立复跑三套件 + check 链补跑（ts-imports/shrinkwrap/install-lock/tsgo 全 0；pinned-deps 138 处全部 eval/results 工件，pre-existing 同口径）。pi-test 审计结论：无假绿、无打回级缺陷。

## 设计决策

**D-1（§12.2 臂序）**：task-block 下每任务臂序 = sha256(run_id+day+task_id+arm) 排序的确定性排列——同 run-id 重跑逐字节一致、跨任务排列不同；臂→client/injection/library 接线零改动。执行计划扁平化为 [(arm,task)] 序列，断点键 (day,arm,task_id) 天然兼容；非四臂日保持 experiment→control 原序。

**D-2（§8.1 终止三态）**：`termination_reason` 默认 "max_turns"（循环耗尽即触顶），自然完成改写 "completed"，timeout 分支改写 "timeout"——CapHit 严格取 `termination_reason=="max_turns"`；旧 run.jsonl 行无此字段，下游一律 `.get()` 容错（trajectory CapRate 对旧行 fallback requests>=30 并标注 caprate_fallback_n）。

**D-3（§7.2/Q8 held-out）**：8 个任务从新任务集确定性选取（HELD_OUT_SEED=20260819，与 split SEED 独立解耦）；**"D1 切片不可选"实现为显式剔除 `new[0::7]`**（D1 已起跑，其切片可能已进夜间 evolution，不满足"memory 中无 exact trajectory"）。daily_batch 任何 day 摘除 held-out；四臂日挂 x2/x3（D7 memory on/off transfer 比较），非四臂日完全不出现；落库 kind="held_out" 单列。

**D-4（§10 写入隔离）**：合成器 `--eligible-arms` 默认 experiment,x2（X1/X3/X4 只读）+ held-out 硬排除 + 空 eligible fail loud + 排除计数日志；交叉日 runbook 固化"先对账再进化"（§12.1 snapshot lock）。

**D-5（§3 三指标）**：addendum_metrics 只做报告不改判据；"明显失败"= score<0.3 ∨ grading_error ∨ (max_turns ∧ score<0.5) 预注册进 docstring；score 缺失按 0 保守处理（纳入漏升级审计）。

**D-6（§8.2 轨迹指标）**：六指标启发式定义全部预注册进 trajectory_metrics.py docstring（相邻重复 zip 位置对齐 / 错误标记子串 / 非相邻=间隔≥1 完整回合 / 新信息=toolResult 文本全新）；CLI 按日/按臂分组输出。

**D-7（§9 memory 字段）**：request_traces 增 retrieved_scores（与 retrieved_ids 按位对齐，重排后最终分）+ injected_tokens（ceil(chars/4) 启发式，与 injectedIds 同口径只估拼接块）；SCHEMA_VERSION 1→2 分步迁移（version<1 旧步 + version<2 新步，幂等，快照 readDb 不 ALTER）；双路径（/v1 流式 + /api/stream）phase-1/1.5 落库；COALESCE NULL-sentinel 合并语义与 injectedIds 同款（显式 0=注入关闭，NULL=未到阶段/旧行）。纯观测，检索/注入行为零改动。

**D-8（cross×held_out 污染修复，pi-test 发现+主会话裁决）**：cross_arm_diffs/sanity 只统计 kind=="repeat"（kind 缺失按 repeat 容错）；n_per_arm_per_day 改实际计数；TransferGain = held_out x2 均分 − x3 均分单独输出（§7.2）——修复前 sanity_diff −0.171 会误报"未建模混淆"（合成验证）。

## 验收证据（主会话独立复跑）

- eval pytest **149 passed 0 xfailed**（基线 97 → +52：T1/T2 18、T3 26、cross 修复 4、pi-test 补 4）
- agent-server vitest **346 passed**（+6：retrieval-observability e2e 等）
- gateway pytest **195 passed**（无回归）
- biome 871 文件干净（pi-dev 新测试文件 1 处格式 auto-fix）；tsgo/ts-imports/shrinkwrap/install-lock 全 0
- pi-test 复核报告：`doc/design/2026-08-19-d-stage-addendum-pi-test-review.md`

## T5 文档对齐（主会话）

1. `2026-08-19-9b-campaign-experiment-design.md` 标注被 preview.html 取代（判据①-⑤一致，Addendum 以 preview 为准；本稿保留 §3 成本定案出处）。
2. 前置清单增 **H 节四臂专项 6 项**（双实例/快照锁/臂序/held-out/写入隔离/环境隔离）。
3. 新增 `2026-08-19-d-stage-cross-day-runbook.md`：交叉日五步流程 + **Kimi audit 协议**（抽样键 sha256(run_id+day) 取 6、一致性双判据 |Δ|≤0.2 占比≥2/3 + 排序不翻转、audit 不回写不替代主 judge；用户 08-19 拍板 Kimi）。
4. INDEX 登记 preview.html / 任务书 / runbook / 本记录。

## 遗留风险

1. **D1 暂停进程（PID 88293）内存中是旧代码**：pilot 后重启 campaign 用同 run-id resume（3 任务已落库可跳），新代码全量生效；旧 3 行无 termination_reason/held_out 语境，按 D-2/D-5 容错口径处理。
2. **T4 字段对存量 request_traces 为 NULL/'[]'**（声明不回填）；空库初期检索无命中时 retrieved_scores=[]/injected_tokens=0 为正常口径。
3. **8789 需重启才加载 T4 代码**（当前进程是 15:00 旧代码）——pilot 前置动作。
4. Kimi audit 的 gateway `[cloud.kimi]` 段当前 enabled=false，执行 audit 时临时启用（不动生产链路）；Kimi 配额/模型名执行前确认。
5. trajectory 指标启发式的误报面（如"新信息=文本全新"对重复 ls 输出的宽容度）——Analysis Addendum 性质，不作硬判据。

Refer Spec：doc/design/preview.html；plans/2026-08-19-d-stage-addendum-dev-tasks.md；doc/design/2026-08-19-d-stage-pi-test-review.md；doc/design/2026-08-19-d-stage-cross-day-runbook.md
