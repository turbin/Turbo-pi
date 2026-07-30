# Agent-Server E0：评估实例 + 接线冒烟——变更与决策记录

日期：2026-07-24
任务书：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md` E0 节
进度：`doc/design/progress/2026-07-24-eval-benchmark.md`

---

## 1. 评估实例（8789）全链路验证

- 起法（host tsx，独立于 compose 生产栈）：
  ```bash
  cd packages/agent-server
  PORT=8789 EXPERIENCE_STORE_PATH=./var/eval/experience.db \
  AGENT_SERVER_SESSION_DIR=./var/eval/sessions \
  GATEWAY_URL=https://api.deepseek.com AGENT_GATEWAY_KEY=<deepseek key> \
  ../../scripts/with-node25.sh npx tsx src/start.ts
  ```
- curl 冒烟：DeepSeek 应答正常；session 落盘 `var/eval/sessions/`（pi v3 格式）；`experience_injection`/`custom_message` 记录齐全（冷库 retrieved 为空，符合预期）。
- `var/eval/` 被 `packages/agent-server/.gitignore` 的 `var/` 规则覆盖，无需额外 ignore。

## 2. 关键缺陷修复：非流式响应丢 tool_calls（E0 阻塞性 bug）

**现象**：mini-swe-agent 经 8789 跑 toy 任务失败（`RepeatedFormatError: No tool calls found`）。对照实验证实：DeepSeek 直连返回 `tool_calls` + `finish_reason:"tool_calls"`，经 8789 后响应只剩空 content，`finish_reason` 变成 pi-ai 风格的 `"toolUse"`。

**根因**：`server.ts` 非流式分支聚合内部流事件时只收集 `text_delta`，`toolcall_start/delta` 事件全部丢弃；`finish_reason`/`usage` 直接透传 pi-ai 形状（`toolUse` / `{input,output,cacheRead,cacheWrite}`），不符合 OpenAI 响应契约。流式分支不受影响（raw SSE 透传）。该缺陷使**任何 tool-calling 客户端都无法经非流式路径使用 agent-server**——Kimi Code 此前走的是流式路径所以未暴露。

**修复**（`src/server.ts` 非流式分支）：
1. 收集 `toolcall_start/toolcall_delta`，按 contentIndex 组装 OpenAI `tool_calls`（id/type/function.name/function.arguments）；
2. `finish_reason` 映射：`toolUse` → `tool_calls`，其余透传；
3. `usage` 映射为 OpenAI 形状：`prompt_tokens = input+cacheRead+cacheWrite`、`completion_tokens = output`、`total_tokens = totalTokens ?? 两者之和`。

**TDD**：`test/server.test.ts` 新增非流式 describe 2 条用例（tool_calls 组装 + finish/usage 映射；纯文本 stop 路径不回归），先红后绿；包级 vitest 22 文件 / **238 测试**全绿；根 `npm run check` 干净。

**复验**：修复后 mini-swe-agent 经 8789 完成 toy 任务（创建文件成功），工具调用全链路通。

## 3. harness 选型决策（任务书 E0 决策点）

**决定：benchmark agent 统一用 mini-swe-agent，不用 Kimi Code / pi 作为被测 agent。**

理由：
1. mini-swe-agent 是 SWE-bench 官方标准 harness（~100 行 bash agent），分数可与公开 leaderboard 横向对比；Kimi/pi 的分数无参照系。
2. Terminal-Bench / SWE-bench 的 agent 要在**每个任务容器内**安装运行——Kimi/pi 需要 Node 运行时 + 鉴权配置 + 交互模式适配，成本高且引入被测变量；mini-swe-agent 是纯 Python、env 变量注入端点即可。
3. 评估目标是"agent-server 经验注入是否有效"，被测 agent 越简单透明，对照越干净。Kimi/pi 接线属日常使用路径（生产 compose 已具备），不是本里程碑的测量对象。

## 4. 环境搭建记录

- `packages/agent-server/eval/.venv`：**必须 Python ≥3.12**（terminal-bench 依赖；uv 默认建 3.11 导致 unsatisfiable，重建解决）。包：mini-swe-agent 2.4.6 + terminal-bench（清华 PyPI 镜像，官方源超时）。
- mini-swe-agent 非交互运行的三个坑与解法：
  1. 无 tty 时 prompt_toolkit kqueue 崩溃（`OSError: [Errno 22]`）→ `MSWEA_CONFIGURED=1` 跳过首次配置向导（向导是崩溃源）；
  2. 向导还要求默认模型 → 同时 `MSWEA_SILENT_STARTUP=1`；
  3. litellm 不认识 deepseek-v4 定价 + GitHub raw 不可达 → `MSWEA_COST_TRACKING=ignore_errors`。
- 标准运行形态：
  ```bash
  MSWEA_CONFIGURED=1 MSWEA_SILENT_STARTUP=1 MSWEA_COST_TRACKING=ignore_errors \
  OPENAI_BASE_URL=http://127.0.0.1:8789/v1 OPENAI_API_KEY=dummy \
  .venv/bin/mini -m openai/deepseek-v4-flash --agent-class default --exit-immediately -y -l <成本上限> -o <轨迹.json> -t "<任务>"
  ```
  （对照臂把 `OPENAI_BASE_URL` 换成 `https://api.deepseek.com/v1`、`OPENAI_API_KEY` 换真实 key。）

## 5. 已知限制

- agent-server 响应的 `usage` 现已映射为 OpenAI 形状；响应仍不含 `reasoning_content`（DeepSeek 的思考内容在非流式路径被丢弃，session 里有记录）——不影响工具调用，注入评估不需要。
- mini 轨迹显示 DeepSeek v4-flash 偶发不输出 tool call（`No tool calls found` 重试）——模型行为，mini 自带重试能恢复；正式跑分建议用 v4-pro。

Refer Spec：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E0）；`doc/design/2026-07-19-agent-server-task5-openai-compat-changes-and-decisions.md`（自包含映射器原决策）
