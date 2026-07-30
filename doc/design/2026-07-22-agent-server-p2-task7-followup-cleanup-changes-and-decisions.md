# Agent Server P2 Task 7：低优先级 follow-up 批量清理——变更与决策

日期：2026-07-22
范围：agent-server 的 Python 三条 CLI、offline 管线/verifier/checkpoint、session-writer、openai-compat、相关测试、`doc/design/2026-07-19-agent-server-p1-spec.md` §6
来源：`doc/design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md` 低优先级 follow-up 清单 + Task 6 发现的 OpenAICompatClient role bug

## 变更（按 follow-up 项）

1. **OpenAICompatClient role bug**：`verification_selection/pipeline.py`、`skill_evolution/pipeline.py`、`sop_lifecycle/__main__.py` 三处真实 LLM 路径 `OpenAICompatClient(role=...)`（不存在的参数，必 TypeError）改为 `OpenAICompatClient()` / `OpenAICompatClient.teacher_from_env()`。
2. **pipeline 子进程 timeout/kill 测试**：fake spawn 发 signal 的 close 事件，断言错误信息含 signal 与 timeout。
3. **readJsonArray 错误上下文**（pipeline.ts）：读取/解析失败带文件路径。
4. **promoteStagedOutputs**：缺失 staged JSON 抛带路径与指引的明确错误；`verifyAndCanonicalize` 批次包进事务（新增 `ExperienceStore.transaction()` 手写 BEGIN/COMMIT/ROLLBACK——`db.transaction()` 不接受 promise 函数），批中失败不留半提交状态。
5. **checkpoint**：确定性 id 的 hash 输入加分隔符（`kind:epoch:snapshot`）；`insertCheckpoint` 改 `INSERT OR IGNORE`，同 id 重试幂等。
6. **SessionWriter 加固**：(a) 同路径二次构造抛错（模块级 registry，close 释放）；(b) 零内容 done 不再写空 assistant message（两个 build 函数都改）；(c) WriteStream error 构造时捕获，后续 write/close 立即抛出而非延迟到 close。
7. **ETL 测试补充**：thinking+text 混合回复只挖 text；空内容 assistant 不产候选。
8. **toOpenAIMessage 签名放宽**：新增 `OpenAIInputMessage = Message | OpenAIRequestMessage` 联合类型，与调用方实际传入的形态一致。
9. **临时目录清理**：etl/pipeline 测试 mkdtemp 纳入 afterEach rmSync；`skill_evolution/pipeline.py` 与 `sop_lifecycle/__main__.py` 自动创建的 workdir 在 try/finally 中删除（显式 --workdir 不删）。
10. **spec §6 JSONL 示例**：从 v1 草图更新为实际实现的 v3 pi-native 格式（session header/tree message/custom 条目，含 experience_injection、custom_message、stream_event 等）。

## 决策

| 决策 | 理由 |
|---|---|
| 事务用手写 BEGIN/COMMIT/ROLLBACK 而非 `db.transaction()` | better-sqlite3 的 `db.transaction()` 要求同步函数，store 方法是 async 签名（内部同步）；手写事务保持现有 API 形状，行为等价。 |
| checkpoint 重试幂等取 INSERT OR IGNORE 而非 ON CONFLICT 校验内容 | 同 id 即同内容（id 由内容 hash 派生），重复写必为同一运行重试，忽略即正确语义；无需额外校验开销。 |
| SessionWriter 路径 registry 为模块级 Set | 进程内保护即可（多进程写同一 session 文件不是本组件职责）；close 释放保证测试间不泄漏。 |
| thinking 部分不产 ETL 候选（维持现状并 pin 测试） | thinking 是过程性推理而非可复用经验，现行语义正确，测试固化。 |
| sop_lifecycle 临时目录泄漏一并修复（原清单只点名 skill_evolution） | 同一模式同一文件家族，评审意见明确建议同等处理；改动 3 行。 |

## 验证

- agent-server 全套 148 测试通过（较 Task 6 后 +11）。
- 根目录 `npm run check` 干净。
- 四条 Python CLI mock 模式 smoke 通过（含真实-LLM 构造路径的参数校验）。
