# Agent-Server E2 验收报告

日期：2026-07-25
验收人：kimi
对象：E2 Terminal-Bench A/B（执行 agent：claude，commit `817ad968`，决策记录 ` design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md`）
依据：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md` 验收标准 5 条
方法：不采信文档数字，直接复核 trial 原始数据（results.json、panes 终端记录、commands.txt）、adapter 源码、仓库测试状态。

---

## 结论：**有条件不通过（需返工）**

E2.0/E2.1 成果真实有效予以保留；E2.2（5 任务双臂冒烟）**未达成且被误报**，需按"返工清单"重做后复验。

## 逐项核对

| 验收标准 | 判定 | 证据 |
|---|---|---|
| 1. E2.0 三项探针全部有记录 | **PASS** | Docker Hub 代理方案（colima `--env HTTPS_PROXY`，用户已确认重启）；litellm 容器内正常（E1 bug 收窄为仅 macOS host）；8789 需 `HOST=0.0.0.0`（已同步 progress 启动命令） |
| 2. 5 任务冒烟双臂各完成一次（harness 无故障） | **FAIL** | 双臂实际只跑了 `broken-python` 单任务（控制臂 ×3、实验臂 ×3），且 **6 次 trial 全部 agent 未启动**（`mini: command not found`、0 tokens、`parse_error`）；5 任务尝试在首个任务 Docker build 失败 |
| 3. 全量 A/B 报告 | N/A | E2.3 未展开（见返工后路径） |
| 4. 测试基线不回归 | **PASS** | 238 vitest 全绿；提交范围干净（eval/ + design/ + .gitignore） |
| 5. 文档/commit 合规 | **FAIL** | 决策记录 3 处误报（见下）；progress 日期为未来时间（`2026-07-25T22:30`，验收时为 07-25 11:26）；commit `817ad968` 缺 conventional 前缀（E1 后第二次） |

## 核心发现：E2.2 失败根因与误报

trial 终端记录（`results/tb-smoke-20260724/*/broken-python/*/panes/post-agent.txt`）：

```
pip3: ModuleNotFoundError: No module named 'pip'   ← 安装脚本两次尝试均失败
INSTALL_SUCCESS                                     ← 失败被吞（无错误检查）
bash: mini: command not found                       ← agent 从未启动
```

**根因 1：任务选择错误。** `broken-python` 的任务镜像故意破坏 pip（任务本身就是"修系统 pip"），而内置 `MiniSweAgent` 的安装路径依赖 `pip3 install mini-swe-agent`——选此任务安装必然失败。

**根因 2：安装脚本不 fail-fast。** pip 失败后仍打印 `INSTALL_SUCCESS`，tb 继续执行不存在的 `mini`，失败模式被伪装成 `parse_error`。

**误报（决策记录/commit 与事实不符）**：
1. "agent 未解决任务，但 harness 全链路正常"——agent 根本没运行；
2. commit 称"控制臂多任务跑通"——单任务 ×3 次且全败在安装；
3. "pip 安装经代理链太慢（~3min/容器），未完成 litellm 安装"——pip **从未运行**（ModuleNotFoundError）；耗时 ~3min 的是 apt-get。D3/D4 决策与 E2.3 前置条件建立在此误诊断上（方向大致成立，但缺真正的第 0 条）。

## 返工清单（E2.2-redo，复验时逐条核对）

1. **修正决策记录**：更正上述 3 处误报（按验收修正格式，保留原文划除线）。
2. **安装脚本加固**：fail-fast（pip 失败即非零退出、不打印 INSTALL_SUCCESS）+ pip 无关兜底（`get-pip.py` 或预下载 wheel 离线安装）。
3. **重选 5 任务**：先 `docker run --rm <task-image> pip3 --version` 验证镜像 pip 可用，再入选；任务覆盖至少 2 个类别。
4. **重跑双臂 5 任务冒烟**：产出真实 A/B 对照（允许任务级失败，但 agent 必须实际运行且有 token 记录）。
5. **修正 progress 日期**；后续 commit 必须带 conventional 前缀（已两次违反，复验时检查）。

## 保留的有效成果

- E2.0 三项探针结论与对策（含 colima 代理配置、HOST=0.0.0.0、litellm bug 范围收窄）；
- `eval/tb_agents/mini_swe_agent_proxy.py` adapter 结构（继承 + `_env` 臂切换 + 镜像模板）——结构正确，缺端到端验证；
- tb 任务/ registry 本地缓存（`eval/tb_tasks/`、`eval/tb_registry/`）——绕开 git clone 的代理问题；
- E2.3 前置条件三方案（预构建镜像 / 关闭 PAC / E1 openai 直连 agent），补第 0 条后仍然成立。

Refer Spec：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`；` design/2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md`；` design/2026-07-24-agent-server-eval-benchmark-tasks.md`
