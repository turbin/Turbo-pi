# Agent-Server：观察周报自动化（weekly-report sidecar）——变更与决策记录

日期：2026-07-24
来源：用户指示"观察周报由 agent 自动跑，设置成定时任务"。
通用约束：见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"。

---

## 1. 关键决策

| # | 决策点 | 决定 | 理由 |
|---|---|---|---|
| 1 | 执行主体 | **容器化周报 sidecar**（`weekly-report.ts --loop`，168h 间隔），非 launchd/cron | AI agent 无法定时自启；launchd 已被 TCC 外置卷阻塞否决（07-24 N3 决策）；compose sidecar 与 evolution 同模式、共享 /data 卷、零新基础设施 |
| 2 | 报告性质 | **机械汇总 + 触发判定，不含解读** | runbook 的 SQL 集与触发条件都是确定性的，可自动化；解读与处置留在评审时（用户拿报告叫 agent 解读），避免脚本臆造判断 |
| 3 | 输出位置 | `/data/reports/weekly-<date>.md`（docker 卷）+ stdout（compose logs） | 卷与 DB 同生命周期；`/Volumes` 外置卷 bind mount 需 colima 额外配置，不做 |
| 4 | 触发阈值参数化 | 硬编码常量（截断库存 6、dormant 积压 100、C-重窗口 28 天） | 与 runbook/R3 结论一致；变化时改代码+记录，不加配置面 |

## 2. 实现

- `src/offline/weekly-report.ts`：`generateWeeklyReport(db, now)` 纯只读生成 markdown（库存/quality 分布/并存行/截断观察/checkpoint 历史/触发评审判定 6 节）；CLI 一次性或 `--loop`（`AGENT_SERVER_REPORT_INTERVAL_HOURS`，默认 168）。
- 触发判定规则（对应 runbook §3 动作表 + R3 正式结论）：
  1. Method+Guard 库存 ≥6 → 截断评审；
  2. 并存行 >0 → 并存行评审（提示按 R3 判读规则区分"同轨迹不同 role"与"重复晋升"）；
  3. 近 28 天无新 ABILITY 且有 checkpoint → C-重评审；
  4. dormant >100 → rescore 治理；
  5. active ABILITY distinct quality ≤2 → quality 聚集提示（R3 观察项 2）。
- `docker-compose.yml`：新增 `agent-server-weekly-report` 服务（共享 /data 卷，`restart: unless-stopped`）。
- 不接入 run-evolution：周报只读，与进化写路径解耦，失败不影响进化。

## 3. TDD 与验证

- `test/offline/weekly-report.test.ts` 7 条用例（库存/分桶/checkpoint 渲染；截断触发与未触发边界（6 vs 5）；并存行触发；C-重触发（28 天无新 ABILITY 且有 checkpoint）；rescore 治理触发（dormant 101）；空库不崩溃且无误报）——先红后绿；包级 vitest 22 文件 / **236 测试**全绿。
- 容器实测（2026-07-24）：`/data/reports/weekly-2026-07-24.md` 生成成功，内容与实际库一致（Method 7 active、截断评审触发、quality 聚集提示符合 R3 观察项）；sidecar 进入 168h 休眠。

## 4. 使用方式

```bash
# 看最新周报（主机侧）
cd packages/agent-server
docker compose logs agent-server-weekly-report | tail -50
# 或直接读卷内文件
docker compose exec -T agent-server-weekly-report cat /data/reports/weekly-$(date +%F).md
# 调整频率（小时）
AGENT_SERVER_REPORT_INTERVAL_HOURS=24 docker compose up -d
```

每周拿到报告后，把内容发给 agent 解读（对照 runbook §3 动作表与 C 决策观察项）。

## 5. 已知限制

- colima/ docker 重启依赖：宿主机重启后需 colima 运行（`restart: unless-stopped` 只覆盖容器层）；colima 未自启时周报与进化都暂停，恢复后按 interval 续跑。
- 报告时间以容器 UTC 为准。
- 宿主机 `var/experience.db`（launchd/手工路径）与容器 `/data/experience.db` 是**两个库**；周报 sidecar 只覆盖容器库（当前生产路径）。

Refer Spec：` design/2026-07-23-agent-server-observation-runbook.md`；` design/2026-07-23-agent-server-r3-c-heavy-review.md`（触发评审正式结论）；` design/2026-07-24-agent-server-n2-closeout-deepseek-teacher-changes-and-decisions.md`
