# D 阶段增强设计（preview.html）落地：开发任务拆分

日期：2026-08-19
状态：**已批准方向（用户 08-19 指令：完全按新实验设计完成，pi agent 开发+测试，主会话验收）**
依据：`doc/design/preview.html`（D 阶段实验设计增强版，主稿）；主会话缺口反思（2026-08-19，P0×4 / P1×3 / P2×3）
执行约束：沿用 `2026-08-14-fix-batch-dev-tasks.md` §2 双人组协议与 §通用约束（TDD 红先绿后、不 commit、omlx 不可动、不读 .env、Node 25 走 with-node25.sh、单任务 ≤3000 行）。

## 裁决登记（用户 08-19）

- held-out transfer 任务数 = **8**（取自主会话建议；来源限定 D2+ 切片，D1 已跑 12 个新任务不可作 held-out）
- 独立 judge audit = **Kimi（moonshot）**（用户 08-19 拍板；跨族独立性满足 preview §13——主 judge 为 deepseek-v4-pro，audit 不得用 DeepSeek 系；只比对方向不替代主 judge；抽样=重复集 D2/D7 各 5-8 任务，一致性判定标准执行前预注册入 runbook；工程路径=临时启用 gateway `[cloud.kimi]` 段，不动生产链路）
- preview.html 为 D 阶段设计主稿；2026-08-19-9b-campaign-experiment-design.md 标注"被增强版取代"

## 任务拆分

| 任务 | 内容 | 涉及文件（主） | 预估行 | 依赖 |
|---|---|---|---|---|
| **T1** | 四臂 task-block 随机臂序（preview §12.2：禁止臂块顺序；seed 确定性）+ `termination_reason` 落库（§8.1：completed/max_turns/timeout 三态，不得以 requests==30 替代） | eval/campaign.py；eval/tests/ | ~250 | 无 |
| **T2** | held-out 冻结（§7.2/Q8）：campaign_plan.py 确定性选 8 个 D2+ 切片任务 → 从轮转摘除；synthesize_campaign_sessions.py 排除 held-out + `--eligible-arms` 过滤（默认 experiment,x2，§10 写入隔离）；campaign.py 四臂日 held_out 挂 x2/x3 两臂（§7.2 D7 memory on/off） | eval/campaign_plan.py、synthesize_campaign_sessions.py、campaign.py、测试 | ~350 | T1 |
| **T3** | 假独立三指标（§3：AutonomousSuccess/MissedEscalation/EscalatedSuccess；"明显失败"预注册组合阈值入 docstring）+ trajectory 指标族离线分析器（§8.2/17.3：RepeatTool/Retry/StateRevisit/ProductiveRound，启发式定义预注册入 docstring） | eval/campaign_metrics.py、eval/trajectory_metrics.py（新）、测试 | ~400 | 无 |
| **T4** | Memory 可观测最小集（§9）：request_traces 增 retrieved_scores（JSON，对齐 retrieved_ids）+ injected_tokens 列（ALTER+user_version 迁移，沿用 T3 confidence 迁移模式）；retrieval.ts 落 top-k 分数、injection.ts 落 token 估计 | agent-server src/{experience-store,retrieval,injection,server}.ts、test/regressions/ | ~300 | 无 |
| **T5** | 文档对齐（主会话自做）：md 稿标注取代、前置清单补四臂专项 6 项、D2/D7 交叉日 runbook（快照锁→四臂→对账→eligible-only 进化）、人工 judge audit 流程、决策记录 | doc/ | — | T1-T4 |

合计 ~1300 行（4 任务）。

## 执行分组

- **pi-dev-1**：T1 → T2（同改 campaign.py，串行）
- **pi-dev-2**：T3 → T4（T3 eval Python / T4 agent-server TS）
- **pi-test**：两路完成后独立复核（全量 eval pytest + agent-server vitest + 审计假绿）
- **主会话**：里程碑门禁验收（diff 全读、AGENTS.md 合规、测试独立复跑、与 preview.html 逐节对账）→ 全局对齐检查 → pilot → 汇报用户

## 验收口径（主会话对账清单）

1. preview.html §7.2/§8.1/§9/§10/§12.2/§3/§17.3 逐节有落地证据（代码+测试）
2. eval pytest 全绿 + agent-server vitest 全绿（with-node25）+ gateway pytest 不回归
3. `--dry-run --day 2 --arms x1,x2,x3,x4` 臂序为 task-block 随机且确定性；`--dry-run --day 7` 含 held_out 挂 x2/x3
4. D1 resume 兼容（run.jsonl 旧行无 termination_reason 不炸）
5. 决策记录随 commit（COMPLETED/TODO/Refer Spec 格式）

Refer Spec：doc/design/preview.html；doc/design/2026-08-19-run-batch-preflight-checklist.md；plans/2026-08-14-fix-batch-dev-tasks.md（双人组协议）
