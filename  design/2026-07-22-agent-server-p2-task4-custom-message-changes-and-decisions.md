# Agent Server P2 Task 4：custom_message 实现——变更与决策

日期：2026-07-22
范围：`packages/agent-server/src/proxy-handler.ts`、`src/server.ts`、`src/injection.ts`（注释）、`test/proxy-handler.test.ts`、`test/server.test.ts`
来源：P1 最终评审 finding 23（记录的请求消息是注入前的；spec §6 的 custom_message 未实现，重放会话不反映模型实际看到的上下文），见 ` design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` P2 事项 3

## 变更

1. 两条请求路径（handleStream 非流式、server.ts 流式分支）在 `experience_injection` 条目之后各写一条 `custom_message` 条目：`{messages, systemPrompt, tools}`，即注入后实际发往 gateway 的完整上下文。
2. 修正 injection.ts 过时注释（Task 2 后 `ExperienceStore.search` 已在 SQL 层过滤 status）；proxy-handler.ts 模块注释补充 custom_message 条目说明。
3. 测试：两个测试文件各断言 custom_message 条目存在、parentId 链接到 experience_injection 条目、注入内容（evidence 块）在记录的 messages 中；custom 条目顺序断言更新为 `[experience_injection, custom_message, response_started, ...]`。

## 决策

| 决策 | 理由 |
|---|---|
| 记录完整注入后 payload（messages + systemPrompt + tools），而非只记注入增量 | spec §6 语义是"注入后随会话重放"——重放方需要可直接消费的自包含上下文；每个 session 文件只对应一次请求，体积可接受。 |
| 条目位置在 `experience_injection` 之后、gateway 调用之前 | parentId 链保持"请求消息 → 注入记录 → 注入后上下文 → 流生命周期"的因果顺序，与 stream_event/assistant 条目的既有链序约定一致。 |
| 两条路径各写一次而非抽到公共函数 | 两处 injected 构造方式不同（pi-ai Context vs OpenAI 形态 messages），强行抽公共函数需要统一消息类型，代价大于三行重复。 |
| 预注入消息条目保留不动 | 预注入消息是客户端原始请求的忠实记录；custom_message 是补充而非替换，两者各司其职（finding 23 只要求补记注入后内容）。 |

## 验证

- agent-server 全套 127 测试通过。
- `npm run check` 干净。
