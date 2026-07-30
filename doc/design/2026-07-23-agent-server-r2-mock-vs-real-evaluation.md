# R2：Mock vs 真实 teacher 对照评估与切换建议

日期：2026-07-23
任务书：`doc/design/2026-07-23-agent-server-r-real-teacher-tasks.md` R2
数据基础：R1 真实 run（checkpoint `ckpt-82fbef5131817d6c`，`doc/design/2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md`）vs Mock 基线（`doc/design/2026-07-23-agent-server-c3-observation-baseline.md` follow-up 刷新版）
性质：评估文档，零代码改动；切换安装为用户动作

---

## 1. 对照评估

### 1.1 库存（基线 §1 SQL 口径）

| 维度 | Mock 基线 | R1 真实 run 后 | 变化 |
|---|---|---|---|
| ABILITY Method | 2（1 手动 + 1 Mock 自然） | **6**（+4 真实自然） | +4 |
| ABILITY Guard | 1（手动） | 1 | 不变 |
| EVIDENCE | 25（22 ETL + 3 Workflow card） | 25 | 不变 |
| SKILL | 1 | 1 | 不变 |
| active 合计 | 29 | **33** | +4 |
| dormant | 0 | 0 | 不变 |

### 1.2 role 分布（核心结论）

同一批 5 个 session：

| 路径 | Method | Guard | Workflow | 结论 |
|---|---|---|---|---|
| Mock（两次 run 合计） | 1（关键词门控触发） | 0 | 3 | 结构性偏 Workflow，只有轨迹含门控关键词才分流 |
| 真实 teacher（R1 单次） | **4** | 0 | 0 | 每类 session 都产出 Method（概念解释×2、代码评审框架×1、retry 策略×1），无门控偏倚 |

基线 §8.1 的"role 分布结构性偏 Workflow"判断在真实 teacher 下**不成立**——偏倚是 MockLLM 关键词门控的产物，不是管线或数据的产物。

### 1.3 quality 分布（基线 §3 SQL 口径）

| 桶 | ABILITY Mock 基线 | ABILITY R1 后 | EVIDENCE Mock 基线 | EVIDENCE R1 后 |
|---|---|---|---|---|
| 0.5-0.6 | 0 | 0 | 22 | 22 |
| 0.6-0.8 | 1（0.6528，Mock 档） | **5**（0.6528 + 0.7241 + 0.7311×3） | 3 | 3 |
| 0.8-1.0 | 2（手动 0.85/0.9） | 2 | 0 | 0 |

- ABILITY 分布已脱离 Mock 固定档：真实得分 0.7241/0.7311，不再出现 0.552438 式关键词档位。
- **区分度有限**：4 张真实 card 聚集 0.724-0.731（极差 0.007）。verifier 文本回退通路给出的是粗粒度字母分映射，区分能力弱于 logprobs 期望化打分。暂评估为"方向正确、粒度粗"，列入观察项，不立项。
- EVIDENCE 分布不变：rescore 本轮未触发（dormant=0），ETL 条目仍是 Mock 时代得分。真实 teacher 下的 EVIDENCE 重评分尚未有数据。

### 1.4 截断状态（基线 §5 口径）

- Method 库存 2 → **6**，**已命中 runbook §3 触发条件"Method/Guard 库存合计 ≥6"**。
- 注入端 top-5 by quality 实际截断顺序：0.9（手动）→ 0.7311×3 → 0.7241，**被截的是 0.6528（Mock 时代 retry Method）**。
- 评估：被截条目与 0.7241 的 `Idempotent API Retry Strategy` 同源（同一 retry session 的 Mock/真实两个版本），截掉低分旧版**不可惜**，上限 5 暂不需调整。该触发项的正式评审建议在 R3 一并记录。

### 1.5 并存行（基线 §4 SQL 口径）

- 结果 **0 → 3**（taskId 来自量子问答×2 + 代码评审 session）。
- **语义分析：proxy 命中但非重复**。这 3 个 taskId 是 Mock 时代 Workflow EVIDENCE card 与真实时代 Method ABILITY card **同轨迹不同 role**——不是 C 已知限制的"同一 card 跨 type 重复晋升"（C1 前后 hash 变化），而是同一轨迹在两个 teacher 下各产一张不同 role 的 card。基线 §4 已指出该 SQL 只是 proxy。
- 评估：不构成冗余清理对象（Workflow 进证据池、Method 进能力注入，内容不同）。runbook 触发条件"并存行 >0 → 评审清理立项"形式上命中，建议评审结论为**不立项清理**，但需在 runbook 动作表中补充该 proxy 的判读规则（见 §3 建议）。正式评审记录留 R3。

### 1.6 checkpoint 趋势（基线 §6 口径）

| checkpoint | 时间 | metric | 口径说明 |
|---|---|---|---|
| ckpt-77c2725336cb4469 | 07-23 06:57 | 21 | Mock 首轮（ETL 17 + rescore 晋升集中发生） |
| ckpt-847e1d89f7e98401 | 07-23 07:45 | 6 | Mock follow-up（新 session 1 个） |
| ckpt-82fbef5131817d6c | 07-23 14:17 | 4 | 真实 teacher（无新 session，纯重派生晋升） |

metric 下降是**无新 session 输入**的自然结果（metric=晋升条目数），非管线退化。判读规则：metric 应结合 etlInserted 看——`etlInserted=0 且 metric>0` 表示重派生仍有新产出（健康）；`etlInserted>0 且 metric=0` 才是异常。

---

## 2. 切换建议（日常进化切到真实 teacher）

**结论：建议切换。** 真实 teacher 全链路 2m31s 可完成，产出质量明确优于 Mock，成本可接受（§2.2）。

### 2.1 plist 修改指令（用户动作，agent 不执行）

在 `~/Library/LaunchAgents/com.agent-server.evolution.plist`（N3 安装后存在）的 `<dict>` 中添加：

```xml
<key>EnvironmentVariables</key>
<dict>
	<key>LLM_BASE_URL</key>
	<string>http://127.0.0.1:8000/v1</string>
	<key>LLM_MODEL</key>
	<string>gemma-4-12B-it-4bit</string>
	<key>TEACHER_MODEL</key>
	<string>gemma-4-12B-it-4bit</string>
	<key>LLM_API_KEY</key>
	<string>&lt;omlx api_key，取自 packages/agent-gateway/config.toml 的 omlx provider 节&gt;</string>
	<key>AGENT_SERVER_BENCHMARK</key>
	<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/benchmark/benchmark.example.json</string>
</dict>
```

同时按 N3 决策记录方案 A，把 `ProgramArguments` 中的 `npx tsx` 改为 `scripts/with-node25.sh` 包装（LaunchAgent 环境 PATH 受限）。修改后：

```bash
launchctl unload ~/Library/LaunchAgents/com.agent-server.evolution.plist
launchctl load ~/Library/LaunchAgents/com.agent-server.evolution.plist
# 自查：次日或手动触发后
cd packages/agent-server && ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts --status
```

注意：N3 的安装动作（install）本身尚未执行，以上指令以"N3 已安装"为前提；若未安装，可先手动按 R1 命令行方式运行（env 直接前置）。

### 2.2 成本估算

- 本轮实测：5 sessions → 全程 **2m31s**（pipeline 阶段约 2 min，其余秒级）；LLM 调用集中在 verification 派生 + skill_evolution。
- **增长趋势**：verification 管线每轮对**全部** session 重派生 cards（contentHash 只在晋升层去重，派生本身不跳过）。按本轮 ~30s/session 估算：50 sessions ≈ 25 min/run，500 sessions ≈ 4 h/run——**超过日频可接受窗口前需立项"增量派生"**（只处理新 session）。当前 5 sessions 无问题，列入观察项。
- rescore 成本（未实测）：P3-1 数据为 12 calls/候选 ×~10s ≈ 2 min/候选；dormant 积压 200 上限时不可行——**dormant 积压出现时必须先治理 rescore**（R1 决策 1 已记录触发条件）。
- token 成本：omlx 本地推理，零 API 费用；成本即机器占用。

---

## 3. 建议汇总（提交用户/R3）

| # | 建议 | 类型 | 处置 |
|---|---|---|---|
| 1 | 日常进化切换真实 teacher（§2.1 指令） | 用户动作 | 待用户执行 |
| 2 | Method 库存 6 触发截断评审：被截条目不可惜，上限 5 维持 | 触发评审 | R3 记录正式结论 |
| 3 | 并存行 proxy 0→3：语义非重复，不立项清理；runbook 动作表补判读规则（同 taskId 不同 role ≠ 重复晋升） | 触发评审 | R3 记录正式结论 + runbook 修订 |
| 4 | 增量派生（只处理新 session）在 session 数 ~50 前立项 | 观察项 | 写入基线迭代建议 |
| 5 | 真实 teacher 下 EVIDENCE rescore 无数据（dormant=0）；verifier 文本回退区分度粗 | 观察项 | 写入基线迭代建议 |

## 4. 基线刷新

`doc/design/2026-07-23-agent-server-c3-observation-baseline.md` 已按本报告数据刷新为"真实 teacher 版"（Mock 数字保留为历史对照，变化处以「原值 → 新值」标注）。

Refer Spec：`doc/design/2026-07-23-agent-server-r-real-teacher-tasks.md`（R2）；`doc/design/2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md`（R1 数据）；`doc/design/2026-07-23-agent-server-c3-observation-baseline.md`（Mock 基线）；`doc/design/2026-07-23-agent-server-observation-runbook.md`（触发条件）；`doc/design/2026-07-23-agent-server-n3-go-live-changes-and-decisions.md`（plist 结构）
