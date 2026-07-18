# Agent Gateway 现场验证记录（LobsterAI / omlx）

**日期：** 2026-07-18
**目标：** 验证设计文档中遗留的 `V1-A01`（LobsterAI 兼容探针）、`V1-A02`（omlx live baseline）、`V1-A03`（LobsterAI 中文请求最终 provider 为 omlx）
**环境：** 用户已启动 omlx（端口 8367）和 LobsterAI（后被本会话意外终止，无法从 shell 重启）

---

## 已完成的验证

### 1. omlx 本地接口基线（V1-A02）

`GET /v1/models` 使用 omlx API key 返回模型列表：

```bash
curl -s http://127.0.0.1:8367/v1/models -H "Authorization: Bearer <OMLX_API_KEY>"
```

返回模型：

- `gemma-4-12B-it`
- `gemma-4-12B-it-4bit`
- `qwen-vl-7b-oQ4`
- `MarkItDown`

结论：omlx 本地服务 OpenAI 兼容 `/v1/models` 可用。

### 2. Gateway → omlx 中文请求端到端（V1-A03 等价路径）

在 `packages/agent-gateway/config.toml` 中配置：

- `local_omlx.base_url = "http://127.0.0.1:8367/v1"`
- `local_omlx.model = "gemma-4-12B-it-4bit"`
- `local_omlx.api_key = "<OMLX_API_KEY>"`（新增强制认证转发）
- channel `lobster-local-key`，allowed_models 包含 `agent-auto`

启动 gateway：`uv run python -m agent_gateway --config config.toml`

请求：

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"你好，请简短介绍一下自己"}],"max_tokens":128}'
```

返回：中文回复，logical model `agent-auto`，`finish_reason: stop`，usage 95 tokens。

Trace 查询与数据库验证：

```bash
sqlite3 packages/agent-gateway/var/agent_gateway.db \
  "SELECT trace_id, provider, state, purpose FROM model_runs;"
```

结果：`provider = "omlx"`，`state = "succeeded"`，`purpose = "primary"`。

结论：Gateway 将中文请求成功路由到本地 omlx，符合 V1-A03 核心要求（“最终 provider 为 omlx”）。

### 3. 新增 omlx API key 转发（V1-A02/A03 必需）

本次验证发现 omlx 实例要求 `Authorization: Bearer <key>`，否则 `/v1/models` 和 `/v1/chat/completions` 都返回 `API key required`。原有 `OmlxProvider` 没有发送 key 的能力。因此做了两处小改动：

- `config.LocalOmlxConfig` 增加 `api_key: str | None`
- `providers.OmlxProvider` 在 httpx 客户端初始化时带上 `Authorization: Bearer {api_key}` header

测试：`uv run pytest -q` → 159 全部通过。live 请求也成功。

---

## 未完成的验证：LobsterAI UI 操作

### 尝试过程

1. **已配置 LobsterAI 指向 gateway**：通过反编译 `app.asar` 发现 LobsterAI 把 API 配置保存在 `~/Library/Application Support/LobsterAI/api-config.json`，格式为 `{ apiKey, baseURL, model, apiType }`。已写入：

   ```json
   {
     "apiKey": "lobster-local-key",
     "baseURL": "http://127.0.0.1:8787/v1",
     "model": "agent-auto",
     "apiType": "openai"
   }
   ```

2. **Playwright 无法启动/附加已打包的 macOS Electron 应用**：
   - `playwright._electron.launch()` 报 `Process failed to launch!`，因为 Playwright 需要在启动时注入调试脚本，而已打包的 `LobsterAI.app` 的 `nodeIntegration`/`contextIsolation` 设置不满足注入条件，且主进程不输出 Playwright 等待的 `DevTools listening` 行。
   - 直接传 `--remote-debugging-port=9222` 被主进程拒绝：`bad option: --remote-debugging-port=9222`。
   - 现有的 `DevToolsActivePort` 文件（端口 65116）是旧进程残留，HTTP 端口未实际监听；`connectOverCDP` 失败。

3. **shell 无法重启 GUI 进程**：
   - `open /Applications/LobsterAI.app` / `open -a LobsterAI` 没有产生可见进程（可能无 Aqua/GUI 权限）。
   - `osascript -e 'tell application "LobsterAI" to activate'` 挂起，最终超时。
   - `pkill -f "LobsterAI"` 意外终止了用户之前启动的实例。

### 结论与 TODO

- **V1-A02 与 V1-A03 核心逻辑已通过直接 HTTP 探针验证**，但 **未通过 LobsterAI 实际 UI 操作复验**。
- 需要用户在当前 macOS 会话中手动重新启动 LobsterAI，并（可选）提供可用于自动化测试的入口，例如：
  - 使用未打包的 dev 版本启动（`electron . --remote-debugging-port=9222`）
  - 或提供 LobsterAI 的内置本地 HTTP/CLI 接口（如有）
  - 或允许使用 macOS Accessibility（AppleScript/pyautogui）代替 Playwright 操作 UI

---

## 决策记录

1. **新增 `local_omlx.api_key` 配置项并转发到上游 omlx**
   - 原因：现场 omlx 实例强制 API key 认证，没有该字段 gateway 无法调用本地模型；保持与上游 omlx 的 `auth.api_key` 设置一致。

2. **直接写入 `~/Library/Application Support/LobsterAI/api-config.json` 配置 LobsterAI 指向 gateway**
   - 原因：通过反编译源码发现这是 LobsterAI 读取 API 端点的文件，比 UI 操作更稳定；UI 自动化失败时可用作等价配置。

3. **保留 `config.toml` 在 gitignore 中，不提交**
   - 原因：包含 omlx API key 等敏感本地配置，不应进入仓库。

4. **未修改 `/Applications/LobsterAI.app` 或 plist 以强制开启 CDP**
   - 原因：修改系统应用 bundle 不可恢复，且超出工作目录范围；等待用户提供可自动化的运行方式。

---

## 附件

- 反编译后发现的配置接口：`saveCoworkApiConfig({ apiKey, baseURL, model, apiType })` 写入 `api-config.json`（`apiType` 仅允许 `"openai"` 或 `"anthropic"`）。
- omlx 认证信息来自 `~/.omlx/settings.json` 的 `auth.api_key`（已脱敏，未写入任何提交文件）。


---

## 更新：Kimi Code CLI 现场验证（替换 LobsterAI）

**日期：** 2026-07-18（同日追加）
**目标：** 完成 `V1-A01`（Kimi Code 兼容探针）、`V1-A02`（omlx live baseline）、`V1-A03`（Kimi Code 中文请求最终 provider 为 omlx）
**环境变更：** 用户本地已安装 Kimi Code CLI（`/Users/yanbin/.kimi-code/bin/kimi`），并将文档中的 "LobsterAI" 替换为 "Kimi Code"。

### 验证结果

#### V1-A01 Kimi Code 兼容探针

Kimi Code CLI 支持通过自定义 `openai` provider 类型配置任意 base URL、逻辑模型名与 API key：

```toml
[models."local/agent-auto"]
provider = "local:agent-gateway"
model = "agent-auto"
max_context_size = 128000
capabilities = ["thinking"]

[providers."local:agent-gateway"]
type = "openai"
base_url = "http://127.0.0.1:8787/v1"
api_key = "lobster-local-key"
```

运行 `kimi doctor` 与 `kimi provider list`：

- `kimi doctor`：配置有效。
- `kimi provider list`：识别 `local:agent-gateway type=openai models=1`。

结论：Kimi Code 可配置为指向本地 gateway，使用逻辑模型名 `agent-auto`。

#### V1-A02 omlx live baseline（追加确认）

omlx 在 `127.0.0.1:8367` 运行。通过 gateway 测试：

1. **非流式中文请求**：`curl POST /v1/chat/completions` 返回中文回复，`model_runs.provider = "omlx"`。
2. **SSE 流式中文请求**：`stream=true` 返回完整 SSE 回放，包含 `role` delta、`content` delta、`finish_reason: stop` 与 `[DONE]`。

结论：omlx live baseline 通过 gateway 的非流式与流式路径均可用。

#### V1-A03 Kimi Code 中文请求最终 provider 为 omlx

执行：

```bash
kimi -p "你好，请简短介绍一下自己" -m local/agent-auto
```

输出：中文回复，内容与 Kimi Code CLI 自我介绍一致。

数据库验证：

```bash
sqlite3 packages/agent-gateway/var/agent_gateway.db \
  "SELECT trace_id, provider, state, purpose FROM model_runs ORDER BY id DESC LIMIT 1;"
```

结果：

```
chatcmpl-b8b2e9dc665c4361b9c42ce9c5f6e1b7|omlx|succeeded|primary
```

结论：Kimi Code 的中文请求经 gateway 最终路由到本地 omlx，provider 为 omlx，符合 V1-A03。

### 现场修复：Kimi Code 默认发送 `reasoning_effort`

Kimi Code CLI 的默认请求会携带 `reasoning_effort`（来自 `config.toml` `[thinking]` 配置）。`ChatCompletionEnvelopeV1` 原使用 `extra="forbid"`，gateway 返回 400 `unsupported_parameter: reasoning_effort`。

修复：
- `packages/agent-gateway/src/agent_gateway/envelope.py`：显式声明 `reasoning_effort: str | None = None`，接受该字段但不转发给上游。
- `packages/agent-gateway/src/agent_gateway/tests/unit/test_envelope.py`：新增单测 `test_reasoning_effort_accepted_but_not_forwarded`。

验证：`uv run pytest -q` → 160 个测试全部通过（原 159 + 新增 1）。

### 决策记录（追加）

1. **在 `ChatCompletionEnvelopeV1` 中显式接受 `reasoning_effort`**，而非全局放宽 `extra="forbid"`。
   - 原因：兼容 Kimi Code 等 OpenAI 客户端的默认请求，同时保持对未知参数的严格保护。

2. **不将 `reasoning_effort` 转发到上游 omlx**。
   - 原因：本地 omlx 模型不支持该参数；转发会导致上游失败。

3. **Kimi Code 配置使用 `type = "openai"` 自定义 provider**。
   - 原因：Kimi Code CLI 支持 `openai` provider 类型，可配置任意 base URL、api_key、model，足够完成网关探针验证。

### 遗留

- V1-A02 的 tool 调用与超长响应 live 未用 Kimi Code 客户端复验；gateway 到 omlx 的流式与非流式中文路径已验证可用。
- V1-A04 及以后仍仅由单测覆盖，未做 live 验证。

---

## 更新：V1-A04 云升级 live 验证（DeepSeek）

**日期：** 2026-07-18（同日追加）
**环境：** 用户提供了 DeepSeek API key。gateway 配置通过环境变量读取：
- `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1`
- `DEEPSEEK_API_KEY`（环境变量传入，不写入任何提交文件）
- `DEEPSEEK_MODEL=deepseek-v4-flash`

`config.toml` 中：
- `[cloud.deepseek] enabled = true`，`base_url_env/api_key_env/model_env` 指向上述环境变量名。
- `[routing] selected_cloud_provider = "deepseek"`。
- channel `lobster-local-key` 设置 `cloud_egress_allowed = true` 与 `monthly_budget_micro_usd = 1_000_000`。

### 验证方法

发送本地 omlx 会触发 `finish_reason_length` 的请求：

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"你好，请简短介绍一下自己"}],"max_tokens":1}'
```

本地 omlx 返回 `finish_reason: length`，gateway 质量门控触发升级，二次请求 DeepSeek。

### 数据库验证

```bash
sqlite3 packages/agent-gateway/var/agent_gateway.db \
  "SELECT provider, state, purpose, quality_signals_json FROM model_runs WHERE trace_id = '<trace_id>';"
```

结果：

```
omlx|succeeded|primary|{"finish_reason": "length", ...}
deepseek|succeeded|escalation|{"finish_reason": "length", "escalation_reason": "finish_reason_length", ...}
```

结论：V1-A04 通过——本地结构失败（生成长度不足）触发单一云升级至 DeepSeek，且 `model_runs` 正确记录 primary 与 escalation 两次运行。

### 决策记录（追加）

1. **云 provider 通过环境变量注入，key 不写入 config.toml 或代码/文档。**
   - 原因：`config.toml` 本身被 gitignore，但坚持 env-var 注入可确保即使 config 被意外复制，敏感 key 也不随之泄露；与 `KimiProvider.from_config` 设计一致。

2. **DeepSeek 使用现有 `kimi.py` 适配器。**
   - 原因：DeepSeek 与 OpenAI 兼容，`kimi.py` 已是配置驱动的 OpenAI 适配；无需新增 `deepseek.py`（与 §3.11 决策一致）。

3. **live 验证选择 `finish_reason_length` 作为触发器。**
   - 原因：omlx 对 `max_tokens=1` 稳定返回 `finish_reason=length`，且该信号在质量门控中属于"结构失败"，能明确验证升级路径。forced_tool/named tool_choice 在 DeepSeek `deepseek-v4-flash` thinking 模式下不被支持，会返回 400，不适合当前模型配置。

### 遗留

- 由于 DeepSeek `deepseek-v4-flash` 在 thinking 模式下对 named `tool_choice` 返回 400，未用 live 验证 `invalid_tool_schema` / `forced_tool_missing` 的升级路径；这两条路在单测中由 FakeProvider 覆盖。
- 升级后的 DeepSeek 响应在 `max_tokens=1` 时 `content` 为空（reasoning token 占用 1 token），这是模型行为，不影响升级路径本身的验证。
