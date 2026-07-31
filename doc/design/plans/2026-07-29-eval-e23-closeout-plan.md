# E 评估里程碑：spec 符合性完整复盘 + 剩余工作计划

日期：2026-07-29
依据 spec：` design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 总任务书）、` design/2026-07-24-agent-server-e2-terminal-bench-tasks.md`（E2 任务书）

## 一、Spec 符合性审计（结论：未完成，E2.3 全量/E3/E4 未做，另有 4 处合规缺口）

### 子任务对照

| Spec 项 | 状态 | 证据 |
|---|---|---|
| E0 评估实例+接线冒烟 | ✅ 完成 | 决策记录齐全；验收通过 |
| E1 A/B harness 脚手架 | ✅ 完成 | kimi 验收通过（smoke-02 双臂 5/5） |
| E2.0 三项探针 | ✅ 完成 | 探针全过，有记录 |
| E2.1 adapter | ✅ 完成 | MiniSweAgentProxy + wheelhouse 扩展 |
| E2.2 5 任务冒烟 | ✅ 完成（返工后复验通过） | 验收报告复验节；4/5 vs 4/5 |
| **E2.3 89 任务全量 A/B** | ❌ **未完成** | 仅 5 任务小规模；spec 验收标准 3（全量报告：双臂通过率/per-task 成本/失败分类）未达成 |
| E2.4 报告与收口 | 🟡 部分 | 决策记录/INDEX/progress/commit 合规 ✓；但全量报告缺失故未收口 |
| **E3 SWE-bench A/B** | ❌ **未完成** | 未启动；前置 colima Rosetta 需用户确认 |
| **E4 飞轮+总报告** | ❌ **未完成** | 依赖 E2+E3；设计文档已备（07-25） |

### 测试基线（spec E2 验收标准 4）

| 项 | 状态 |
|---|---|
| 包级 vitest | ✅ 24 文件 / 252 全绿（今日 3 次实跑） |
| 根 `npm run check` | ✅ 通过（昨日 commit 前实跑） |
| eval/ 脚手架无单测 | ✅ 合规——冒烟代替单测的理由已写入决策记录（E2.1、E2 task book 允许） |

### 成功判据对照（E 总任务书预定义 3 条）

| 判据 | 状态 |
|---|---|
| ① 实验组 ≥ 对照组 | 🟡 小规模成立（4/5=4/5），需全量确认 |
| ② 第 2 轮 > 第 1 轮（飞轮） | ❌ 未验证（E4） |
| ③ 成本与错误分布同报 | 🟡 数据可采（server 侧 session usage），报告未出 |

### 发现的 4 处合规缺口

1. **实验臂 session 归档断档（E1 §3.4 防泄漏）**：tb-smoke5c/5d/5e/5g 四轮实验臂 session 未归档（sessions-archive 均为 0）；`var/eval/sessions/` 已积压 205 个文件，多轮混杂——E4 飞轮要求"轮间归档、进化只读评估库"，必须在 E2.3 全量前清理归档并恢复纪律。
2. **单任务 API 成本未报价（E2.2 spec：报价→用户确认→再进 E2.3）**：TB 框架 total_tokens=0，但 server 侧 session usage 可算——需先从 5 任务数据算出单任务均价 × 89 × 2 报价给用户。
3. **模型口径偏差（E 总任务书写 deepseek-v4-pro，实际用 v4-flash）**：E2 任务书自己写了 flash，属 spec 间不一致；建议维持 flash（成本）并在 E2.4 报告声明。
4. **E2.3 spec 要求的预算上限（超支即停）机制未建**：全量前需预设（如金额或 token 上限 + 检查点）。

## 二、剩余工作计划

### Phase A：E2.3 全量前置（机械动作，~30 分钟）

1. 归档现有 205 个 eval session 到 `eval/results/tb-smoke5-agg-20260729/sessions-archive/`，清空 `var/eval/sessions/`（备份 experience.db 后重置），恢复轮间归档纪律（缺口 1）
2. `./eval/inject-proxy-into-tests.sh`（无参数 = 全部 tb_tasks/*）
3. 从 5 任务 server 侧 usage 数据计算单任务均价 → 89×2 报价（缺口 2）
4. 预拉镜像：扫描 79 个 tb_tasks 的 Dockerfile FROM，缺的一律 daocloud 拉取 + retag
5. 设预算上限机制（缺口 4）：简单做法——每臂跑完一半（45 任务）设检查点，汇总成本向用户报告后再继续

### Phase B：E2.3 全量执行（10-20 小时，双臂顺序）

6. 控制臂 89 任务（n-concurrent 2，经 8899 中继）→ 实验臂 89 任务（经 8789）
7. 实验臂跑完立即归档 session；产出 `summary.json` + 失败分类 + 人工抽看 3 条失败轨迹（spec E2.3）

### Phase C：E2.4 收口（~1 小时）

8. E2 决策记录补全量节（双臂通过率/成本/失败分类/判据①对照）；progress/INDEX 更新；commit

### Phase D：E3 SWE-bench（需用户先拍板 colima Rosetta 重启）

9. 用户确认 → `colima start --vz-rosetta`；`eval/instances-10.txt` 定 10 实例；mini-swe-agent 双臂跑 → swebench 评分链路验证 → 10 实例 A/B 报告（四类齐全）→ 用户拍板是否扩 300

### Phase E：E4 飞轮 + 总报告

10. 实验臂第 1 轮（冷库）→ runDailyEvolution → 第 2 轮（热库）；总报告 ` design/<date>-agent-server-eval-report.md`（判据 ①②③ 全对照）；INDEX/progress 收口

## 三、需要用户决策的点

- **E2.3 全量成本确认**（spec R5 硬性要求）：Phase A 步骤 3 报价后用户确认才启动 Phase B
- **E3 前置**：colima 开 Rosetta 重启（影响生产容器，生产栈 restart=unless-stopped 可自动恢复，昨日已验证）
- **模型口径**：维持 v4-flash（建议）还是切 v4-pro
