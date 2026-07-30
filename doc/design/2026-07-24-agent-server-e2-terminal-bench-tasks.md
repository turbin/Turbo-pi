# Agent-Server E2：Terminal-Bench A/B 任务书

日期：2026-07-24
状态：**已立项（2026-07-24）**
上游：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 里程碑总任务书 E2 节）；E1 已完成（`doc/design/2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md`，kimi 验收通过）
进度跟踪：`doc/design/progress/2026-07-24-eval-benchmark.md`

目标：用 Terminal-Bench 2.0（89 任务）跑 A/B 对照——对照臂直连 DeepSeek，实验臂经 agent-server:8789（注入开）——产出第一份真实 benchmark 对照数据。

**通用约束**：见 `doc/design/2026-07-22-agent-server-p3-candidate-tasks.md`。测试要求见工程根 CLAUDE.md（TDD 强制——本任务新增的生产代码必须带测试；eval/ 下的脚手架脚本按其性质以冒烟验证代替单测的，需在决策记录说明理由）。

**方法论（E1 验收结论，必须遵守）**：以**通过率为主指标**；token 对比仅作参考（轨迹方差 >> 注入开销，5 任务级样本不可归因）。

---

## 已查证的接口事实（执行前不必重查）

| 事实 | 出处 |
|---|---|
| 自定义 agent 接口：继承 `BaseAgent`，实现 `perform_task(instruction, session, logging_dir) -> AgentResult`；CLI 用 `--agent-import-path` 加载 | `terminal_bench/agents/base_agent.py` |
| 内置 `MiniSweAgent`：把 mini-swe-agent 装进任务容器（apt+pip），`_env` 只透传 API key，**不透传 OPENAI_BASE_URL** → 必须子类化 | `installed_agents/mini_swe_agent/mini_swe_agent.py` |
| 安装脚本按"子类文件所在目录"查找模板 → 自定义脚本放子类同目录即可覆盖 | `abstract_installed_agent.py:_get_templated_script_path` |
| `_env` 经 `setup-env.sh` 注入容器（export 形式），agent 运行前 source | 同上 `perform_task` |
| 子集运行：`tb run --task-id <id或glob>`；数据集 `-d terminal-bench-core`（89 任务） | `tb run --help` |
| mini 容器内运行参数已由内置 agent 处理（`-y --exit-immediately`、`MSWEA_CONFIGURED`）；需补 `MSWEA_SILENT_STARTUP` / `MSWEA_COST_TRACKING=ignore_errors`（E0 三坑） | E0 决策记录 §4 |

## 风险与对策（全部有实证出处）

| # | 风险 | 对策 | 出处 |
|---|---|---|---|
| R1 | **Docker Hub 从 colima VM 不可达**——tb 任务镜像构建拉 base image 会失败 | E2.0 先探针；必要时给 colima docker daemon 配代理（`colima stop && colima start --env HTTPS_PROXY=http://127.0.0.1:7897`，**需用户确认**，重启影响生产容器） | N2 决策记录"构建环境"节 |
| R2 | **litellm bug**（E1 发现，macOS host venv 无法连 DeepSeek） | 容器内是 Linux——E2.0 探针验证 litellm 在容器内可用；若同样失败，回退方案：用 E1 harness.py 的 openai 直连 agent 写自定义 `BaseAgent`（不依赖 litellm） | E1 决策记录 §1 |
| R3 | 容器 → 宿主 8789 连通性（colima 的 host.docker.internal 支持情况未验证） | E2.0 探针；不通则试 VM 网关 IP（容器内 `ip route` 查 default gateway） | — |
| R4 | 容器内 pip 装 mini-swe-agent 需要 PyPI 访问 | 自定义安装脚本用清华镜像 + `HTTPS_PROXY=http://host.docker.internal:7897`（或 R3 确定的网关地址） | N2/E0 经验 |
| R5 | API 成本（89 任务 × 2 臂 × 每任务数十次调用） | 先 5 任务冒烟报价，**用户确认后**再跑全量；`tb run` 并发 2 | 任务书总则 |

## E2.0：环境探针（三项，全部通过才能继续）

1. **Docker 拉取探针**：`docker pull debian:bookworm-slim`（tb 任务镜像典型 base）。失败 → 按 R1 配 daemon 代理（先问用户）。
2. **litellm 容器探针**：`docker run --rm python:3.12-slim sh -c "pip install -q litellm && python -c \"...\""`——在容器内用 litellm 调 DeepSeek（带 HTTPS_PROXY）一次 chat。验证 R2 是否仅限 macOS host。
3. **宿主连通探针**：起 8789（命令见 progress 文件），`docker run --rm curlimages/curl sh -c "curl -s -m 5 http://host.docker.internal:8789/api/evolution/status"`；不通则改测 `$(docker run --rm debian:bookworm-slim sh -c 'ip route | awk "/default/ {print \$3}"')`。

探针结果逐项记录进决策记录（无论成败）。

## E2.1：自定义 agent `eval/tb_agents/mini_swe_agent_proxy.py`

- 继承 `MiniSweAgent`，重写 `_env`：在父类基础上增加
  - `OPENAI_BASE_URL`（臂切换的关键：对照 `https://api.deepseek.com/v1` / 实验 `http://host.docker.internal:8789/v1`，R3 探针定案）
  - `MSWEA_SILENT_STARTUP=1`、`MSWEA_COST_TRACKING=ignore_errors`
  - `HTTPS_PROXY`（对照臂 DeepSeek HTTPS + pip 安装需要；值经 env 从宿主传入，不写死）
- 同目录放自定义 `mini-swe-setup.sh.j2`：pip 用清华镜像（`pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple mini-swe-agent`），其余与内置版一致。
- 臂的切换**由宿主环境变量驱动**（adapter 读 `ARM=control|experiment` 或直接读 `OPENAI_BASE_URL`），不写死两套类。
- 冒烟验证代替单测（eval 脚手架性质），在决策记录说明。

## E2.2：5 任务冒烟 A/B

- 任务选择：`tb tasks` 列表中选 5 个轻量任务（避免编译/下载重型任务，记录选择理由）。
- 双臂各跑一遍（串行，并发 1-2）：`tb run -d terminal-bench-core --task-id <5 ids> --agent-import-path eval.tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy -m openai/deepseek-v4-flash`（两臂仅 `OPENAI_BASE_URL`/key 不同）。
- 前置：8789 在跑（progress 文件命令）；评估库清空（E1 遗留：归档混入 E0 session，E2 前 `rm -f var/eval/sessions/*` 并重置 var/eval/experience.db——**重置前备份**）。
- 产出：两臂 pass/fail + 耗时 + 每任务 token（tb 的 AgentResult）落 `eval/results/tb-smoke-<date>/`；**报告单任务 API 成本并提交用户确认后再进 E2.3**。

## E2.3：89 任务全量 A/B（用户确认成本后）

- `tb run -d terminal-bench-core` 全量，双臂，并发 2；预算上限预设（超支即停）。
- 实验臂跑完立即按 E1 §3.4 归档 session（`var/eval/sessions` → `eval/results/tb-<date>/experiment/sessions-archive/`）。
- 产出 `eval/results/tb-<date>/summary.json` + 失败分类（按 tb failure_mode + 人工抽看 3 条失败轨迹）。

## E2.4：报告与收口

- 决策记录 `doc/design/<date>-agent-server-e2-terminal-bench-changes-and-decisions.md`：探针结果、双臂通过率/tokens/成本、失败分类、与成功判据 ①（实验组 ≥ 对照组）的对照、litellm bug 最终处置。
- progress 文件 E2 行更新 + `doc/design/INDEX.md` 同步；提交（conventional 前缀 + COMPLETED/TODO/Refer Spec）。

## 验收标准

1. E2.0 三项探针全部有记录（允许失败但必须有处置路径）。
2. 5 任务冒烟双臂各完成一次（允许任务级失败，harness 本身必须无故障）。
3. 全量 A/B 报告：两臂通过率、per-task 成本、失败分类齐全；token 差异按方法论只作参考。
4. 测试基线不回归：包级 vitest 全绿 + 根 `npm run check` 干净。
5. 决策记录/progress/INDEX 齐全，commit 格式合规。

## token/成本预估

| 阶段 | 预估 |
|---|---|
| E2.0 探针 | ~30k token，API ≈ 0 |
| E2.1 adapter | ~60k token |
| E2.2 冒烟（5×2 任务） | ~40k + API 小样本 |
| E2.3 全量（89×2 任务） | API 为主（待 E2.2 报价） |
