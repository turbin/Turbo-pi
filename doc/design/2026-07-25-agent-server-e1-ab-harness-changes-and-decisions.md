# Agent-Server E1：A/B 对照 harness 脚手架——变更与决策记录

日期：2026-07-24（~~2026-07-25~~ 验收修正：执行与提交均在 07-24 下午，commit 542713f5 时间戳 2026-07-24T16:53+08:00）
任务书：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md` E1 节
进度：`doc/design/progress/2026-07-24-eval-benchmark.md`

---

## 1. litellm 连接 bug（E1 阻塞性发现）

**现象**：`eval/.venv` 中安装的 litellm 1.93.0（mini-swe-agent 2.4.6 的依赖）无法连接 DeepSeek API，错误为：
```
httpcore.ConnectError: [Errno 8] nodename nor servname provided, or not known
```

**排查过程**：
1. 同 venv 中 `httpx` 直连 DeepSeek 正常（200 OK），`requests` 也正常
2. 同 venv 中 `openai` Python 客户端（v2.48.0）直连 DeepSeek 正常
3. `litellm.completion()` 调用在 openai 导入前后均失败
4. 在 litellm `make_sync_openai_chat_completion_request` 中创建全新 `OpenAI()` 客户端仍失败
5. 同一 Python 进程中 `OpenAI()` 直连正常，但经 litellm 链路即失败
6. 错误堆栈显示请求经 `httpcore/_sync/http_proxy.py`，但 httpx client 未配置 proxy
7. 升级 litellm 受阻（1.93.0 是 uv 可解析的最新版，1.94+ 需要 `--prerelease=allow`）

**根因**：未完全定位。疑似 litellm 内部链路修改了 httpx client 的连接方式（可能通过 litellm 的 `module_level_client` 或全局状态），导致 DNS 解析失败。`openai` 直连与 `litellm` 包装层之间存在深层兼容性差异。

**结论**：本里程碑不修复此 bug（根因在 litellm 依赖，非 agent-server 代码）。E1 harness 改用 openai Python 客户端直连，绕过 litellm/mini-swe-agent。

## 2. harness 选型变更

**原始计划（任务书）**：用 mini-swe-agent 作为两臂的 agent harness（标准 benchmark 工具）。

**实际实现**：用 openai Python 客户端直接实现最小 Bash agent（tool-calling loop），原因：
1. litellm bug 阻断 mini-swe-agent 运行
2. E1 任务集为简单文件操作，不需要 mini-swe-agent 的完整功能
3. 直接使用 openai 客户端更轻量、成本更可控（少一层封装）
4. 为 E2/E3 保留 mini-swe-agent 路径（可后续修复 litellm 或在 Docker 中运行）

**影响**：E1 的通过率/成本数据不可与 mini-swe-agent 的 SWE-bench leaderboard 直接对比；但 A/B 对照的目的（"agent-server 经验注入是否有效"）不受影响——两臂用同一 agent、同一模型，唯一差异是路由。

**E2/E3 展望**：Terminal-Bench 和 SWE-bench 需要 mini-swe-agent 或 Terminal-Bench 自带的 agent adapter。届时有两种方案：
- 方案 A：升级 litellm 到预发布版（1.95.0.dev2+）或用 uv 的 `--prerelease=allow`
- 方案 B：在 Docker 容器内运行 mini-swe-agent（避免 host 环境问题），复用 E0 的代理配置经验

## 3. harness 设计

`eval/harness.py`：Python CLI，读取 YAML 任务定义，编排两臂运行。

### 3.1 任务格式

`eval/tasks/tasks-5.yaml`：每个任务包含：
- `id`：唯一标识
- `description`：人类可读描述
- `prompt`：发给 agent 的任务描述
- `verify`：验证规则列表（`file_exists`、`file_contains`、`file_not_contains`、`command`）

### 3.2 Agent 实现

最小 Bash agent（~30 行核心逻辑）：
- System prompt 引导 agent 使用 `bash` tool
- Tool calling loop：发送请求 → 解析 tool_calls → 执行 bash → 返回结果
- 最多 15 轮，超时 120s/任务
- 两臂使用同一 `openai.OpenAI` 客户端，仅 `base_url` 和 `api_key` 不同

### 3.3 环境变量清理

harness 启动时清除所有 proxy 环境变量（`HTTPS_PROXY`、`HTTP_PROXY` 等），防止 `.env` 中为 Docker compose 设置的 `host.docker.internal` 代理污染宿主机的 HTTP 连接。

### 3.4 防泄漏归档

实验臂每轮完成后，将 `var/eval/sessions/` 下所有 session 文件移动到 `results/<run-id>/experiment/sessions-archive/`，原目录清空，确保下一轮从空库起跑。

### 3.5 随机化

固定种子（`--seed 42`）shuffle 任务顺序；两臂使用同一顺序。

## 4. 冒烟结果（smoke-02）

| 指标 | 对照臂（直连 DeepSeek） | 实验臂（经 8789） | Delta |
|------|----------------------|------------------|-------|
| 通过率 | 5/5 | 5/5 | +0 |
| 输入 tokens | 12,611 | 17,411 | +4,800 |
| 输出 tokens | 1,405 | 1,899 | +494 |
| 总 tokens | 14,016 | 19,310 | +5,294 |
| 平均耗时/任务 | 4.5s | 5.6s | +1.1s |
| 总轮次（turns） | 20 | 24 | +4 |

~~实验臂 token 增加符合预期：agent-server 在请求中注入 experience（当前冷库，注入为空块），增加了少量上下文。通过率无变化（注入无害）。~~

**验收修正（2026-07-24 kimi）**：上述归因不成立。复核 smoke-02 归档 session 证实实验臂注入为空（`retrieved: []`），空注入的额外上下文开销可忽略；+4,800 input tokens 的真实原因是**轨迹方差**——实验臂 24 turns vs 对照臂 20 turns，每多 1 turn 全历史重发一次。5 任务样本下 token delta 属噪声，不可归因于注入开销。方法论结论：A/B 的 token 对比需更大样本或控制轨迹（固定 temperature/seed 不能消除 agent 路径分叉），E2/E3 报告应以通过率为主指标、token 仅作参考。通过率无变化（注入无害）的结论不受影响。

## 5. 产出清单

| 文件 | 说明 |
|------|------|
| `eval/harness.py` | A/B 编排脚本 |
| `eval/tasks/tasks-5.yaml` | 5 任务冒烟集 |
| `eval/results/smoke-02/` | 冒烟结果（summary.json + 两臂轨迹） |

Refer Spec：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E1）；`doc/design/2026-07-24-agent-server-e0-eval-instance-changes-and-decisions.md`（E0 环境基线）
