# 2026-08-09 P0 修复批次实施 — 变更与决策记录

状态：**P0 批次全部落地，测试全绿**（gateway 178 / agent-server vitest 267 / eval pytest 42 / python 32 / npm run check 0）。
关联：`doc/design/plans/2026-08-09-gate-length-issue-and-adversarial-review-plan.md` 执行步骤 6；`doc/issues-snapshot/issue-003-gate-length-misescalation.md`；`doc/design/2026-08-09-adversarial-review-experiment-validity.md`。

## 已实施修复（按审查编号）

### gateway（packages/agent-gateway，pytest red-first）

- **M1（issue-003 回归测试 #1）**：每次响应携带 `x-gateway` 升级标记——非流式走响应头 `{"escalated","reason","provider","local_provider"[,"cloud_finish_reason"]}`；流式走 SSE 注释行 `: x-gateway {...}`（对 OpenAI 客户端透明，agent-server 可读）。`execute_with_escalation`/`escalate_to_cloud` 改为返回 `(result, GatewayMarker)`。
- **C4**：升级结果观测——escalation run 的 quality_signals 落 `cloud_finish_reason`，云端仍 length 时 `logger.warning`（"escalated result still truncated"）+ 标记透出。**不改门控策略**（length 规则讨论留 P2 技术债，quality.py 未动）。
- **M9**：omlx 本地路径 `forward_thinking=True` 透传 `thinking`（reasoning 模型默认 thinking-on 时 content=null 误判 empty_output 的根因之一）；`parse_chat_response` 在 content 为空时并入 `reasoning_content`。
- 既有 `test_sse_streaming.py::test_sse_happy_path_chunk_sequence` 因新注释行更新断言（行为变更的有意适配）。

### eval harness（packages/agent-server/eval，pytest red-first）

- **C1**：`campaign.py run_agent` 增加必选 `injection` 关键字参数（原代码 NameError/TypeError，committed 后从未跑通）；冒烟测试（fake client 断言 extra_body 转发 + 标记/trace_ids 记录）。
- **C2**：`campaign_metrics.escalation_rate` 遇缺 `escalated` 的行 fail loud（ValueError，绝不静默当 0）；`annotate_escalation` 按 trace_id join gateway model_runs 回填；`campaign.py --metrics --gateway-db` 支持回填后核算。
- **C3/M14/M15/M16/M18 + max_tokens + M3**：`alfworld_agent.py` 重写——
  - 池上界 `len(env.game_files)`、`--expect-pool-size` 硬校验、超界 sys.exit（禁回绕重放）；每条记录 `pool_size`/`pool_hash`；
  - `env.skip(args.start)` 使 `--start N` 与 game_idx 对齐；
  - append 去重（`existing_game_idxs`）；
  - `extract_command` 行锚定 + 词边界 + 最后非 think 优先，返回 `(command, verb_matched)` 并逐局记录 `extract_failed_steps`；
  - 记录 `init_prompt`（合成器改为缺失即硬失败 + `--prefix` 参数化）；
  - `--max-tokens` 参数化（200 默认保留，pilot 定 800/1024）；
  - 每步记录 `finish_reason`/`provider`/`escalated`（x-gateway 头，M3）。
- **issue-003 回归测试 #2**：`gate_length_escalation.py`——model_runs 全量口径（按 trace 去重）`finish_reason_length` 升级率 <5% 才允许开跑；空库拒绝盲跑；`--json` 供上层消费。
- **M8**：`harness.py` 两臂统一走 8789（控制臂 `injection:false`，删除直连 DeepSeek 与 key 读取）；`run-full-arm.sh` 控制臂改走专用 8790 实例（`AGENT_SERVER_INJECTION=off`）。
- **M11**：`preflight.py` 指纹校验——omlx `/v1/models` 必须有模型（可选 `AGENT_EVAL_EXPECTED_OMLX_MODEL` 精确校验）；gateway models 列表；agent-server `/api/status/chain`（self/gateway/omlx ok + injection 标志与预期匹配，8790 控制臂强制 off）；指纹存疑即 fail，不再"任何 HTTP 状态算活"。
- **M10 服务端**：`ExperienceStore` 快照模式（`AGENT_SERVER_STORE_SNAPSHOT` 只读检索，写入仍走 live 库）+ `snapshot_store.py`（SQLite online backup）。

### agent-server（packages/agent-server，vitest red-first）

- **M2**：`GatewayClient.stream` 与 `proxy-handler.toGatewayRequest` 恒带 `stream_options.include_usage`——恢复 token 观测（length 顶格签名本可第一时间暴露）。
- **M5**：`toOpenAIRequest` 把注入 systemPrompt（skill catalog）并入既有 system 消息，不再新建第二条 system（控制臂 `[system(harness),user]` vs 实验臂 `[system(harness+catalog),user(evidence),user]` 骨架对称）。
- **M3 服务端**：SSE `: x-gateway` 注释解析——session 落 `gateway_marker` custom entry，trace 日志落 `gateway` 行。
- **M10 接线**：`createServer` 读 `AGENT_SERVER_STORE_SNAPSHOT`。

### 附带

- `scripts/check-pinned-deps.mjs` 忽略 `qcb` 目录——C 阶段 vendor 的 QCB 任务资产（gitignored 的 fixture package.json，非仓库依赖）此前使本机 `npm run check` 预存失败。
- issue-002 到期项：回归测试补齐（`python/tests/test_issue002_pipeline_resilience.py`——截断 JSON/缺 choices 重试双副本 + `_score_once` thinking/max_tokens 注入哨兵）。

## 决策记录

1. **SSE 标记用注释行而非 data 事件**：data 事件会被朴素 OpenAI SSE 解析器当 chunk 解析（破坏 `choices` 访问），注释行对所有解析器透明；agent-server 与 harness 均显式解析。非流式用响应头（JSON 可读）。
2. **M1 标记随响应下发 + model_runs 仍是 ground truth**：运行时标记解决"harness 无感知"；C2 的 model_runs 回填与 gating 脚本仍以库为准——两者互为印证，拒绝只信其一。
3. **C4 只观测不改策略**：升级结果再门控会改变语义（云端结果也可能合理截断）；本轮只标记/告警/落库，length 规则讨论留在 P2 技术债（与计划一致，不动 quality.py）。
4. **M8 tb 控制臂用专用 8790 实例**：mini-swe-agent 的 `mini` CLI 经 Portkey 无法携带任意 body 字段（已拆 wheel 验证），请求级 `injection` 覆盖不可行；服务级 `AGENT_SERVER_INJECTION=off` 需独立实例。preflight 自动拉起并指纹校验。
5. **M10 快照为"读冻结、写照旧"**：全库只读会掐断 request_traces/session 落库（学习回路），与 M10 目的相悖；故只冻结经验读取（search/listActive/getById），快照由 runbook 在每日跑批前生成（`snapshot_store.py`），服务器重启换快照。
6. **pinned-deps 忽略 qcb**：fixture 资产非仓库依赖（gitignored），逐文件 pin 无意义；忽略目录名 `qcb` 最窄。
7. **issue-002 转正**：到期项 1（回归测试）本次落地；项 2（断点持久化立项）与项 3（降级/关闭）仍待用户决策——触发时点已到（B 热库轮定稿），index 状态改 fixed 待观察。

## 未做（明确留待）

- 方案 A/B/C 重跑与 pilot 校准（800/1024）——**用户拍板后执行**（issue-003 仍 open）。
- P1 批次（M4/M6/M7/M9-gateway-thinking 之外的 M12/M13/M17/M19/M20/M21 等）与全部 minor——另立任务。
- quality.py 门控 length 规则策略讨论——P2 技术债。
- 历史结果数据不回改（C3 影响的 20260730 控制臂口径在报告中注明）。

Refer Spec：doc/design/plans/2026-08-09-gate-length-issue-and-adversarial-review-plan.md（P0 批次清单）；doc/design/2026-08-09-adversarial-review-experiment-validity.md（发现与修复建议）；doc/issues-snapshot/issue-003-gate-length-misescalation.md；doc/issues-snapshot/issue-002-evolution-logprobs-json-truncation.md；packages/agent-server/AGENTS.md（08-05 控制臂决策，M8 恢复项）
