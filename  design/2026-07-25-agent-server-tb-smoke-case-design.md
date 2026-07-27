# Agent-Server E2：Terminal-Bench 冒烟用例设计

日期：2026-07-25
关联：` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2 任务书）；` design/2026-07-25-agent-server-e2-acceptance-report.md`（返工清单第 3 条：重选 5 任务）
任务源：`packages/agent-server/eval/tb_tasks/`（terminal-bench-core 本地缓存）

---

## 1. 总体设计

**目标**：用 5 个多样化轻量任务做双臂 A/B 冒烟——控制臂（agent → DeepSeek 直连）vs 实验臂（agent → agent-server:8789 → DeepSeek），回答"经验注入是否无害/有益"。

**选择原则**（吸取 broken-python 教训）：
1. 镜像内 pip 可用（入选前先 `docker run --rm <image> pip3 --version` 验证）；
2. 类别覆盖 ≥2（本集覆盖 4 类：交互操作 / 逻辑推理 / 系统管理 / 文本处理）；
3. 轻量（单任务 agent 超时上限均 900s，官方难度 easy）；
4. 判分确定性（全部 pytest parser + run-tests.sh，非 LLM 裁判）。

**双臂方法**：同一 agent（mini-swe-agent，经 `MiniSweAgentProxy` adapter）、同一模型（`deepseek-v4-flash`）、同一任务集；唯一差异是 `OPENAI_BASE_URL`（控制臂 `https://api.deepseek.com/v1` / 实验臂 `http://host.docker.internal:8789/v1`）。主指标 = 通过率（is_resolved）；token/耗时仅参考（E1 验收方法论）。

---

## 2. 用例明细

### TC-1 blind-maze-explorer-5x5（盲迷宫探索）

- **内容**：agent 被放入 5x5 盲迷宫的起点 S（位置未知），通过 `move N/S/E/W`（支持 `&` 批命令）探索，响应只有 hit wall / moved / reached exit；目标是完整探索并绘制地图、找到出口 E。
- **类别**：games（交互操作）。tags: maze / exploration / mapping / algorithms。
- **测试目的**：多轮交互中的**状态记忆与空间推理**——agent 必须维护内部地图（撞墙信息、已访问格），是最考验"长程状态跟踪"的用例；A/B 中用于观察经验注入是否干扰长上下文任务。
- **测试方法**：`tb run --task-id blind-maze-explorer-5x5`；容器内跑 mini-swe-agent；判分 `run-tests.sh` + pytest（校验地图完整性与出口发现）；agent 超时 900s。

### TC-2 assign-seats（圆桌座位约束求解）

- **内容**：6 位客人（Alice/Bob/Charlie/David/Ethan/Frankie）围圆桌就座，偏好约束分散在 pickle(.pkl)、base64(.b64) 和纯文本文件中；先解码约束，再解 CSP，回答"Charlie 可以坐在哪两人之间"，全部可能邻居对按字母序写入 `/app/results.txt`。
- **类别**：algorithms（逻辑推理）。tags: csp。
- **测试目的**：**多格式信息提取 + 约束求解**——先工程（解码 pkl/b64）后推理（CSP 枚举）；A/B 中考察注入对纯推理任务的干扰。
- **测试方法**：同上 tb run；判分 pytest 校验 results.txt 中邻居对集合与标准答案完全一致；超时 900s。

### TC-3 ancient-puzzle（文物密码破译）

- **内容**：考古情境——石板象形文字 + 多条加密卷轴 + 密封容器；线索（映射表/权重/解码说明）散落各处，需拼接出正确"咒语"发给 `http://decryptor:8090` 解密服务，把最终消息写入 `/app/results.txt`（不得改动其他文件）。
- **类别**：file-operations（解谜/数据处理）。tags: puzzle / data-processing / tools / binary-execution / games。
- **测试目的**：**多步骤工具链组合**（文件勘察 → 线索关联 → 编码转换 → HTTP 调用容器内服务）；是 5 例中链路最长的一题，考察 agent 的任务分解能力。
- **测试方法**：同上 tb run；判分 pytest 校验 results.txt 内容与其他文件未被改动；超时 900s（专家预估 30min / 新手 60min）。

### TC-4 acl-permissions-inheritance（Linux ACL 权限继承）

- **内容**：创建 `/srv/shared`：research 组所有 + setgid（2770）；配置 ACL——research 组与 alice/bob 用户 rwx（当前+default 双域）、其他人无权限、mask 正确；保证 alice/bob 所建文件互相可访问、权限被子目录继承、组外用户不可访问；**不得创建任何文件**（测试自行验证继承）。
- **类别**：系统管理（Linux 权限体系）。
- **测试目的**：**精确系统知识**——setgid、ACL default 域、mask 语义都是易错点；考察模型对 Linux 权限模型的掌握，几乎无探索空间（对就是对）。
- **测试方法**：同上 tb run；判分 run-tests.sh + pytest 逐项验证 ACL/setgid/mask/继承行为与"目录内无文件"约束；超时 900s。

### TC-5 analyze-access-logs（访问日志统计分析）

- **内容**：分析 `/app/access_log`（nginx 风格），生成 `/app/report.txt`：① `Total requests: <n>` ② `Unique IP addresses: <n>` ③ `Top 3 URLs:` 及三行 `  <url>: <count>` ④ `404 errors: <n>`（格式精确到行）。
- **类别**：data-science（文本处理/数据分析）。
- **测试目的**：**文本处理与格式遵从**——统计正确性 + 输出格式的逐字符合（缩进、冒号、顺序）；是最"例行"的用例，作为基准参照（预期两臂都过）。
- **测试方法**：同上 tb run；判分 pytest 逐字段校验 report.txt；超时 900s（预估 40s 完成）。

## 3. 运行与判读

**运行**（双臂各一遍，并发 1）：

```bash
# 控制臂
OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=<key> NO_PROXY='*' \
eval/.venv/bin/tb run --dataset-path eval/tb_tasks \
  --agent-import-path tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
  -m openai/deepseek-v4-flash \
  --task-id blind-maze-explorer-5x5 --task-id assign-seats --task-id ancient-puzzle \
  --task-id acl-permissions-inheritance --task-id analyze-access-logs \
  --n-concurrent 1 --no-upload-results --output-path eval/results/<run>/control

# 实验臂：仅 OPENAI_BASE_URL 换 http://host.docker.internal:8789/v1、key 换 dummy
```

**判读规则**：
1. 主指标：两臂各任务的 `is_resolved`（run-tests.sh + pytest 判分）；
2. harness 健康：agent 必须实际运行（total tokens > 0）；`parse_error`/0 tokens 计 harness 故障而非任务失败（验收报告判例）；
3. token/耗时差异只作参考（轨迹方差 >> 注入开销）；
4. 单任务失败需看 agent.cast 轨迹归类：模型能力 / 注入干扰 / 环境问题。

**预期信号**：TC-5 最易（基准参照）；TC-1/TC-3 最能暴露长链路能力差异；TC-4 为知识点判定（二值）；TC-2 居中。
