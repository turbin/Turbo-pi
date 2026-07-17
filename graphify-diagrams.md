# pi monorepo 架构与工程分析图

> 基于 `/Volumes/extdisk-8t/workspace/01-repo/03-agent-harness-repo/pi` 静态扫描生成，仅使用仓库内 `package.json` 与源码文件信息，未安装依赖或运行长时间命令。

---

## 1. 顶层架构图

```mermaid
graph TD
  subgraph Root["pi-monorepo (private workspaces)"]
    direction TB
    subgraph ai["@earendil-works/pi-ai<br/>统一 LLM API 层"]
      ai_api["api/* (OpenAI/Anthropic/... 协议实现)"]
      ai_providers["providers/* (模型/工厂配置)"]
      ai_auth["auth (OAuth/凭证)"]
      ai_utils["utils (诊断/重试/...)"]
    end

    subgraph agent["@earendil-works/pi-agent-core<br/>通用 Agent 运行时"]
      agent_core["agent.ts / agent-loop.ts"]
      agent_harness["harness (session/compaction/skills)"]
    end

    subgraph tui["@earendil-works/pi-tui<br/>终端 UI 组件库"]
      tui_components["components (box/editor/select-list/...)"]
      tui_core["tui.ts / terminal.ts"]
    end

    subgraph coding["@earendil-works/pi-coding-agent<br/>编码 Agent CLI"]
      coding_core["core (SDK/tools/extensions/...)"]
      coding_modes["modes (interactive/rpc/print)"]
      coding_cli["cli (args/main/config)"]
      coding_utils["utils (clipboard/git/image/...)"]
    end

    subgraph orch["@earendil-works/pi-orchestrator<br/>实验性编排器"]
      orch_ipc["ipc (client/server/protocol)"]
      orch_supervisor["supervisor / serve"]
    end
  end

  agent -->|依赖| ai
  coding -->|依赖| agent
  coding -->|依赖| ai
  coding -->|依赖| tui
  orch -->|依赖| coding
  orch -->|依赖| ai
```

---

## 2. Package 依赖/调用交互图

```mermaid
flowchart LR
  subgraph packages
    A["@earendil-works/pi-ai<br/>包: ai"]
    B["@earendil-works/pi-agent-core<br/>包: agent"]
    C["@earendil-works/pi-tui<br/>包: tui"]
    D["@earendil-works/pi-coding-agent<br/>包: coding-agent"]
    E["@earendil-works/pi-orchestrator<br/>包: orchestrator"]
  end

  B -->|api/compat/types| A
  D -->|Agent/AgentMessage/ThinkingLevel| B
  D -->|ImageContent/Model/Auth/Transport/compat| A
  D -->|TUI/ProcessTerminal/Markdown| C
  E -->|SDK/事件类型| D
  E -->|OAuthCredential| A

  style A fill:#e1f5fe
  style B fill:#e8f5e9
  style C fill:#fff3e0
  style D fill:#f3e5f5
  style E fill:#ffebee
```

### 关键跨包调用示例（从源码 import 扫描）

| 调用方 | 被调用方 | 说明 |
|--------|----------|------|
| `agent` | `ai` | `agent.ts` 使用 `streamSimple`/`Message`/`Model`；harness 各模块使用 `Model`、`Usage`、`ImageContent` 等 |
| `coding-agent` | `agent` | `sdk.ts` 使用 `Agent`；`session-manager.ts` 使用 `AgentMessage`/`uuidv7`；大量组件使用 `ThinkingLevel` |
| `coding-agent` | `ai` | `model-registry.ts` 使用 `Api`/`Model`；`interactive-mode.ts` 使用 `AuthEvent`/`AuthPrompt`/`compat` 类型；`bun/cli.ts` 使用 `bun-oauth` |
| `coding-agent` | `tui` | `startup-ui.ts` 使用 `ProcessTerminal`/`TUI`；`tools/*.ts` 使用 `Text`/`Container` 组件；`components` 目录大量 import TUI |
| `orchestrator` | `coding-agent` | `handler.ts`/`supervisor.ts`/`ipc/*.ts`/`rpc-process.ts` 均使用 `pi-coding-agent` 的 SDK/事件类型 |
| `orchestrator` | `ai` | `radius.ts` 使用 `OAuthCredential` |

---

## 3. 工程分析图

### 3.1 各包规模对比

```mermaid
xychart-beta
  title "packages/* 代码规模（src/*.ts 文件数）"
  x-axis ["ai", "agent", "tui", "coding-agent", "orchestrator"]
  y-axis "文件数" 0 --> 170
  bar [159, 25, 27, 142, 13]
```

### 3.2 测试覆盖比例

```mermaid
pie title "各包测试文件数量占比"
  "ai" : 92
  "agent" : 21
  "tui" : 28
  "coding-agent" : 160
```

### 3.3 工程指标表

| 包 | src 文件数 | test 文件数 | 主要入口文件 | 说明 |
|----|-----------:|------------:|--------------|------|
| `@earendil-works/pi-ai` | 159 | 92 | `packages/ai/src/index.ts` | 统一 LLM API、Provider 工厂、OAuth |
| `@earendil-works/pi-agent-core` | 25 | 21 | `packages/agent/src/index.ts` | 通用 Agent 状态机与循环 |
| `@earendil-works/pi-tui` | 27 | 28 | `packages/tui/src/index.ts` | 差分渲染 TUI 组件 |
| `@earendil-works/pi-coding-agent` | 142 | 160 | `packages/coding-agent/src/index.ts` / `src/cli.ts` / `src/main.ts` | 编码 Agent CLI/SDK |
| `@earendil-works/pi-orchestrator` | 13 | 0 | `packages/orchestrator/src/index.ts` / `src/cli.ts` | 实验性编排进程 |

> 注：文件数按 `packages/*/src/**/*.ts` 与 `packages/*/test/**/*.ts` 统计，包含 `.test.ts` 与部分测试辅助脚本；未包含 `docs/`、`examples/` 与 `native/` 二进制资源。

---

## 4. 关键文件 AST 结构：packages/agent/src/agent.ts

```mermaid
flowchart TD
  subgraph imports["模块导入"]
    I1["@earendil-works/pi-ai/compat<br/>ImageContent, Message, Model, SimpleStreamOptions, streamSimple, TextContent, ThinkingBudgets, Transport"]
    I2["./agent-loop.ts<br/>runAgentLoop, runAgentLoopContinue"]
    I3["./types.ts<br/>Agent 相关类型（AgentContext, AgentEvent, AgentMessage, AgentState, AgentTool, ...）"]
  end

  subgraph top_level["顶层声明"]
    F1["defaultConvertToLlm(messages)"]
    C1["EMPTY_USAGE 常量"]
    C2["DEFAULT_MODEL 常量"]
    T1["MutableAgentState 类型"]
    F2["createMutableAgentState(initialState?)"]
    T2["AgentOptions 接口"]
  end

  subgraph classes["类/类型"]
    CL1["class PendingMessageQueue"]
    T3["type ActiveRun"]
    CL2["class Agent"]
  end

  subgraph agent_class["Agent 类成员"]
    A1["私有字段: _state, listeners, steeringQueue, followUpQueue, activeRun"]
    A2["公共属性: convertToLlm, transformContext, streamFn, getApiKey, onPayload, onResponse, beforeToolCall, afterToolCall, prepareNextTurn, prepareNextTurnWithContext, sessionId, thinkingBudgets, transport, maxRetryDelayMs, toolExecution"]
    A3["constructor(options: AgentOptions)"]
    A4["subscribe(listener)"]
    A5["state getter / steeringMode getter/setter"]
    A6["队列 API: steer, followUp, clearSteeringQueue, clearFollowUpQueue, clearAllQueues, hasQueuedMessages"]
    A7["运行控制: abort, waitForIdle, reset, prompt, continue"]
    A8["私有方法: normalizePromptInput, runPromptMessages, runContinuation, createContextSnapshot, createLoopConfig, runWithLifecycle, handleRunFailure, finishRun, processEvents"]
  end

  subgraph exports["导出"]
    E1["export type { QueueMode } from './types.ts'"]
    E2["export interface AgentOptions"]
    E3["export class Agent"]
  end

  I1 --> CL2
  I2 --> CL2
  I3 --> CL2
  T2 --> CL2
  F2 --> CL2
  CL1 --> CL2
  T3 --> CL2
  CL2 --> A3
  A3 --> A1
  A3 --> A2
  A3 --> A4
  A3 --> A5
  A3 --> A6
  A3 --> A7
  A3 --> A8
  CL2 --> E3
  T2 --> E2
```

### 结构摘要（文本树）

```text
packages/agent/src/agent.ts
├── imports
│   ├── @earendil-works/pi-ai/compat
│   ├── ./agent-loop.ts
│   └── ./types.ts
├── top-level
│   ├── defaultConvertToLlm()
│   ├── EMPTY_USAGE
│   ├── DEFAULT_MODEL
│   ├── type MutableAgentState
│   ├── createMutableAgentState()
│   └── interface AgentOptions
├── classes
│   ├── class PendingMessageQueue
│   │   ├── enqueue, hasItems, drain, clear
│   ├── type ActiveRun
│   └── class Agent
│       ├── private _state / listeners / steeringQueue / followUpQueue / activeRun
│       ├── public properties (convertToLlm, streamFn, hooks, etc.)
│       ├── constructor(options)
│       ├── subscribe(listener)
│       ├── state getter / steeringMode getter/setter
│       ├── queue APIs (steer, followUp, clear...)
│       ├── lifecycle (abort, waitForIdle, reset, prompt, continue)
│       └── private helpers (runPromptMessages, createLoopConfig, runWithLifecycle, processEvents, ...)
└── exports
    ├── type QueueMode
    ├── interface AgentOptions
    └── class Agent
```

---

## 5. 关键文件 AST 结构：packages/ai/src/index.ts（补充）

```mermaid
flowchart LR
  subgraph ai_exports["@earendil-works/pi-ai 公共导出"]
    E0["typebox Static/TSchema/Type"]
    E1["api/* 类型 (AnthropicOptions, AzureOpenAIResponsesOptions, BedrockOptions, ... )"]
    E2["auth/* (context, credential-store, helpers, types)"]
    E3["compat/extension-oauth-types"]
    E4["images-models, models, models-store"]
    E5["providers/faux.ts"]
    E6["session-resources, types"]
    E7["utils (diagnostics, event-stream, json-parse, overflow, retry, typebox-helpers, validation)"]
  end

  E0 --> E1 --> E2 --> E3 --> E4 --> E5 --> E6 --> E7
```

---

*生成时间：2026-07-17（基于仓库当前 HEAD 静态扫描）。*
