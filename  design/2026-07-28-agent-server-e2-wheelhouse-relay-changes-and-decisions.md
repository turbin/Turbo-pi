# Agent-Server E2.3 前置条件：离线 wheelhouse + 宿主中继——变更与决策记录

日期：2026-07-28
任务书：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2.3 前置条件三方案）
进度：` design/progress/2026-07-24-eval-benchmark.md`
状态：**已完成（E2.3 前置条件闭环，可启动全量）**

---

## 1. 背景

E2.2 复验（同日，见 ` design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md` §8.4）确认：冒烟头号失败模式是容器内 pip 经代理链下载断流（IncompleteRead）。E2.3 全量（89 任务双臂）前必须解决安装稳定性。

## 2. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | E2.3 前置选方案 (a) 变体：**离线 wheelhouse** | 直接根除 pip 断流失败类别；方案 (b) 关 PAC 需改用户系统设置；方案 (c) 换 openai 直连 agent 损失 mini-swe-agent 真实性 |
| D2 | wheelhouse 含 cp312 + cp313 两套 wheel（linux/arm64）+ pip/setuptools/wheel + get-pip.py | 任务镜像两类：python:3.13 系与 ubuntu:24.04 系（系统 py3.12）；get-pip.py 离线 bootstrap 覆盖 pip 被破坏的镜像 |
| D3 | adapter override `perform_task`，安装前 `session.copy_to_container(wheelhouse → /wheelhouse)` | TB `AbstractInstalledAgent` 只复制单个安装脚本文件；`copy_to_container` 支持目录（tar + put_archive），已核实源码 |
| D4 | 安装脚本离线优先（`--no-index --find-links /wheelhouse`），`/wheelhouse` 缺失时回退清华镜像 | 保持 fail-fast 语义；兼容无 wheelhouse 的环境 |
| D5 | **控制臂 LLM 流量走宿主中继** `eval/deepseek_relay.mjs`（HTTP→HTTPS 哑转发，0.0.0.0:8899） | 新发现：colima VM→api.deepseek.com 间歇性断流（SSL EOF，时段性，07-27 的 7897 代理路径已失效）；宿主→DeepSeek 稳定；容器→宿主（host.docker.internal）恒可达。中继不改写 body、无注入，双臂网络路径同为容器→宿主，A/B 差异仍仅限经验注入 |
| D6 | 中继用 HTTP（非 HTTPS）监听 | TCP 哑转发会破坏 TLS SNI/证书主机名校验；HTTP→HTTPS 反代使客户端证书校验在宿主侧完成。本地信任边界内可接受（与 /stats 无鉴权同级） |

## 3. 环境事实变更（与 07-24/27 记录冲突，以此为准）

- **7897 代理已从容器侧失效**（`host.docker.internal:7897` connection refused）；宿主 PAC 状态随时间变化。
- colima VM→api.deepseek.com 直连**间歇性**可用（同一镜像不同时段 401 vs SSL EOF）；不可用时段内重试 4 分钟全败。
- 宿主→DeepSeek 始终正常（E1 harness 以来一贯）。
- 结论：容器内一切外网依赖要么离线化（wheelhouse），要么走宿主中继/8789。

## 4. 实现清单

| 文件 | 变更 |
|---|---|
| `eval/wheelhouse/`（gitignored） | 96 个 wheel / 178MB：mini-swe-agent 2.4.6 全依赖 cp312+cp313、pip/setuptools/wheel、get-pip.py |
| `eval/tb_agents/mini_swe_agent_proxy.py` | +`perform_task` 复制 wheelhouse；wheelhouse 缺失时 warning + 网络回退 |
| `eval/tb_agents/mini-swe-setup.sh.j2` | 离线优先安装；apt 仅在 pip 不可用时执行；get-pip.py 离线 bootstrap 优先 |
| `eval/deepseek_relay.mjs`（新增） | HTTP→HTTPS 中继，0.0.0.0:8899 → api.deepseek.com，无依赖 Node 脚本 |
| `packages/agent-server/.gitignore` | +`eval/wheelhouse/` |

## 5. 验证

目标场景：控制臂 blind-maze-explorer-5x5（07-27 冒烟中 pip IncompleteRead 安装失败的那个任务）。

- 离线安装：秒级 `INSTALL_SUCCESS`，无 FATAL、无 IncompleteRead（对比：之前 35 分钟安装重试后失败）；
- 经中继：`mini` 真实运行 **32 步，0 连接错误**（`results/tb-smoke-wheelhouse-20260728/control5-relay/`）；
- `is_resolved=None / agent_timeout` 是人为 300s agent 超时（验证只需证明 agent 真实运行），非 harness 故障；
- 测试回归：24 文件 / 252 vitest 全绿。

过程记录（弯路）：复跑①②误将宿主 `unset proxy` 规则套用到 tb run（容器失去代理透传）；复跑③④证明 VM 直连间歇性失效；最终落地中继方案（D5）。

## 6. E2.3 全量启动条件（均已就绪）与运行方式

- 控制臂：`OPENAI_BASE_URL=http://host.docker.internal:8899/v1`（中继需先启动：`node eval/deepseek_relay.mjs`）
- 实验臂：`OPENAI_BASE_URL=http://host.docker.internal:8789/v1`（评估实例 8789 需先启动，`HOST=0.0.0.0`）
- 宿主环境：`unset HTTPS_PROXY HTTP_PROXY ...`；`OPENAI_API_KEY=$DEEPSEEK_API_KEY`（来自 `packages/agent-server/.env`）
- Ubuntu 系任务（apt 依赖外网）仍可能受 VM 断流影响——全量跑时记录为环境失败类别，不计入 agent 能力对照

Refer Spec：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2 任务书）；` design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md`（E2 决策记录 §8 返工与复验）；` design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 里程碑任务书）
