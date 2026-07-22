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
