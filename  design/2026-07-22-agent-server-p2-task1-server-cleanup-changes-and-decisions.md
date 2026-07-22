# Agent Server P2 Task 1：server.ts 遗留清理——变更与决策

日期：2026-07-22
范围：`packages/agent-server/src/server.ts`、`packages/agent-server/test/server.test.ts`（新增）
来源：P1 最终评审遗留（` design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` P2 事项 5）

## 变更

1. `/v1/chat/completions` 不再无条件把请求体写到固定路径 `/tmp/agent-server-request.json`；改为仅当 `AGENT_SERVER_DEBUG_DUMP=1` 时写入（默认关闭）。
2. 消除 4 处 inline `await import()`（`node:fs/promises`、`retrieval.ts`、`injection.ts`、`openai-compat.ts`、`gateway-client.ts`），全部改为顶层 import。
3. 新增 `test/server.test.ts`：断言默认不写 dump 文件、`AGENT_SERVER_DEBUG_DUMP=1` 时写入。

## 决策

| 决策 | 理由 |
|---|---|
| 保留 debug dump 能力但加 env 开关（默认关），而非直接删除 | 该 dump 是 live 调试期引入的排障手段，直接删除会丢失调试入口；固定 `/tmp` 路径 + 默认关闭已消除"用户 prompt/代码落盘在 var/ 之外"的默认风险。调试路径保持原样，避免改变既有调试流程。 |
| 开关命名为 `AGENT_SERVER_DEBUG_DUMP` | 与既有 `AGENT_SERVER_SESSION_DIR`、`AGENT_SERVER_PYTHON` 等 env 前缀一致。 |
| 测试用 `app.inject` + 不可用 gateway（fetch mock reject → 502） | dump 行为发生在 gateway 调用之前，无需真实 gateway；同时覆盖 502 错误路径下 dump 不发生泄漏。 |
| inline import 全部提升到顶层 | 仓库规则禁止 inline imports；这些模块无循环依赖，提升无副作用。 |

## 验证

- `test/server.test.ts` + `test/experience-store.test.ts` 通过（7 tests）。
- `npm run check` 干净。
- 环境备注：本次 `npm install --ignore-scripts` 后 better-sqlite3 需 `npm rebuild`（Node 25 无预编译产物，头文件经 npmmirror 镜像下载）；此前会话记录的 nvm v24.15.0 在本机已不存在，当前使用 Homebrew Node v25.9.0（arm64）验证通过。
