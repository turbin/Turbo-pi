# Agent Server P2 Task 3：流式路径 session JSONL 落盘——变更与决策

日期：2026-07-22
范围：`packages/agent-server/src/server.ts`、`src/session-writer.ts`、`test/server.test.ts`、`test/session-writer.test.ts`
来源：P1 最终评审 finding 22（Kimi 走 SSE 流式路径，注入生效但不写 session 文件），见 `doc/design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` P2 事项 2

## 变更

1. `/v1/chat/completions` 的 `stream:true` 分支现在与 handleStream 一样写 pi-native session JSONL：session header、规范化后的请求消息、`experience_injection` 条目（retrieved ids）、`response_started`。
2. 新增 `teeOpenAISSEWithSession`（server.ts）：透传原始字节不变，同时按行解析 OpenAI SSE chunk，每个 chunk 记为 `stream_event` 条目；流正常结束时重建 assistant message 并写入（在 `response_completed` 之前，保持 parentId 链序与 handleStream 一致）；error/cancel 写 `error`/`aborted` 且不写 assistant message；writer 恰好关闭一次。
3. 新增 `buildAssistantMessageFromOpenAI(chunks, model)`（session-writer.ts）：OpenAI chunk → pi-native AssistantMessage。`delta.content` → text；`reasoning_content`/`reasoning`/`reasoning_text` → thinking；`tool_calls[]` 按 `index` 重组（id/name/arguments 片段拼接，args 解析失败兜底 `{}`）；最后一个 `usage` chunk → usage；`finish_reason` 映射 stopReason。无可映射 `finish_reason` 时返回 null（error/abort 语义，与 `buildAssistantMessage` 无 done 返回 null 对齐）。
4. 测试：server.test.ts 新增流式录制 describe（透传字节逐字节一致、session 文件结构完整、中途错误路径）；session-writer.test.ts 新增 6 个重建函数单测。

## 决策

| 决策 | 理由 |
|---|---|
| 保持 raw OpenAI SSE 透传，不经 handleStream 的 pi-ai 事件转换 | Kimi Code 等客户端消费 raw OpenAI SSE；raw→pi-ai→raw 双重转换会丢 usage/finish_reason 细节且增加故障面。tee 只观察不改动字节。 |
| chunk 重建逻辑放 session-writer.ts 而非 server.ts | 与 `buildAssistantMessage` 同模块、同风格；server.ts 只负责接线。 |
| `data: [DONE]` 不记为 `stream_event` | 它不是可解析的 chunk，只作流终止标记。 |
| 无 `finish_reason` 不写 assistant message | 与 handleStream「无 done 事件不写 assistant message」语义对齐；error/abort 路径下部分回复只保留在 `stream_event` 条目中。 |
| 请求消息记为规范化后的 OpenAI 形态（本分支的 messages 数组） | 该分支操作 OpenAI 风格消息；不与 proxy-handler 的 `lastUserText`（pi-ai Context）强行统一，避免跨模块抽象。 |
| 记录注入前消息 + `experience_injection` ids | 与 handleStream 的 P1 Task 8 决策保持一致；注入后内容记录由 P2 Task 4（custom_message）补齐。 |

## 验证

- agent-server 全套 127 测试通过（含本任务新增 8 个）。
- `npm run check` 干净（含根 tsgo --noEmit）。
- 注：本任务开发时发现并单独修复了 Task 2 status 过滤导致的 etl.test.ts 回归（见前一笔 fix 提交）。
