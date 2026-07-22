# P3-4：agent-server package 级 tsconfig 解析修复 —— 决策记录

日期：2026-07-22

## 决策

**直接删除 `packages/agent-server/tsconfig.json`**（方案 b），让 tsgo/vitest 通过目录向上找到根 `tsconfig.json` 的统一 paths 映射。

## 理由

1. `packages/agent-server/tsconfig.json` 仅 `extends ../../tsconfig.base.json` 且 `moduleResolution: Bundler`，缺少根 `tsconfig.json` 的 `paths` 映射（`@earendil-works/*` → `packages/*/src`），导致包目录下 `tsgo --noEmit` 报 15+ 个 TS2307/TS7006/TS2339 错误。
2. 根 `tsconfig.json` 的 `include` 已覆盖 `packages/*/src/**/*` 和 `packages/*/test/**/*`，且 `tsgo` 会从当前目录向上搜索 tsconfig，包目录下运行 `tsgo --noEmit` 自动使用根配置。
3. 其他 5 个包（agent/ai/coding-agent/tui/orchestrator/agent-old）都没有 package 级 tsconfig.json，根 config 统一管理是 repo 惯例。
4. vitest 用自定义 `resolve.alias` 映射 `@earendil-works/pi-ai`，不依赖 tsconfig paths；删除后 148 测试全通过。
5. `package.json` 的 `check` 脚本（`tsgo --noEmit`）在删除 tsconfig.json 后退出码 0，不再报错。

## 影响

- 包目录下 IDE/CLI 的 tsgo 类型检查恢复正常。
- 不影响根 `npm run check`（使用根 tsconfig.json，本来就干净）。
- 不影响 vitest（自定义 alias 解析）。
- 不影响 tsx 运行（运行时模块解析不依赖 tsconfig paths）。

## 执行约束（2026-07-22 用户追加，全 P3 任务适用）

本任务及全部 P3 任务在以下约束下执行（canonical 版本见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md` 通用约束一节，此处同步留档）：

- **改动范围仅限当前工程**：只允许修改本仓库（pi-monorepo 工作目录）内的文件——源码、测试、文档、`var/` 等 runtime 产物、工程内配置文件。工程之外一律不得改动，包括但不限于：
  - 用户配置：`~/.kimi/config.toml`、`~/.omlx/settings.json` 及一切 home 目录下的工具配置；
  - omlx 的任何配置与已配置好的模型（模型目录 `/Volumes/extern-1t-x5/models` 及其内容、运行实例的端口/密钥/模型加载状态）——omlx 只可按现状启动/查询/调用；
  - 系统状态：全局安装的包、系统服务、环境变量持久化设置、其他工程的文件。
- 不允许为了通过测试或验证而改动环境迁就测试；任务若需要工程外配合（改配置、装依赖、起服务），停下来报告用户处理，不得自行越权。
- `/tmp` 一次性临时文件可创建，用后删除，不视为"改动"。
