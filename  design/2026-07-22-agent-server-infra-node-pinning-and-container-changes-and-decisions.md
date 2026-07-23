# 基础设施变更决策记录：Node 版本固定 + 容器化部署配置

日期：2026-07-22
触发：用户在 C1/C2 验收后提出四点要求（Node 虚拟环境固定、容器化配置、tm/temp 过程文件不入 git、提交变更）。

## 背景问题

C1/C2 执行期间发现：本机 Homebrew Node 已升级到 v26.5.0，而 better-sqlite3 11.10.0 无 Node 26 预编译产物，源码亦不兼容 Node 26 的 V8 API（`GetPrototype` 被移除）。`node_modules` 中的 binding 只兼容 Node 25（ABI 141），系统默认 node 下 agent-server 测试直接报 binding 错误。

## 决策

| # | 决策点 | 决定 | 理由 |
|---|---|---|---|
| 1 | Node 固定方案 | **仓库内本地工具链**（`.tools/node-v25.9.0-darwin-arm64/`，gitignore）+ 包装脚本 `scripts/with-node25.sh`（前置 PATH 后 exec），不装 nvm/fnm 等全局版本管理器 | 自包含在工程内，符合"改动仅限工程内"约束；不依赖用户全局环境状态（nvm 曾存在后被卸载，证明全局方案脆弱）；脚本缺失时打印一行安装命令，新机器可自愈 |
| 2 | binding 重建时机 | fresh `npm install` 后须 `scripts/with-node25.sh npm rebuild better-sqlite3`（已写入 AGENTS.md） | binding ABI 与 Node major 绑定；在错误的 Node 下 rebuild 会先删旧 binding 再失败（执行 agent 实测踩坑），必须统一入口 |
| 3 | 容器 Node 版本 | Dockerfile 基础镜像固定 `node:25.9.0-bookworm-slim`，与本地工具链同源 | 保持 binding ABI 一致；升级 better-sqlite3（v12+ 支持 Node 26）前不得换 tag，已在 Dockerfile 注释和文档中标注 |
| 4 | 容器编排范围 | **只有 agent-server 进容器**；agent-gateway 与 omlx 留在宿主机，容器经 `host.docker.internal` 访问（Linux 需 `extra_hosts: host-gateway`） | omlx 不可动是硬约束；gateway 已稳定运行，容器化它无收益且引入 omlx 网络拓扑风险 |
| 5 | 容器内调度 | 不用 crontab（slim 镜像无 cron 守护进程），用 `run-evolution.ts --loop` 内置循环，compose 中以独立服务 `agent-server-evolution` 跑，与主服务共享 `/data` 卷 | B3 已预留 loop 模式（`AGENT_SERVER_EVOLUTION_INTERVAL_HOURS`，默认 24h），零新代码；独立服务使进化失败不拖累主服务重启策略 |
| 6 | 数据持久化 | 单卷 `/data`：experience.db + sessions JSONL，环境变量 `EXPERIENCE_STORE_PATH`/`AGENT_SERVER_SESSION_DIR` 指向卷内 | 两服务必须看到同一份库；卷即备份单元 |
| 7 | Python 运行时 | 镜像内仅装 apt 的 python3（bookworm 3.11），不装 pip/uv/任何第三方包 | vendored 三包（verification_selection/skill_evolution/sop_lifecycle）经核实为纯标准库（import 清单全为 stdlib，pytest 仅测试用） |
| 8 | tm/temp 过程文件 | `.gitignore` 增加 `**/tm`、`**/tm.*`、`**/temp`、`**/temp.*` | 用户约定：过程文件不入版本跟踪；模式限定精确文件名，不误伤 `templates/`、`temporal` 等合法命名 |
| 9 | 运行时 TS 执行 | 容器内直接 `node src/start.ts`（Node 25 原生擦除 erasable TS），不引入 tsx 到生产 | 全工程已强制 erasableSyntaxOnly；少一个运行时依赖 |

## 验证

- `scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run`（packages/agent-server）：20 文件/213 测试全绿。
- compose YAML 语法校验通过（python yaml.safe_load）。
- Dockerfile **未实际构建**：本机 colima 守护进程未运行（未启动 VM，避免工程外系统状态变更）。镜像构建验证留给首次实际部署时执行，文档中的命令已按标准语法书写。

## 遗留

- 长期方案：升级 better-sqlite3 至支持 Node 26 的版本（动根 package.json/lockfile），届时可解除 25.9.0 固定。需用户拍板后排期。
- Docker 镜像首次构建验证待执行。

Refer Spec：` design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`（通用约束）；` design/2026-07-22-agent-server-b3-evolution-scheduling-changes-and-decisions.md`（loop 模式出处）
