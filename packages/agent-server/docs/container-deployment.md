# agent-server 容器化部署

agent-server 以单镜像方式容器化：Fastify 服务 + 内置离线进化循环（loop 模式）。模型网关（agent-gateway → omlx）**不进入容器**，仍在宿主机运行，容器通过 `host.docker.internal` 访问；omlx 的任何配置不受容器部署影响。

## 构建

构建上下文必须是**仓库根**（agent-server 通过 npm workspace 符号链接解析 `@earendil-works/pi-ai` 等包）：

```bash
docker build -f packages/agent-server/Dockerfile -t agent-server:local .
```

镜像要点：

- 基础镜像 `node:25.9.0-bookworm-slim`，Node 固定 25.9.0 —— 与 `scripts/with-node25.sh` 同源：better-sqlite3 11.10.0 无 Node 26 预编译产物且源码不兼容其 V8 API。升级 better-sqlite3 前不要换基础镜像 tag。
- 构建阶段执行 `npm ci --ignore-scripts` → `npm run build`（`pi-ai` 运行时解析到 `dist/`，必须构建）→ `npm rebuild better-sqlite3` → `npm prune --omit=dev`。
- 运行时仅 node + python3（离线管线 spawn 的 vendored Python 包为纯标准库，无需 pip/uv）。
- Node 25 原生擦除 erasable TypeScript，`src/` 直接运行，无需 tsx。

## 运行

```bash
docker run -d --name agent-server \
  -p 8788:8788 \
  -e GATEWAY_URL=http://host.docker.internal:8787 \
  -e AGENT_GATEWAY_KEY=<channel key> \
  --add-host host.docker.internal:host-gateway \
  -v agent-server-data:/data \
  agent-server:local
```

`--add-host host.docker.internal:host-gateway` 在 Linux 上必需；Docker Desktop（macOS/Windows）自带该解析。

离线进化循环（容器内无 cron 守护进程，使用内置 loop 模式，不能用 `schedule.ts` 的 crontab 安装模式）：

```bash
docker run -d --name agent-server-evolution \
  --add-host host.docker.internal:host-gateway \
  -e GATEWAY_URL=http://host.docker.internal:8787 \
  -e AGENT_SERVER_EVOLUTION_INTERVAL_HOURS=24 \
  -v agent-server-data:/data \
  agent-server:local \
  node packages/agent-server/src/offline/run-evolution.ts --loop
```

或直接使用 compose（已含上述两个服务）：

```bash
docker compose -f packages/agent-server/docker-compose.yml up -d --build
```

## 环境变量

| 变量 | 默认（镜像内） | 说明 |
|---|---|---|
| `PORT` | `8788` | 服务监听端口 |
| `EXPERIENCE_STORE_PATH` | `/data/experience.db` | experience SQLite 库路径 |
| `AGENT_SERVER_SESSION_DIR` | `/data/sessions` | 会话 JSONL 落盘目录 |
| `GATEWAY_URL` | `http://host.docker.internal:8787` | 模型网关地址（宿主机的 agent-gateway） |
| `AGENT_GATEWAY_KEY` | 空 | 网关 channel key |
| `AGENT_SERVER_EVOLUTION_INTERVAL_HOURS` | `24` | 进化 loop 间隔（仅 evolution 服务使用） |
| `AGENT_SERVER_PYTHON` | `python3` | 离线管线 Python 解释器 |
| `AGENT_SERVER_PYTHON_DIR` | `/app/packages/agent-server/python` | vendored Python 包目录（PYTHONPATH） |
| `AGENT_SERVER_DORMANT_TTL_DAYS` | （代码默认） | dormant 条目 TTL |
| `AGENT_SERVER_BENCHMARK` | 空 | benchmark 文件路径；设置后进化流程派生 checkpoint |

## 数据持久化

`/data` 卷保存 experience 库与会话 JSONL，两个服务共享同一卷。备份即备份该卷；删除卷即清空全部经验数据。

## 调度模式说明（重要）

宿主机部署用 `schedule.ts` 安装 crontab/launchd；**容器内不可用**（无 cron 守护进程）。容器部署一律使用 `--loop` 内置循环（`AGENT_SERVER_EVOLUTION_INTERVAL_HOURS` 控制间隔）。如需外部调度，也可不跑 evolution 服务，改为从宿主机定时 `docker exec agent-server node packages/agent-server/src/offline/run-evolution.ts` 触发单次运行。

## 部署后验证

```bash
curl -s http://127.0.0.1:8788/v1/models            # 服务存活（经网关转发需 AGENT_GATEWAY_KEY 正确）
docker exec agent-server node packages/agent-server/src/offline/run-evolution.ts --status   # 进化 checkpoint 状态
sqlite3 /var/lib/docker/volumes/<volume>/_data/experience.db "SELECT type, status, COUNT(*) FROM experiences GROUP BY 1,2;"
```
