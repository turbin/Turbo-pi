# N2：Docker 镜像首次构建验证 — 变更记录与决策

日期：2026-07-23
任务书：`doc/design/2026-07-23-agent-server-post-c-tasks.md` N2 节
进度：`doc/design/progress/2026-07-23-post-c-operations.md`

---

## 构建环境

- colima：macOS Virtualization.Framework, aarch64, runtime docker, 4 CPU / 8GB / 40GB disk
- Docker Client 29.4.1 / Server 29.2.1
- 网络：Docker Hub（registry-1.docker.io）和 nodejs.org 从 colima VM 不可达（GFW）；GitHub、npm registry（registry.npmjs.org 从 host 可达但 VM 内不稳定）、npmmirror.com 可达
- 既有容器：portainer（9443）、baa-agent（5001）——与本任务无关，未触碰

## 构建结果

- 镜像：`agent-server:local`，145MB content / 756MB disk
- Node 版本：25.9.0（基础镜像 `node:25.9.0-bookworm-slim`）
- better-sqlite3：从源码编译（无 Node 25.9.0 linux-arm64 prebuild），使用 npmmirror Node headers 镜像
- 构建命令（含镜像参数）：
  ```
  docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
    --build-arg NODE_DISTURL=https://cdn.npmmirror.com/binaries/node \
    -f packages/agent-server/Dockerfile -t agent-server:local .
  ```

## Dockerfile 修改（3 处，均在工程内）

### 修改 1：移除 `npm run build`

**改前**：`RUN npm run build && npm rebuild better-sqlite3 && npm prune --omit=dev`
**改后**：`RUN npm prune --omit=dev`

**原因**：`npm run build` 构建全部 workspace 包（含 packages/ai），而 packages/ai 存在两个 TS 编译错误（nvidia.ts 缺生成文件、opencode-go.ts 类型不匹配），导致构建失败。agent-server 通过 Node 25 erasable TypeScript 直接运行 .ts 文件，所有 `@earendil-works/pi-ai` 导入均为 `import type`（运行时擦除），无需构建 TS 包。

### 修改 2：`npm ci --ignore-scripts` → `npm ci` + 移除 `npm rebuild`

**改前**：`RUN npm ci --ignore-scripts` + 后续 `npm rebuild better-sqlite3`
**改后**：`RUN npm ci`（无 --ignore-scripts），无 npm rebuild

**原因**：`--ignore-scripts` 跳过 better-sqlite3 的 prebuild-install 下载，后续 `npm rebuild` 需从 nodejs.org 下载 Node headers（不可达）。移除 `--ignore-scripts` 让 npm ci 期间直接处理原生模块。Node 25.9.0 linux-arm64 无 prebuild，实际仍走 node-gyp 源码编译，但 headers 通过 NODE_DISTURL 镜像获取。

### 修改 3：新增 NPM_REGISTRY / NODE_DISTURL 构建参数 + HOST 环境变量

- `ARG NPM_REGISTRY`：可选 npm 注册表镜像（如 `https://registry.npmmirror.com`）
- `ARG NODE_DISTURL`：可选 Node.js headers 镜像（如 `https://cdn.npmmirror.com/binaries/node`），传给 `npm_config_disturl`
- `ENV HOST=0.0.0.0`：容器内需监听所有接口才能接受 Docker 端口映射

两个 ARG 均可选，不传时行为与原来一致（使用默认 npm registry 和 nodejs.org）。

## server.ts 修改（1 处）

`startServer()` 的 listen host 从硬编码 `"127.0.0.1"` 改为 `process.env.HOST ?? "127.0.0.1"`。Dockerfile 设 `HOST=0.0.0.0`；本地开发不受影响（默认仍为 127.0.0.1）。

## 冒烟测试

### 单容器

- `docker run -d -p 8788:8788 agent-server:local`
- 日志：`agent-server listening on 0.0.0.0:8788`
- `GET /api/evolution/status` → `{"status":"never_run"}`（正常：新库无 checkpoint）

### docker compose 双服务

- `docker compose -f packages/agent-server/docker-compose.yml up -d`
- 主服务：`agent-server listening on 0.0.0.0:8788`
- 进化 sidecar：`[loop] interval=24h, starting first run` → `evolution checkpoint: ckpt-e8759dab0837063c` → `[loop] sleeping 24h`
- `GET /api/evolution/status` → `{"status":"found","id":"ckpt-e8759dab0837063c","metric":0,...}`
  - metric=0 符合预期：容器内无 gateway/omlx，LLM 管线不产 cards，但 ETL + checkpoint 正常工作
- 3 个 session 已挂卷入 `/data/sessions/`（从 `var/sessions/` 复制）
- `docker compose down` 清理完成

## 镜像保留

镜像 `agent-server:local` 保留在本机（145MB），方便后续使用。

## 测试

- 包级 vitest：21 文件 / 225 测试全绿（server.ts HOST 修改不影响既有测试）
- `npm run check` 干净
