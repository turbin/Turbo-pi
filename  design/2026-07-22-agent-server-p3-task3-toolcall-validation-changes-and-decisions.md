# P3-3：流式路径 toolCall 出站校验 —— 决策记录

日期：2026-07-22

## 决策

按任务书方案 A（observe-only）实现：流式 SSE tee 中解析并累积 `delta.tool_calls`，比对注入后的 tools 白名单，校验结果写入 session 的 `toolcall_validation` custom entry + stderr 日志，违规不阻断转发。

## 实现

### `src/toolcall-validator.ts`（共享校验核心）

- 新增 `AccumulatedToolCall`、`ToolCallValidationReport` 接口
- 新增 `validateAccumulatedToolCalls()` 函数：遍历累积的 toolCall → JSON 解析 → 工具名查白名单 → 参数 schema 校验 → 每调用返回一个 `ToolCallValidationReport`。这是 `validateToolCallStream`（非流式阻断式）与流式 observe-only 路径共享的核心。
- 已有函数 `validateToolCall` / `validateToolCallStream` / `matchesJsonType` 不变。

### `src/server.ts`（流式分支集成）

- `teeOpenAISSEWithSession` 新增可选参数 `tools?: {name; parameters?}[]`
- 解析 SSE chunk 时同步累积 `pendingToolCalls`（按 `call.index` 分组，拼接 `function.name` 与 `function.arguments`）
- 流结束后调用 `validateAccumulatedToolCalls` 生成校验报告，写入 `toolcall_validation` custom entry
- 违规项以 `console.error` 输出 stderr（前缀 `[agent-server] streaming toolCall violations:`）
- 调用方（`/v1/chat/completions` 流式分支）传入 `injected.tools` 作为校验白名单
- raw SSE bytes 完全不变（观察不阻断）

### 方案边界（已知局限）

- 客户端仍会执行坏 toolCall（observe-only 不拦截），阻断式留待后续增强
- 校验发生在流结束后（`response_completed` 之前），不在流中实时拦截
- 校验基准为 `buildInjection` 返回的 `injected.tools`，与非流式路径同一来源

## 验收

- agent-server 全套测试通过（79 测试，8 文件）
- 根 `npm run check` 干净
- 流式路径 bytes 不改动，仅追加 `toolcall_validation` custom entry
