# issue-004: 非流式路径升级标记链路双层断裂（alfworld 结果 escalations 恒 0 假绿）

- 状态：fixed（2026-08-09 修复，commit 899745d6）
- 报告：2026-08-09（P0 批次修复校验发现，commit a7f7a618 验证）
- 修复：2026-08-09——gateway body 内嵌 x_gateway 字段（openai extra="allow" 穿透）+ agent-server 非流式分支透传（toolcall-validator done 事件携带）+ alfworld 改读 body 字段并补记 trace_id
- 影响面：`packages/agent-gateway`（响应 body）、`packages/agent-server/src/server.ts` + `gateway-client.ts`（非流式透传）、`packages/agent-server/eval/alfworld_agent.py`（标记消费 + trace_id 记录）

## 现象

P0 批次落地的 `x-gateway` 升级标记（M1）在非流式路径运行时不可达：alfworld 结果 JSONL 中每局 `escalations` 恒 0、`provider` 恒空字符串——**观测仪器静默失明，与 issue-003 同类假绿**（结果文件"权威地"显示零升级）。流式路径（8789 → pi 客户端）不受影响。

## 根因

双层断裂，任一层都使标记不可达：

1. openai 2.48.0 SDK 的 `ChatCompletion` pydantic 对象**无 `.headers` 属性**——`alfworld_agent.py:parse_x_gateway(resp)` 读 `resp.headers` 必抛 AttributeError 被捕获后返回 `{}`（实测：构造真实 `ChatCompletion` 对象验证恒返回 `{}`；eval 测试用的是带 headers 的 mock，故测试绿运行时死）。
2. agent-server 非流式 `/v1/chat/completions` 分支不透传 marker——`GatewayClient.chat()` 只返回解析后的 JSON body，gateway 的 `x-gateway` 响应头在 8789 即丢失（P0 仅在流式 SSE 路径解析了标记注释行）。

连带缺陷：alfworld 未记录 `resp.id`（=gateway trace_id），无法像 campaign 那样用 model_runs 回填兜底。

## 修复

建议（任选其一或组合）：

1. gateway 在响应 **body** 内嵌 `x_gateway` 字段（`build_openai_response`；openai pydantic models `extra="allow"` 可穿透 SDK 对象与 agent-server JSON 透传，全链路无需 headers）——推荐，一处改动覆盖三层。
2. 或 harness 改 `with_raw_response` + agent-server 非流式分支透传 `x-gateway` header。

同时：`alfworld_agent.py` 的 `llm()` 补记 `trace_id`（`resp.id`）入每局记录，使 model_runs 回填可用于 alfworld。

详见 `doc/design/2026-08-09-adversarial-review-experiment-validity.md` §6 V1。

## 回归测试

已落地（red-first，2026-08-09）：

1. gateway pytest `test_escalation.py`：升级/未升级响应 body 均含 `x_gateway` 字段（与 header 一致）断言。
2. agent-server `test/regressions/issue-004-x-gateway-marker-nonstream.test.ts`：toolcall-validator done 事件携带标记 + 非流式 `/v1` body 透传（fake gateway SSE 含注释行）。
3. eval pytest `test_alfworld_agent.py`：用**无 headers 属性的 pydantic 形状**对象断言从 body 提取——防 mock/真实鸿沟复发。
