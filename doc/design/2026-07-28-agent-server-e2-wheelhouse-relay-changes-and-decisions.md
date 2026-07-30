# Agent-Server E2.3 前置条件：离线 wheelhouse + 宿主中继——变更与决策记录

日期：2026-07-28
任务书：`doc/design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2.3 前置条件三方案）
进度：`doc/design/progress/2026-07-24-eval-benchmark.md`
状态：**已完成（E2.3 前置条件闭环，可启动全量）**

---

## 1. 背景

E2.2 复验（同日，见 `doc/design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md` §8.4）确认：冒烟头号失败模式是容器内 pip 经代理链下载断流（IncompleteRead）。E2.3 全量（89 任务双臂）前必须解决安装稳定性。

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

## 7. 追加：小规模跑暴露的四类环境失败与对策（2026-07-28 晚）

首轮 5 任务双臂（双臂并行）全军覆没（0/5 vs 0/5），逐项根因与对策：

| 失败 | 根因 | 对策（已落地） |
|---|---|---|
| ancient-puzzle compose up 失败 | ①双臂并行时 decryptor 服务争绑宿主 **8090 端口**；②decryptor 镜像 `python:3.13-slim-bookworm` 未缓存且 daemon 拉取走死代理 | 双臂**顺序执行**（D7）；colima 重启代理指向 8898（D8） |
| acl/ubuntu 系 build 失败 | build 期 apt/拉取依赖 VM 外网 | buildkit 自动把宿主 CLI 的 `HTTP(S)_PROXY` 注入 build args（D9）；`ghcr .../ubuntu-24-04:latest` 经 8898 预拉取 |
| test_timeout（assign-seats/blind-maze 双臂） | TB `run-tests.sh` 自身需外网：apt update + curl 装 uv + uv pip 装 pytest；deb.debian.org 直连 15kB/s | `eval/inject-proxy-into-tests.sh` 幂等注入（D10）：代理环境变量 + apt 改清华镜像 + UV/PIP index 清华镜像。**只改包获取路径，不改任何断言**；tb_tasks 本地缓存 gitignored |
| analyze-access-logs parse_error | ubuntu 镜像内 agent 安装走 apt（VM 断流） | 安装脚本走 adapter 透传的 `HTTPS_PROXY=8898`（D9） |

| # | 决策 | 理由 |
|---|---|---|
| D7 | 双臂顺序执行，禁止并行 | TB 部分任务（如 ancient-puzzle）在 compose 中硬编码宿主端口绑定，双臂并行必然冲突 |
| D8 | colima 重启，`--env HTTP(S)_PROXY=http://192.168.5.2:8898`（用户已批准） | 07-27 配置的 daemon 代理 7897 已死，镜像拉取全失败；生产栈 `restart=unless-stopped` 自动恢复。Docker Hub 经 daocloud 镜像 + retag 补充（宿主直连 Docker Hub 不通，8898 无法代理不可达上游） |
| D9 | tb 进程导出 `HTTP(S)_PROXY=http://host.docker.internal:8898` | build 期 buildkit 自动注入为 build args；agent 安装期经 adapter `_env` 透传进容器 |
| D10 | 测试期网络改造注入 run-tests.sh（代理 + 清华 apt/pypi 镜像），与断言完全隔离 | 测试超时根因是 pytest/uv 安装，不是测试本身；注入脚本幂等、带标记、可批量应用于全量 89 任务 |
| D11 | 新增 `eval/host_forward_proxy.mjs`（CONNECT + 普通 HTTP，0.0.0.0:8898） | VM→外网间歇断流的通用解法：容器一切非 LLM 外网流量走宿主；与 8899 LLM 中继分工明确 |

补跑结果（`results/tb-smoke5c-20260728/`）：控制臂 assign-seats（55s）与 blind-maze（2m12s，此前从未跑起来）双双 resolved——test 期注入生效。实验臂整轮撞在 colima 重启窗口（全部 unknown_agent_error），数据作废重跑。

## 8. 追加②：ubuntu 任务三连修与 5 任务最终对照（2026-07-29 凌晨）

ubuntu 系任务（acl-permissions-inheritance、analyze-access-logs）连续暴露三层问题，逐层修复：

1. **apt 挂起**：ubuntu arm64 源是 `ports.ubuntu.com`（ubuntu-ports），镜像重写漏了它 → 补 `ports.ubuntu.com → mirrors.tuna.tsinghua.edu.cn`（安装脚本与测试注入同步）。
2. **PEP 668**：ubuntu-24-04 系统 Python 有 `EXTERNALLY-MANAGED`，get-pip.py/pip install 被拒 → 检测后加 `--break-system-packages`；同时**调整安装流程：python3 在但 pip 缺时直接离线 get-pip.py，apt 仅在 python3 本身缺失时才用**——ubuntu 任务安装完全不依赖外网。
3. **LLM 调用被代理兜圈**：安装脚本补导小写 `http_proxy` 后，http:// 的 LLM 请求改走 8898 代理，代理在宿主侧解析不了 `host.docker.internal` → 双管齐下：安装脚本导出 `NO_PROXY=host.docker.internal,127.0.0.1,localhost`；正向代理内置 `host.docker.internal→127.0.0.1` 映射。此前 python 任务未踩中是因为容器内只有大写 `HTTPS_PROXY`，httpx 对 http:// URL 不查它。

**5 任务双臂最终对照**（每任务每臂取有效 trial，原始数据 `results/tb-smoke5{c,d,e,g}-2026072{8,9}/`）：

| 任务 | 控制臂（8899 中继） | 实验臂（8789） |
|---|---|---|
| assign-seats | ✅ resolved（55s） | ✅ resolved（58s） |
| blind-maze-explorer-5x5 | ✅ resolved（2m12s） | ✅ resolved（2m47s） |
| ancient-puzzle | ❌ agent 运行 6m22s 未解出 | ❌ agent 运行满 20m 未解出 |
| acl-permissions-inheritance | ✅ resolved（mini 9 步） | ✅ resolved |
| analyze-access-logs | ✅ resolved | ✅ resolved（mini 6 步） |
| **合计** | **4/5** | **4/5** |

所有 resolved 均经 pytest 断言验证；ubuntu 任务全链路（离线 get-pip → mini → 测试）实测通过。成功判据①“实验组 ≥ 对照组”成立（4/5 = 4/5）；唯一失败 ancient-puzzle 双臂 agent 均真实运行未解出，属任务难度，有效对照。

环境稳定性结论：六类环境失败（安装/LLM/测试/拉取/端口/代理兜圈）全部有机制性对策，**E2.3 全量 89 任务的 infra 就绪**。全量前需：①`inject-proxy-into-tests.sh` 跑全部任务目录；②核对全量任务清单的宿主端口冲突（双臂顺序执行已规避臂间冲突）；③镜像按需经 daocloud 预拉取。

## 9. E2.3 全量前置（Phase A，2026-07-29）

按 07-29 spec 复盘（4 处合规缺口）执行：

1. **归档纪律恢复**：205 个混杂 session 归档至 `eval/results/tb-smoke5-agg-20260729/sessions-archive/`，`var/eval/sessions/` 已清空；`experience.db` 备份为 `.bak-20260729`。
2. **测试注入全覆盖**：`inject-proxy-into-tests.sh` 默认参数 bug 修复（`$@` 空数组展开），78/78 run-tests.sh 已注入。
3. **成本报价（v4-flash 官方价 $0.14/1M in、$0.28/1M out）**：E2.2 实验臂实测 ~1.06M in + 21k out per-trial（含重任务；中位 trial 显著更低）。79 任务 × 双臂 = 158 trial，**预估 $7–30**（缓存命中率高时偏下限，全 cache-miss 上限 $28）。
4. **任务集口径**：本地 tb_tasks 缓存为 **79 任务**（tar.gz 快照），非 spec 所述 89——全量报告按 79 口径并声明。
5. **预算检查点**：每臂分两半跑（前 40 / 后 39），半程汇总成本向用户报告后再继续。
6. 预拉镜像：docker.io 6 个 + python@sha256 digest 走 daocloud + retag；ghcr `python-3-13:latest` 直连。风险项：`broken-networking`、`build-linux-kernel-qemu` 为 linux/amd64 镜像（无 Rosetta，可能失败，计入环境失败）。

Refer Spec：`doc/design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2 任务书）；`doc/design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md`（E2 决策记录 §8 返工与复验）；`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 里程碑任务书）
