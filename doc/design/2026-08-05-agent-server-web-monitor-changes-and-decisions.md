# 2026-08-05 agent-server Web 监控面板 — 决策记录

## 背景

用户要求 agent-server 增加 Web 监视能力：①轨迹缓存命中率 ②链路状态 ③日志访问 ④启动参数开关。现状：`/stats` 页 + hit-rate API 已有（O spec R2），日志只有 stdout，无链路端点、无开关。

## 决策

### 【立】决策 1：单页 dashboard，无框架静态 HTML

- `GET /dashboard`（`src/dashboard-page.ts`，沿用 stats-page 风格）：三面板——链路状态、命中率、日志 tail，5s 自刷。不引前端框架/构建步骤（与 stats-page 一致的最小复杂度原则）。
- `/stats` 保留不动，dashboard 给入口链接。

### 【立】决策 2：链路状态端点 `/api/status/chain`

- 返回 self（uptime/web/injection 开关态）、gateway（probe `GATEWAY_URL/v1/models` 带 AGENT_GATEWAY_KEY，含模型列表）、omlx（`OMLX_URL` env 默认 :8000）、evolution 最近 checkpoint。
- 探活口径：**任何 HTTP 响应即活**（omlx 401 = 活），仅网络层失败判 down；超时 3s。与 preflight.py 口径一致。

### 【立】决策 3：日志访问 = 文件 sink + tail 端点

- `logTrace` 增加文件 sink（`AGENT_SERVER_LOG_PATH`，默认 `./var/log/agent-server.log`），行首加 ISO 时间戳；stdout 保留（容器纪律）。
- `GET /api/logs?lines=N`（默认 200，上限 1000）读 tail；文件缺失返回空数组不报错。
- createServer 启动写 `phase=startup` 行（含 web/injection/log 配置），便于从日志确认生效配置。
- 不写第三方日志库（pino 等）：logTrace 单点扩展即可，依赖零增加。

### 【立】决策 4：web 开关默认 on

- `AGENT_SERVER_WEB=off`（或 `createServer({web:false})`）关闭 `/dashboard`、`/api/logs`、`/api/status/chain`（均 404）。
- **数据 API（`/api/stats/hit-rate`、`/api/evolution/status`）不 gate**：它们是既有机器接口（O spec），关闭会破坏向后兼容；敏感面是日志与拓扑，恰好都在 gate 内。
- 默认 on 的理由：`/stats` 页面此前已常开，默认 off 属于行为回退；本地信任边界（SECURITY.md）下生产可显式关。

## 验证

- TDD：新 `test/web-monitor.test.ts` 6 用例（chain 活/死、logs tail/缺文件/limit、dashboard 默认开、web=off 三端点 404 + 数据 API 仍通、文件 sink 落行）。
- vitest 25 文件 262 全绿（基线 256+6）；`npm run check` 干净。
- 实机：8789 重启后 chain 返回 gateway UP（3 模型）/omlx UP(401)/evolution ckpt-81bbf802；logs/dashboard 200；`AGENT_SERVER_WEB=off` 临时实例三端点 404、hit-rate 200。
- 事故记录：验证 web=off 时 `pkill -f "tsx src/start.ts"` 误杀 8789 主实例——preflight 自动拉起恢复；教训写入 AGENTS.md（杀实例用精确 PID）。

## 影响面

- 生产 8788：默认 web on（=/stats 现状），compose 可加 `AGENT_SERVER_WEB=off`。
- 冷库 v2 跑批不受影响（直连 8787）。

Refer Spec：2026-07-18-agent-server-experience-replay-spec.md（O spec R2/R3）；2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md（preflight 口径）
