# R 真实化里程碑 — 进度与交接

状态：进行中
任务书：` design/2026-07-23-agent-server-r-real-teacher-tasks.md`
最近更新：2026-07-23T22:25+08:00 by kimi（R1 完成）

## 1. 子任务状态表

| 子任务 | 状态 | 执行 agent | 更新时间 | 产出 |
|---|---|---|---|---|
| R1 真实 LLM teacher 全链路 E2E 验证（含 rescore 超时治理） | done | kimi | 2026-07-23T22:25+08:00 | 决策记录 ` design/2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md`；checkpoint ckpt-82fbef5131817d6c metric=4；rescore 未触发暂不治理 |
| R2 Mock vs 真实对照评估与 teacher 切换建议 | pending | | | 依赖 R1 |
| R3 C-重 Go/No-Go 评审 | pending | | | 依赖 R2 |

依赖关系：R1 → R2 → R3 严格串行（后者依赖前者数据）。

## 2. 交接信息（跨 agent 共享事实）

- 2026-07-23 kimi：Post-C 里程碑已收口（agent 侧）。用户手工待办 2 项不阻塞 R 里程碑：N2 metric>0 手工验证、N3 LaunchAgent 安装。
- 2026-07-23 kimi：测试基线 21 文件 / 225 测试全绿。Node 必须走 `scripts/with-node25.sh`（25.9.0），从 `packages/agent-server` 执行。
- 2026-07-23 kimi：omlx 127.0.0.1:8000（gemma-4-12B-it-4bit，要 api_key）；gateway 8787（`lobster-local-key`）；agent-server 8788。omlx 不可动。
- 2026-07-23 kimi：LLM 切换机制（`src/offline/pipeline.ts:18-20`）：env 透传，`LLM_BASE_URL` + `LLM_MODEL`/`TEACHER_MODEL` 设置→真实端点，否则 MockLLM。TS 侧 `timeoutMs` 默认 300s（`pipeline.ts:57-58`）。
- 2026-07-23 kimi：P3-1 已知问题——rescore 模式真实 LLM 下 120s 超时（12 次 LLM 调用），未治理；R1 需实测 300s 默认下是否足够。
- 2026-07-23 kimi：经验库 `packages/agent-server/var/experience.db`（gitignored），当前库存 ABILITY 3 / EVIDENCE 25 / SKILL 1，active 29。R1 运行前备份为 `var/experience.db.r1-pre-real-teacher-backup`。
- 2026-07-23 kimi：进化 CLI（从 `packages/agent-server`）：`EXPERIENCE_STORE_PATH=./var/experience.db AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json PYTHONPATH=python ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts`。
- 2026-07-23 kimi：R1 完成。真实 teacher 全链路 2m31s exit 0（rescore 因 dormant=0 未触发，超时治理留待 dormant 积压出现）。omlx api_key 在 `packages/agent-gateway/config.toml` omlx provider 节（勿落入文档）。R1 后库存：ABILITY 7（Method 6 / Guard 1，新增 4 条真实 teacher Method：0.724104/0.731059×3）、EVIDENCE 25、SKILL 1，active 共 33；dormant 0；备份 `var/experience.db.r1-pre-real-teacher-backup`。

## 3. 断点恢复指引

如果从零接手：

1. 读本目录 `README.md`（更新纪律）→ 任务书 ` design/2026-07-23-agent-server-r-real-teacher-tasks.md` → 本文件状态表。
2. 当前：R1 done，认领 R2 开始（先按纪律把 R2 置 in_progress 并署名）。
3. R2 第一步：用基线文档 §1/§3/§5 的 SQL 集对 R1 后的库出数，与 Mock 基线对照；R1 后库存快照见下方交接信息末条。
4. 里程碑收口：R3 完成（Go 则另立 C-重任务书）后，状态改"已收口"。
