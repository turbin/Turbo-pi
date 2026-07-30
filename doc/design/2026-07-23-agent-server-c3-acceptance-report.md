# Agent-Server C3 验收报告

日期：2026-07-23
验收对象：提交 `84059689`（docs(agent-server): C3 live verification and observation baseline）
验收依据：`doc/design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md` §C3（3 个 BDD 场景）+ CLAUDE.md 测试要求 + 通用约束

## 结论：**有条件通过**（文档修正已当场完成，条件闭合）

## 独立复核结果（非转述执行方结论）

| 检查项 | 方法 | 结果 |
|---|---|---|
| 测试基线 | 亲跑 `with-node25.sh node vitest --run`（packages/agent-server） | PASS：20 文件/213 测试全绿 |
| 提交范围 | `git show --stat` | PASS：仅 2 份设计文档 + INDEX，无工程外改动，omlx 未动 |
| 提交格式 | `git log --format=%B` | PASS：conventional 前缀 + COMPLETED/TODO/Refer Spec |
| 基线库存数字 | 直接 sqlite3 查 `var/experience.db` | PASS：ABILITY(Guard 1/Method 1)、EVIDENCE 17+3、SKILL 1，与文档一致 |
| checkpoint | 查 checkpoints 表 | PASS：`ckpt-77c2725336cb4469` metric=21，snapshot 与文档一致 |
| 并存行统计 | 执行文档所附 SQL | PASS：0 行，与文档一致 |
| INDEX 维护 | grep | PASS：2 条索引 + 时间线条目已加 |

## BDD 场景逐项判定

**场景 1（ABILITY 入库）：条件性 PASS —— 接受执行方判定**
- live 管线未产出自然 Method/Guard（3 张 cards 全部 Workflow），场景 Given 未自然成立。执行方以 C1 单测 10 条 + 正确根因方向佐证代码路由，并把"零产出"固化为基线证据。处理符合元原则。
- **但根因表述有事实错误，已修正**（见下）。

**场景 2（注入 + 上限）：PASS（附偏差说明）**
- 执行方用手动插入的 2 条 ABILITY（格式与 C1 映射一致）+ FTS5 检索 + `buildInjection` 直连验证了注入路径，注入 procedure 文本正确。
- 偏差：任务书写的是"向 agent-server 发非流式请求"，实际用的是临时注入检测服务（8792 端口，直连 retrieve+buildInjection），未走完整 server 代理路径。可接受理由：P2 live 验证已覆盖完整 server 路径（EVIDENCE 注入），本次新增代码仅在 buildInjection 内部且被直接命中。**记录偏差，不要求返工。**

**场景 3（观察基线）：PASS**
- 基线文档含全部可复查 SQL（库存/quality 分桶/并存行/checkpoint/会话特征），我逐条执行复核数字一致。迭代建议 4 条具体可操作。

## 验收中发现并当场修正的问题

**根因论断错误（已修正）**：live 验证文档称"MockLLM 的五元组固定为 role:Workflow 模板"。我直接调用 `make_teacher_mock` 实测证伪——`extract_handler`（`testing.py:129-172`）是**关键词门控**：轨迹含 `kmp`/`cyclic`/`z-algorithm` → Guard、含 `backoff`/`retry` → Method、其余 → Workflow，三条分支均可触发。零 Method/Guard 的准确根因是 4 个 session 轨迹（量子计算问答 + 代码 review）不含门控关键词。已修正：`c3-live-verification.md` 两处（原因分析段、决策记录第 1 条）、`c3-observation-baseline.md` 迭代建议第 1 条、INDEX 对应条目。此修正直接影响后续迭代方向（不需要换 teacher，只要轨迹含关键词即可触发），必须改。

## 遗留与后续建议

1. **完全闭合场景 1 的低成本方法**（建议，非本次验收要求）：构造一条轨迹文本含 `retry`/`backoff` 关键词的 session JSONL 放入 `var/sessions`，重跑 `runDailyEvolution`，即可观察到自然 Method ABILITY 入库，把"条件性 PASS"升级为完整 PASS。注意这会改变基线库存数字，需同步刷新基线文档。
2. MockLLM 关键词门控意味着 Mock 路径下的 role 分布永远偏 Workflow；真实使用中若 teacher 也是 Mock，ABILITY 产量会结构性偏低——已在基线迭代建议中，留待上线观察。

## 验收后动作

文档修正（3 文件）与本验收报告待提交；INDEX 需补本报告条目（提交时一并完成）。

Refer Spec：`doc/design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`；`doc/design/2026-07-23-agent-server-c3-live-verification.md`；`doc/design/2026-07-23-agent-server-c3-observation-baseline.md`
