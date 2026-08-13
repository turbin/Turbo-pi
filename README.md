# 经验学习系统（Experience Learning System）

基于本地学生模型 + 经验学习 harness 的办公自动化智能体系统：本地学生模型（Qwen3.5-27B-4bit）在云端教师模型（DeepSeek）少量指导下，通过结构化经验卡的离线蒸馏、在线检索注入与生命周期管理逐步独立——**重复任务升级率趋近 0，新任务升级率低于 20%**。

非目标：token 级 RL 与权重更新；原始轨迹在线回放。

## 总体架构

系统自下而上分为五层：

![模块分层架构图](doc/design/assets/2026-08-13-high-level-design-v2/2.1-arch-layers.png)

| 层 | 职责 |
|---|---|
| L4 运维层 | preflight 指纹门禁、升级率门控、每日快照冻结、Web 监控、issue 登记与回归哨兵——保证系统可观测、批次可重跑、可归因 |
| L3 离线进化层 | 任务级轨迹合成 → ETL 候选池 → 三管线蒸馏 → 双阈值验证 → 晋升/复评/清理——决定哪些经验值得留下 |
| L2 经验层（agent-server） | bm25 检索 + 余弦重排、五类经验卡注入、session 与 trace 全量落盘——决定给模型看什么经验并完整记录现场 |
| L1 路由层（agent-gateway） | 质量门控四规则、升级三重前置——决定这次回答由谁产出，并保证升级安全合规 |
| L0 模型层 | 本地学生 27B（omlx）+ 云端教师 DeepSeek——只出模型能力，不含学习逻辑 |

## 核心机制

- **质量门控**：四规则顺序判定（invalid_tool_schema → finish_reason_length → empty_output → forced_tool_missing），命中即升级且每请求仅一次；升级前依次执行 egress 许可、DLP 扫描、预算原子预留（失败分别返回 422/403/429）；x-gateway 标记三载体下发，model_runs 双侧落盘印证。
- **经验卡机制**：五类卡片（EVIDENCE / Method / Guard / SKILL / SOP），三态生命周期（dormant / active / removed）；仅 active 可被检索（dormant 在 SQL 层不可见）；原始轨迹永不注入；失败经验三层化——原文不入库、败局仅归因、教训以 Guard 卡沉淀。
- **生命周期管理**：晋升统一双阈值 0.5（EVIDENCE/ABILITY）+ sha256 去重 + 事务写入；dormant 留观复评（每批最老 200 条）；TTL 30 天与容量 10000 淘汰；checkpoint 幂等（批次失败可安全重跑）。
- **检索与注入**：FTS5 bm25 召回前 24 条、余弦重排前 8 条；EVIDENCE 与 Method/Guard（各上限 5 条）合成用户消息插在最后用户消息之前，SKILL 目录（前 10）入 system prompt，SOP（前 15）转工具 schema 并入 tools；对照臂关闭注入但轨迹照录，双臂走完全相同代码路径。
- **学习回路**：外部 cron/launchd 触发每日批次全量进化——ETL、任务级轨迹合成、三条蒸馏管线（skill_evolution / sop_lifecycle / verification_selection）、双阈值验证晋升、复评清理、幂等 checkpoint、次日快照换载（在线只读快照，写走 live 库）。
- **演进方向**：实战归因奖惩与置信度（待建）、卡片交付物修复、情景标签检索过滤、纯 27B 基线重跑、管线断点持久化、库版本交叉评估臂（详见概要设计 §5）。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/agent-server` | L2 经验层 + L3 离线进化层 + L4 运维件（TypeScript / Fastify） |
| `packages/agent-gateway` | L1 路由层（独立 Python 包，FastAPI；质量门控、升级前置、trace 状态机） |
| `packages/ai` / `packages/agent` / `packages/coding-agent` / `packages/tui` | Pi agent harness 基座（本仓库为其分叉） |
| `doc/design/` | 设计文档库（INDEX.md 为入口） |
| `doc/issues-snapshot/` | 问题台账与回归哨兵 |
| `doc/research/` | 调研资料与技术交底书 |

## 开发

```bash
npm install --ignore-scripts        # 安装依赖（不跑生命周期脚本）
npm run build                       # 构建全部 TS 包
npm run check                       # biome + 类型 + 各项检查
./test.sh                           # 非 e2e 测试（剥离 API key 与 auth）

# agent-gateway（Python 3.12，uv）
cd packages/agent-gateway && uv sync && uv run pytest

# agent-server 测试/运行需 Node 25.9.0（better-sqlite3 无更高版本预编译）
scripts/with-node25.sh <cmd>
```

## 文档导航

- [概要设计 v2（当前总纲）](doc/design/2026-08-13-agent-server-high-level-design-v2.md)：目标、四视角架构图、六大核心机制、演进方案、设计红线、问题台账
- [设计文档索引](doc/design/INDEX.md)：全部设计文档一行摘要与决策时间线
- [系统全量设计参照](doc/design/2026-08-13-agent-server-system-design-and-issue-inventory.md)：函数级细节与 issue 台账
- [对抗式审查档案](doc/design/reviews/2026-08-13-v2-adversarial/CONCLUSION.md)：36 条 finding 三轮收敛记录

## 许可

基于 [pi-mono](https://github.com/earendil-works/pi-mono) 分叉（MIT，见 [LICENSE](LICENSE)）；`packages/agent-gateway` 为独立 Python 包，见其自身 README。
