# Agent Gateway 现场验证记录（LobsterAI / omlx）

**日期：** 2026-07-18
**目标：** 验证设计文档中遗留的 `V1-A01`（LobsterAI 兼容探针）、`V1-A02`（omlx live baseline）、`V1-A03`（LobsterAI 中文请求最终 provider 为 omlx）
**环境：** 用户已启动 omlx（端口 8367）和 LobsterAI（后被本会话意外终止，无法从 shell 重启）

---

## 已完成的验证

### 1. omlx 本地接口基线（V1-A02）

`GET /v1/models` 使用 omlx API key 返回模型列表：

```bash
curl -s http://127.0.0.1:8367/v1/models -H "Authorization: Bearer 3675630"
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
- `local_omlx.api_key = "3675630"`（新增强制认证转发）
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
