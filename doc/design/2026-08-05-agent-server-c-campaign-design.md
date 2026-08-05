# 2026-08-05 C 阶段办公自动化 campaign 设计（判据预注册）

状态：**已立项（用户 08-05 批准并行搭建）**。启动时机：B 阶段 27B 热库轮出数后正式开跑。

## 1. 目标与判据（预注册，不可后改）

用户最终目标的可检验化：学生模型（Qwen3.5-27B-Distilled）在办公自动化域经教师少量指导后逐步独立。

| # | 判据 | 口径 |
|---|---|---|
| ① | **重复任务升级率 D7 ≤ 5%** | 重复集第 7 天，实验臂，升级=gateway 门控升级到云端（model_runs 标注） |
| ② | **新任务升级率全程 < 20%** | 新任务集全部天数，实验臂 |
| ③ | 升级率逐日下降趋势 + 成本/错误分布同报 | 报告呈现，不做硬断言（沿用 E 总任务书判据③精神） |

对照：重复集在 D1/D7 各跑一次 **control 臂（8789 + injection off，同路径对照，08-05 开关落地后的首次实战使用）**，其余天数仅实验臂。判据均在实验臂上核算。

## 2. 任务集（QwenClawBench v1.1，99 任务）

- 语料：`eval/qcb/tasks-v1.1/`（gitignored，MIT，github.com/SKYLENAGE-AI/QwenClawBench）；task_00005（飞书依赖）排除，沿用 E 立项决定。
- 划分（`eval/campaign_plan.py`，seed=42 分层抽样，确定性）：
  - **重复集 20**：每日全跑，测"可靠记忆"——判据①的对象
  - **新任务集 79**：按日轮转切片（D1..D7 各 11-12 个），每任务全程只出现一次，测泛化——判据②的对象

## 3. 每日循环

```
白天：实验臂 [重复集 20 + 当日新切片]（+ D1/D7 对照臂重复集）
      → 8789（injection on/off）→ 8787 gateway → omlx 27B（门控升级 DeepSeek）
      → 逐任务评分（vendored lib_grading：automated + judge=deepseek-v4-pro）
夜间：合成任务级轨迹 → runDailyEvolution（评估库）→ 次日热库
归档：每日 sessions 归档（防泄漏纪律不变）
```

## 4. 工程件（本日已交付的脚手架）

| 件 | 说明 |
|---|---|
| `eval/campaign_plan.py` | 语料解析 + 分层划分 + 每日批次（纯函数） |
| `eval/campaign_metrics.py` | 升级率/通过率/逐日汇总 + 判据①②核算（纯函数） |
| `eval/campaign.py` | runner：workspace 隔离（assets 复制）→ bash agent loop（30 轮上限，E1 同源形态）→ vendored 评分 → JSONL；`--dry-run` 打印批次；`--metrics` 核算 |
| `eval/tests/test_campaign.py` | 9 pytest（语料完整性/划分确定性/切片覆盖/判据边界），已全绿 |
| `eval/qcb/harness-ref/` | vendored QCB scripts（lib_tasks/lib_grading 复用，judge 配置走 .env） |

## 5. 已知待办（开跑前必须清）

1. **escalated 标注**：结果行的 `escalated` 目前是占位 false——需从 gateway model_runs 按请求窗口事后标注（R2 升级回流同款导出），开跑前实现并冒烟。
2. **judge 冒烟**：lib_grading 的 judge 走 OpenAI 兼容调用，需用 1 个任务验证 deepseek-v4-pro judge 链路（成本 <$1 报价纪律，P-D8）。
3. **agent 形态风险**：host 侧 bash agent ≠ OpenClaw 容器 harness（任务原假设 cron/workspace 路径），评分可能系统性偏低——属 harness 口径差异，报告中声明；先办公后浏览器（浏览器任务需额外环境，第二周）。
4. **与 B 热库的资源互斥**：omlx 单实例，campaign 白天批次必须等热库轮结束后开跑（顺序已排）。

## 6. 成功标准的解释纪律

判据①②是**绝对阈值**（用户拍板），不要求对照显著性检验；但报告必须同时给出 control 臂 D1 vs D7 差值作参照（无记忆时的自然波动范围），避免把噪声当学习。

Refer Spec：doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md（E 总任务书）；2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md（P-D4/D6/D8）；2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md（失败经验三层化）；2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md（同路径对照）
