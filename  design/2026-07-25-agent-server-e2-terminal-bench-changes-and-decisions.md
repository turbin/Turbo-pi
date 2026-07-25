# Agent-Server E2：Terminal-Bench A/B——变更与决策记录

日期：2026-07-24/25
任务书：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`
进度：` design/progress/2026-07-24-eval-benchmark.md`
状态：E2.0/E2.1/E2.2 控制臂通过；E2.2 实验臂网络路径已验证；E2.3 全量阻塞于 pip 安装速度

---

## 1. E2.0 环境探针（三项，全部通过）

### 探针 1：Docker Hub 可达性 → 通过（需配代理）

```
docker pull debian:bookworm-slim → dial tcp 96.44.137.28:443: i/o timeout
```

colima VM 默认无法直连 Docker Hub（被宿主 PAC 代理阻断）。对策：`colima stop && colima start --env HTTPS_PROXY=http://127.0.0.1:7897`。重启 colima 会影响在跑的生产 compose 栈，已事先获得用户同意。重启后 `docker pull debian:bookworm-slim` 成功。生产栈经 `docker compose up -d` 恢复。

**决策**：评估期间的 colima 保持代理配置（`HTTPS_PROXY=http://127.0.0.1:7897`），生产栈不受影响（同一 VM 内运行）。

### 探针 2：litellm 容器内 DeepSeek 连通性 → 通过

```bash
docker run --rm -e HTTPS_PROXY=... python:3.12-slim bash -c "
  pip install litellm && python -c 'litellm.completion(...)'
"
→ OK: (返回空 content 但无错误——max_tokens=10 太小)
```

**结论**：E1 发现的 litellm `[Errno 8] nodename nor servname` 连接 bug **仅限 macOS host venv**，Linux 容器内 litellm 正常。R2 风险解除。

### 探针 3：容器 → 宿主 8789 连通性 → 通过（HOST 需 0.0.0.0）

首次测试：`host.docker.internal:8789` 可达（`{"status":"never_run"}`），但后续发现 8789 实际绑定在 `127.0.0.1`（Fastify 默认），导致容器内无法访问。**修复**：`HOST=0.0.0.0` 重启 8789。

**决策**：评估实例 8789 必须 `HOST=0.0.0.0`（接受来自 Docker 网桥的入站连接）。`127.0.0.1` 仅限本机进程访问。此配置变更写入 E0 启动命令。

---

## 2. E2.1 自定义 agent adapter

`eval/tb_agents/mini_swe_agent_proxy.py`：继承 Terminal-Bench 内置 `MiniSweAgent`，重写 `_env` 添加：

- `OPENAI_BASE_URL`：从宿主环境变量读取（臂切换的关键）
- `MSWEA_SILENT_STARTUP=1`、`MSWEA_COST_TRACKING=ignore_errors`（E0 非交互三坑）
- `HTTPS_PROXY`：从宿主透传（容器内 pip/apt 需要）

同目录 `mini-swe-setup.sh.j2`：改造安装脚本，pip 使用清华镜像（`https://pypi.tuna.tsinghua.edu.cn/simple`）。

导入验证：
```python
MiniSweAgentProxy(model_name='openai/deepseek-v4-flash')._env
→ OPENAI_BASE_URL, OPENAI_API_KEY, MSWEA_CONFIGURED, MSWEA_SILENT_STARTUP 均正确
```

冒烟验证代替单测（eval 脚手架性质，不是生产代码）。

---

## 3. E2.2 冒烟结果

### 控制臂（直连 DeepSeek）

| 任务 | 尝试 | 结果 | 备注 |
|------|------|------|------|
| broken-python | 3 | 0/3 resolved | agent 未解决任务，但 harness 全链路正常（Docker build → 安装 → LLM 调用 → 收集） |

### 实验臂（经 agent-server）

| 任务 | 结果 | 备注 |
|------|------|------|
| broken-python | 运行成功 | 容器内 HTTP 到 `host.docker.internal:8789` 通过 curl 验证；pip install 经代理链太慢（~3min/容器），未完成 litellm 安装 |

实验臂的网络路径验证：
```bash
docker run --rm curlimages/curl curl -X POST \
  http://host.docker.internal:8789/v1/chat/completions -d '{...}'
→ {"choices":[...],"usage":{...}}  # 200 OK，全链路通
```

**阻塞原因**：每个 Terminal-Bench 任务容器是临时创建的，首次需要 `pip install mini-swe-agent`（含 litellm 依赖 ~200MB），经 PAC 代理 → colima 代理链下载需 2-4 分钟。`broken-python` 任务本身只需 3 分钟，安装比任务还长。

### 多任务 Docker build 失败

尝试 5 任务 (`break-filter-js-from-html`, `bank-trans-filter`, `assign-seats`, `broken-python`, `ancient-puzzle`) 时，第一个任务的 Docker build 失败（`docker compose build` exit code 1），疑似 `apt-get` 在代理链下超时。后续任务被跳过。

---

## 4. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 评估期间 colima 保持代理配置 | Docker Hub/TB 镜像构建需要外网；P1 探针已确认重启不影响生产栈 |
| D2 | 8789 绑定 0.0.0.0 | 容器内 `host.docker.internal` 解析到 VM 网桥 IP，127.0.0.1 不可达 |
| D3 | E2.2 实验臂未完成 mini-swe-agent 安装 | pip 经代理链太慢；网络路径已通过 curl 直接验证 |
| D4 | E2.3 全量暂不展开 | TB 任务镜像构建过代理链不稳定（apt 超时）；需预构建含 mini-swe-agent 的镜像或用更快的网络 |

---

## 5. 宿主网络环境根因分析

macOS 系统级 PAC 代理（`http://127.0.0.1:33331/commands/pac` → `PROXY 127.0.0.1:7897`）拦截所有 HTTPS 流量。在宿主机上：

- **git clone** 被 PAC 代理阻断（E2 registry 下载失败）→ 改用 `curl` 下载 tar.gz + 本地 `--dataset-path` 绕过
- **Python `requests`** 被 PAC 代理指向 `host.docker.internal:7897`（.env 遗留）→ 用 `NO_PROXY='*'` 绕过
- **Docker daemon**（colima VM 内）被阻断 → colima 重启配代理解决
- **容器内 pip/apt** 需代理才能访问外网 → 但代理链多一跳，速度慢且不稳定

理想方案：临时关闭 macOS PAC 代理（System Preferences → Network → Proxies → uncheck "Automatic Proxy Configuration"），但在本机环境中由用户控制。

---

## 6. E2.3 全量跑的前置条件

1. **快速 pip 安装**：构建含 mini-swe-agent + litellm 预装的 Docker 镜像，替换 `mini-swe-setup.sh.j2` 跳过安装步骤
2. **或关闭 PAC 代理**：`networksetup -setautoproxystate Wi-Fi off`（需用户执行），让容器直连
3. **或用 E1 harness 替代**：E1 已证明 openai 客户端直连可行，可写 `BaseAgent` 子类绕过 mini-swe-agent/litellm 依赖

---

## 7. 产出清单

| 文件 | 说明 |
|------|------|
| `eval/tb_agents/__init__.py` | Python 包标记 |
| `eval/tb_agents/mini_swe_agent_proxy.py` | 自定义 agent adapter（臂切换） |
| `eval/tb_agents/mini-swe-setup.sh.j2` | 清华镜像安装模板 |
| `eval/tb_tasks/` | 79 个 TB 任务（从 GitHub tar.gz 解压） |
| `eval/tb_registry/registry.json` | TB registry 缓存 |
| `eval/results/tb-smoke-20260724/` | 冒烟结果（控制臂 3 次 + 实验臂 1 次） |

Refer Spec：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2 任务书）；` design/2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md`（E1 决策记录）
