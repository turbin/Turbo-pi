# 对话记录：工程架构分析、持续学习机制与稳定性评估

- 日期：2026-07-24
- 参与者：用户 / Kimi Code CLI
- 范围：Turbo-pi monorepo（7 个包）

---

## Q1：读取工程 & 绘制 call graph、架构图、模块划分和职责描述图

**用户请求**：读取工程并绘制 call graph、架构图、模块划分和职责描述图。

**执行过程**：

1. 读取现有 `graphify-diagrams.md`（2026-07-17 旧版，只覆盖 5 个包，已过时）。
2. 并行派出 4 个 explore subagent 分析：`packages/ai`、`packages/agent`、`packages/coding-agent`、`packages/agent-server` + `agent-gateway` + `orchestrator`。
3. 统计各包源码/测试文件数。
4. 重写 `graphify-diagrams.md`（12 个 mermaid 图），并用脚本做 mermaid 语法健全性检查（12 块全部通过）。

**产出**：`graphify-diagrams.md`，含四类内容：

- **架构图（§1）**：四层结构——模型接入层（pi-ai）→ 运行时层（pi-agent-core）→ 应用层（pi-coding-agent/pi-tui）→ 周边系统（orchestrator、agent-server、agent-gateway）。
- **模块划分图（§2）**：5 张包内模块图（pi-ai、pi-agent-core、coding-agent、agent-server 在线+离线闭环、agent-gateway）。
- **Call Graph（§3）**：跨包调用图 + 4 条核心链路：
  1. LLM 流式调用：`Models.stream → lazyStream → resolveProviderAuth → provider 工厂 → 协议实现 → SSE 事件`
  2. Agent 双层循环：steering 内层 / follow-up 外层 + 工具执行编排
  3. pi CLI 启动与对话：`main.ts → createAgentSession → 三模式分发 → AgentEvent → UI 渲染`
  4. 经验回放在线管线：`检索(FTS bm25→cosine) → 注入 → gateway 质量门控 → 云升级 → session 落盘 → 离线进化回填`
- **模块职责描述（§4）**：包级职责表 + 15 个关键文件速查表。附工程指标（§5）。

**关键发现**：

- `Agent` 与 `AgentHarness` 是平级替代而非上下层，都落点到同一个 `runAgentLoop`。
- agent-server 与 pi-coding-agent 代码零耦合，纯配置级接入（provider baseUrl 指向 :8788）。
- orchestrator 不用进程内 SDK，而是 spawn pi 的 `--mode rpc` 子进程。

---

## Q2：这套框架可以支持持续学习吗？是修改模型 prefill 实现的记忆还是其他机制？

**回答要点**：支持持续学习，但不是改模型、也不是改 prefill，而是「体外记忆」。

用小孩能懂的话：LLM 是「记性只有 5 分钟的天才小孩」，不能开颅（改权重）也不能打记忆针（prefill 编辑）。框架的办法是给小孩一个**笔记本**：

1. **每次考试前翻笔记（在线回放）**：retrieval（FTS5 bm25 top-24 → cosine 重排 top-8）从 SQLite 经验库找相关笔记，injection 把笔记贴进 prompt。笔记四种类型：
   - EVIDENCE：具体案例（「上次这题这么错的」）
   - ABILITY：口诀 + 避坑（Method/Guard）
   - SKILL：技能清单（进 system prompt 的 `<available_skills>`）
   - SOP：标准流程（变成 tool schema）
2. **每天晚上老师整理笔记（离线进化）**：session 落盘（pi 原生 JSONL）→ ETL 拆句 → Python 管线提炼（skill_evolution / sop_lifecycle / verification_selection）→ verifier 质量门（≥0.5 才晋升 active）→ 回填经验库。
3. 循环往复：笔记本越来越厚、越来越准，但**小孩的脑子始终没变**。

| 问题 | 答案 |
|---|---|
| 算持续学习吗？ | 算「系统级」持续学习；不算「模型级」（权重未动） |
| 是改 prefill 吗？ | 注入文字随 prompt 进 prefill，但每次请求临时贴入，请求结束即失效；记忆活在 SQLite |
| 机制学名 | RAG + 经验蒸馏 + 质量门控晋升 = 经验回放（experience replay） |

**优势**：不会灾难性遗忘（笔记可撕）；换模型笔记仍有效；有 DLP/verifier 门控。
**代价**：受上下文窗口限制，检索质量决定上限；经验不会变成「肌肉记忆」。

补充：pi-coding-agent 的 skills / AGENTS.md / prompt 模板也是同一思想，全仓库无任何改模型权重的代码。

---

## Q3：目前框架稳定了吗？已经测试了还是没有？

**实测（2026-07-24 当场运行）**：

| 包 | 结果 |
|---|---|
| agent-server | 21 个测试文件、225 个测试全部通过（8.7s，Node 25.9.0 工具链） |
| agent-gateway | 167 个测试全部通过（7.9s，uv + pytest） |

**验收历史（`doc/design/` 记录）**：

| 阶段 | 结果 |
|---|---|
| agent-gateway V1（07-18） | A01~A11 现场验证全部通过（167 测试） |
| agent-server P1（07-21） | 在线回放管线 live E2E 9 项全 PASS（116 测试） |
| agent-server P2（07-22） | 流式落盘/dormant 重打分/benchmark live E2E 8 项全 PASS |
| agent-server P3（07-22） | 初验有条件不通过（缺测试）→ 返工 → 复验通过 |
| C 方案 ABILITY 提炼（07-23） | 213 测试全绿，验收通过（附 2 项偏差记录） |

**三个「还不稳定」的点**：

1. **学习闭环数据面未被真实触发**：C3 live 验证中离线管线产出的经验卡全部 Workflow、零 Method/Guard——代码路由正确，但 MockLLM 是关键词门控，真实 teacher LLM（`LLM_BASE_URL` + `TEACHER_MODEL`）未正式上岗。
2. **C 方案 5 项设计决策全部「暂定待迭代」**，ABILITY 提炼层未定型。
3. **验证偏差**：C3 场景 2 用临时注入检测服务（8792 端口直连）而非完整 server 代理路径（已记录并接受）。

**结论**：骨架（检索→注入→落盘→离线提炼→晋升回填）每根骨头都有测试、有验收、当下全绿，代码级稳定；但「越用越聪明」的完整闭环还没用真实 LLM 老师在真实数据上跑过一轮——「考试全过的实习生，不是上过班的老手」。下一步建议：接真实 teacher LLM，观察 ABILITY 实际产量与注入效果。

---

## 本次会话修改的文件

- `graphify-diagrams.md`（重写，2026-07-17 旧版 → 2026-07-24 新版）
- `doc/conversations/2026-07-24-architecture-and-continual-learning-qa.md`（本文件）

未做任何代码改动；未执行 git 提交。
