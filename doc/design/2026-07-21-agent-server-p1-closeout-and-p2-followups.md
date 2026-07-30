# Agent Server P1 收尾与 P2 跟进事项

日期：2026-07-21
范围：`0d5ab10d..363bf9c8`（20 个提交，P1 计划 Task 1–10 全部完成，含每任务评审、修复与最终整体评审）

## P1 完成状态

| 任务 | 提交 | 状态 |
|---|---|---|
| Task 1 skill catalog | ffd61765 | 完成（此前会话） |
| Task 2 SOP schema | f40f0711 | 完成（此前会话） |
| Task 3 注入集成 | 1e253ed6 | 完成（此前会话） |
| Task 4 proxy/server 接线 | 9fb61a76 | 完成（此前会话） |
| Task 5 ETL | 5981d9c0 | 完成（此前会话） |
| Task 6 离线 pipeline 子进程 | 802b8a49 | 完成，评审通过 |
| Task 7 verifier/canonicalize | 0b0c215e | 完成，评审通过 |
| Task 8 pi 原生 session JSONL | c4f310da + ffa756b8 | 完成（含评审修复：assistant 回复重建为可重放 message 条目） |
| Task 9 scheduler/checkpoint | 40c9b71f | 完成，评审通过 |
| Task 10 live E2E 验证 | b8caf3f8 + 30493f83 | 完成（含 live 修复：system 消息映射、null content） |
| 最终评审修复 | 363bf9c8 | 完成（SKILL payload description 契约 + removed 行守卫） |

验证基线：agent-server 全套 116 测试通过；`npm run check` 干净；live E2E 9 项检查全部通过（见 `doc/design/2026-07-21-agent-server-p1-live-verification.md`），session 文件经 pi 自己的 `JsonlSessionStorage` 回读验证。

## P2 跟进事项（最终整体评审 triage 结论）

### 应在 P2 立项的事项

1. **dormant ETL 候选的闭环**（评审 Important #2）：ETL 产出的 dormant EVIDENCE 目前无消费路径——`runDailyEvolution` 不把 dormant 行送进 verifier 重评分，行数无界增长且污染 FTS 检索候选（retrieval 无 SQL 状态过滤，dormant 行会挤占 top-24）。这是 spec §5.2 闭环缺失的一环：要么接线（spec §6 Stage 3 跨管线 TwoStageScorer，Python 侧），要么显式 descope。
2. **流式路径不落 session JSONL**（finding 22）：Kimi 走 SSE 流式路径，注入生效但不写 session 文件，离线管线拿不到这部分训练数据。
3. **`custom_message` 决策**（finding 23）：记录的请求消息是注入前的；spec §6 的 `custom_message`（注入内容随会话重放）未实现。重放的会话不反映模型实际看到的上下文。需要计划级决策，不是临时改代码。
4. **skill 阶段的 benchmark 接线**：`skill_evolution.pipeline` 无 `--benchmark` 时恒输出 `[]`，`--input` 参数目前未消费。当前流程中三条管线有一条是空转。
5. **`server.ts` 遗留问题**（P1 之前已存在，非本次引入）：`/v1/chat/completions` 把每个请求体写到固定路径 `/tmp/agent-server-request.json`（用户 prompt/代码落盘在 var/ 之外），应移除或加开关；同文件还有 inline `await import()`，违反仓库 no-inline-imports 规则。

### 低优先级 follow-up（不阻塞，随做随清）

- pipeline 子进程 timeout/kill 路径无测试；`readJsonArray` 包一层带文件路径的错误
- etl/pipeline 测试的 mkdtemp 临时目录未清理；vendored Python CLI 每次运行泄漏临时目录
- `promoteStagedOutputs` 对缺失 staged JSON 抛裸 ENOENT；promotion 非事务（P1 规模可接受，P2 接线时一并处理）
- `content_hash` 列无索引（dormant 行增长后 O(n) 查询会成为问题）
- checkpoint：hash 输入无分隔符拼接（代码/文档不一致）；确定性 id + 裸 INSERT 重试不幂等
- SessionWriter 无路径复用保护；`done` 零内容时仍写空 assistant message；流中途写盘错误只在 close 时暴露
- ETL 测试补充：thinking+text 混合回复、空内容 pin
- `toOpenAIMessage` 参数类型不再诚实（接受非 pi-ai 形态），应放宽签名
- spec §6 的 JSONL 示例还是 v1 草图格式，应更新为实际实现的 v3 格式

## 过程备注

- 执行方式：subagent-driven development（每任务实现 + 评审 + 修复循环，最终整体评审一次）。
- 进度台账：`.superpowers/sdd/progress.md`（gitignored）。
- 各任务决策记录：`doc/design/2026-07-21-agent-server-task{6,7,8,9}-*-changes-and-decisions.md`。
- 环境注意：本机默认 shell node（nvm v20.19.5）为 Rosetta x86_64，node_modules 仅有 darwin-arm64 原生绑定；所有 node 命令须用 arm64 Node >= 22（nvm v24.15.0 已验证）。
