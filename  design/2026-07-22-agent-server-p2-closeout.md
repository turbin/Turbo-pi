# Agent Server P2 收尾

日期：2026-07-22
范围：P1 closeout 立项的 5 项 P2 事项 + 低优先级 follow-up 清单，共 8 个任务 10 个提交

## P2 完成状态

| 任务 | 内容 | 状态 |
|---|---|---|
| Task 1 | server.ts 遗留清理（debug dump 开关化、inline import 消除） | 完成 |
| Task 2 | retrieval status 过滤 + content_hash 索引 | 完成 |
| Task 3 | 流式路径 session JSONL 落盘 | 完成 |
| Task 4 | custom_message（注入后上下文随会话重放） | 完成 |
| Task 5 | benchmark 接线（scheduler → pipeline --benchmark） | 完成 |
| Task 6 | dormant 完整闭环（--rescore + 重评分晋升 + TTL/cap 清理） | 完成 |
| Task 7 | 低优先级 follow-up 批量清理（10 项） | 完成 |
| Task 8 | live E2E 验证（8 项检查全 PASS） | 完成 |

补充提交：ETL 测试断言修复（Task 2 引入的回归）、server.test.ts 的 var/ 污染修复、gateway-client.ts 的 dump 开关化（Task 1 同类问题漏网）。

## P1 立项事项闭环对照

| P1 评审事项 | 处理方式 |
|---|---|
| 1. dormant ETL 候选闭环 | 完整接线（用户确认方案）：Python `--rescore`（vs_reference 口径）+ scheduler stage 4 重评分晋升 + stage 5 TTL/cap 清理；retrieval SQL 过滤（Task 2） |
| 2. 流式路径不落 session | Task 3：tee 解析 OpenAI SSE，raw 透传不变，session 全量落盘 |
| 3. custom_message 决策 | 实现（计划决策）：两条路径均记录注入后完整 payload |
| 4. skill 阶段 benchmark 接线 | 手动文件 + env/option 优先级链接入（计划决策），example 文件入库 |
| 5. server.ts 遗留 | debug dump 开关化（含 gateway-client 同类问题）、inline import 清零 |

低优先级 follow-up 清单 8 项全部清理完毕（Task 7）。

## 验证基线

- agent-server 全套 148 测试通过（P1 收尾时 116，P2 净增 32）。
- 根目录 `npm run check` 干净。
- live E2E 8 项检查全部 PASS（见 ` design/2026-07-22-agent-server-p2-live-verification.md`），流式 session 经 pi `JsonlSessionStorage` 回读验证，离线 evolution 全链路（ETL→pipeline→promote→rescore→cleanup→checkpoint）真实跑通。

## 环境备注（与 P1 不同）

- 本机 nvm 已不存在；使用 Homebrew Node v25.9.0（arm64）。better-sqlite3 在 Node 25 无预编译产物，首次 `npm install --ignore-scripts` 后需 `npm rebuild better-sqlite3`（node 头文件可能需镜像源：`npm_config_dist_url=https://npmmirror.com/mirrors/node`）。
- omlx 托管实例在 8000 端口且要求 api_key（P1 时为 8367 无鉴权）；gateway config.toml 相应调整。
- Kimi CLI 本地 provider type 为 `openai_legacy`。

## P3 候选（未立项）

- 真实 LLM 打分路径的 live 验证（需 LLM_BASE_URL 环境）。
- benchmark 自动从 session 派生（P2 决策为手动文件，自动派生器是独立功能）。
- 流式路径的 toolcall 出站校验（validateToolCallStream 只接在 handleStream；streaming 分支裸透传不过校验——若要对 Kimi 路径也做 SOP toolCall 校验需立项）。
- agent-server package 级 tsconfig 的解析错误（pre-existing，根 tsgo 干净）。
