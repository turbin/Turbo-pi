# B3：离线调度定时化（方案 A+）—— 决策记录

日期：2026-07-22
关联任务书：` design/2026-07-22-agent-server-a2-b3-tasks.md`

## 新增文件

| 文件 | 用途 |
|---|---|
| `src/offline/run-evolution.ts` | CLI 入口（默认/--status/--loop 三模式 + 失败 checkpoint） |
| `src/offline/schedule.ts` | 安装助手（install/uninstall/doctor，macOS LaunchAgent + Linux crontab，全部幂等 + dry-run） |
| `test/offline/run-evolution.test.ts` | run-evolution CLI 单元测试（6 test cases） |
| `test/offline/schedule.test.ts` | schedule.ts 测试（10 test cases） |
| `docs/offline-evolution-scheduling.md` | 部署文档 |

## 改动文件

| 文件 | 改动 |
|---|---|
| `src/server.ts` | 新增 `GET /api/evolution/status` 端点 |
| `test/server.test.ts` | 新增 3 个 evolution status 端点测试 |

## 测试覆盖

| 测试模块 | case 数 | 覆盖内容 |
|---|---|---|
| `run-evolution.test.ts` | 6 | --status never_run/found/多 checkpoint 取最新；cmdRun 成功/失败 checkpoint + rethrow |
| `schedule.test.ts` | 10 | macOS install/uninstall/幂等/dry-run/全生命周期；Linux dry-run；unsupported platform doctor |
| `server.test.ts`（新增） | 3 | 404 never_run / 200 found / 多 kind 隔离 |
| **B3 合计** | **19** | |

## 设计决策

1. **失败 checkpoint 的 snapshot 契约**：失败时写入 `kind:"evolution", metric:0, snapshot:{"error":"..."}`。这使得 `/api/evolution/status` 可区分三态：
   - 从未运行：`404 {status:"never_run"}`
   - 最近一次成功：`200 {status:"found", metric:>0}`
   - 最近一次失败：`200 {status:"found", metric:0, snapshot.error:"..."}`

2. **404 vs never_run**：端点返回 HTTP 404 而非 200 `{status:"never_run"}`。理由：监控探针可区分"无数据"(404) 与"有数据但失败了"(200 metric=0)。`--status` CLI 输出文本提示"never run"。

3. **--loop 的间隔语义**：`AGENT_SERVER_EVOLUTION_INTERVAL_HOURS` 是跑完上一次到开始下一次的间隔（不是固定 cron 式间隔）。若前一次运行超过间隔时间，下一次立即开始。

4. **红线遵守**：`install`/`uninstall` 在临时 HOME 目录测试；schedule.ts CLI 入口允许调用但 agent 执行时仅用 `--dry-run`。测试不会写入系统 crontab/LaunchAgent。

5. **幂等性**：macOS `install` 检查 plist 是否已存在；Linux `install` 检查 crontab 是否已有 `run-evolution` 行。二次 install 均无副作用。

6. **未推翻 P1 决策**：触发器外部化——server 不在启动时运行 evolution；CLI 仅作为独立入口供 cron/launchd/k8s/docker 调用。
