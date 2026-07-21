# Agent-Server P1 现场验证记录（Skill/SOP 注入 + pi 会话格式 + 离线调度）

**日期：** 2026-07-21
**目标：** P1 plan Task 10 — live E2E 验证 SKILL catalog / SOP schema 注入、pi-native session JSONL（Task 8 遗留缺口）、离线调度 smoke run
**环境：** macOS arm64，Node v24.15.0（nvm）；gateway 运行中（127.0.0.1:8787，channel `lobster-local-key`）；omlx 运行中（127.0.0.1:8367）；Kimi Code CLI 已配置 `local/agent-auto-server` → `http://127.0.0.1:8788/v1`

---

## 检查项总览

| # | 检查项 | 结果 |
|---|---|---|
| 1 | SKILL/SOP seed 写入 experience DB | PASS |
| 2 | 非流式请求：`<available_skills>` 进入 system prompt | PASS |
| 3 | 非流式请求：`get_time` SOP schema 进入 tools | PASS |
| 4 | 非流式请求：检索证据 `<Extra Info>` 注入 | PASS |
| 5 | session JSONL：version-3 header + parentId 链 + assistant message | PASS |
| 6 | pi 原生 session 机制（`JsonlSessionStorage`）能读回落盘文件 | PASS（关闭 Task 8 缺口） |
| 7 | Kimi Code 经 agent-server（streaming 路径）端到端 | PASS（修复一个 400 bug 后） |
| 8 | Kimi 请求中 skill catalog + `get_time` 注入，且最终 provider 为 omlx | PASS |
| 9 | 离线调度 smoke run（MockLLM）+ checkpoint 行 | PASS |

---

## 1. Seed SKILL 和 SOP 经验

`seed-experience.ts` 新增 `skill-code-review`（SKILL）与 `sop-get-time`（SOP）两条 seed，payload 字段与 `buildSkillCatalog`（`payload.description`）和 `buildSopSchemas`（`payload.schema`）的消费方式对齐。

重置 DB（`var/experience.db` 为 runtime 数据，旧库只有 P0 的 4 条 seed 且无新 schema 表；已备份到 `/tmp/experience.db.bak-task10`）后重新 seed：

```bash
rm var/experience.db && npx tsx seed-experience.ts
# seeded 6 experiences
sqlite3 var/experience.db "SELECT id, type, status FROM experiences;"
# exp-quantum-1|EVIDENCE|active ... skill-code-review|SKILL|active / sop-get-time|SOP|active
```

## 2. 启动 agent-server

重启前发现 8788 端口上的旧进程（7 月 19 日启动）运行的是 Task 8/9 之前的代码（`session-writer.ts` 等均在其后修改），予以终止并用当前代码重启：

```bash
npx tsx src/start.ts   # agent-server listening on 127.0.0.1:8788
```

## 3. 非流式请求（handleStream 路径：注入 + session 落盘）

```bash
curl -s -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"什么是量子计算？请简短回答"}],"max_tokens":256}'
```

返回 200，中文回复（"量子计算是一种利用量子力学原理……"），`finish_reason: stop`。

发给 gateway 的实际请求（`GatewayClient` 落盘的 `/tmp/gateway-request.json`）：

- system 消息（注入产物）：

  ```text
  <available_skills>
  <skill name="code-review">How to review code effectively</skill>
  </available_skills>
  ```

- `tools: ['get_time']` — SOP schema 注入成功。
- 合成 user 消息包含检索到的证据：

  ```text
  <Extra Info>
  量子计算利用量子比特（qubit）的叠加态和纠缠态进行并行计算……
  量子比特可以同时处于 0 和 1 的叠加态……
  </Extra Info>
  ```

## 4. Session JSONL 结构验证

新落盘文件 `var/sessions/1784643567486-0b60c58e-….jsonl`：

- 第 1 行 header：`{"type":"session","version":3,"id":"1784643567486-…","cwd":"…/packages/agent-server", …}`
- 10 个 tree entry，`parentId` 链完整无断裂（脚本逐条校验）。
- entry 统计：`message` ×2（user、assistant），`custom:experience_injection` ×1（`{"retrieved":["exp-quantum-1","exp-quantum-2"]}`），`custom:response_started` ×1，`custom:stream_event` ×5，`custom:response_completed` ×1。
- assistant `message` entry 的 content 为 `[{type:"text", text:"量子计算是一种利用量子力学原理…"}]`，与模型实际回复一致。

## 5. pi 原生 session 机制读回（关闭 Task 8 缺口）

用 `packages/agent` 自己的读路径验证（一次性 tsx 脚本，运行后已删除）：

```ts
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const storage = await JsonlSessionStorage.open(env, filePath);
await storage.getPathToRoot(await storage.getLeafId());
```

结果：`JsonlSessionStorage.open` 成功解析 v3 header 与全部 entry；`getPathToRoot` 沿 parentId 链走到 user → assistant message；`findEntries("message")` 返回 2 条；输出 `PI_READ_OK`。SPEC §10 P1.3 验收标准"pi session-manager 能回放落盘文件"达成。

## 6. Kimi Code 端到端（streaming 路径）

### 发现并修复的 bug：system 消息被错映射为 tool 消息导致 gateway 400

首次 `kimi -p "帮我 review 代码" -m local/agent-auto-server` 返回 `502 gateway error: 400 Bad Request`。回放 `/tmp/gateway-request.json` 直接打 gateway 得到：

```json
{"error":{"code":"invalid_message_sequence","message":"tool message requires tool_call_id","param":"messages.1.tool.tool_call_id"}}
```

根因：Kimi Code 把 system prompt 放在 messages 数组里（OpenAI 惯例），而 `toOpenAIMessage`（`src/openai-compat.ts`）只处理 pi-ai 的 `user`/`assistant`/`toolResult` 三种 role，`role:"system"` 落入 toolResult 分支，被映射成无 `tool_call_id` 的 `tool` 消息。

修复（TDD，先在 `test/openai-compat.test.ts` 加两个失败测试）：

1. `toOpenAIMessage` 显式透传 `role:"system"` 消息（string 或 content-part 数组均归一为 string）。
2. 顺带处理 OpenAI 格式的多轮历史：assistant 消息透传 `tool_calls`，tool 消息回退读取 `tool_call_id`（否则模型真的调用 `get_time` 后，Kimi 的第二轮请求会以同样的 400 失败）。

验证：`packages/agent-server` 全部 15 个测试文件 113 个测试通过；重启 agent-server 后 Kimi 请求成功。

### Kimi 请求 1：`kimi -p "帮我 review 代码" -m local/agent-auto-server`

返回正常中文回复（引导用户提供代码）。agent-server 日志：

```text
[agent-server] stream query: 帮我 review 代码
[agent-server] stream retrieved: [ 'skill-code-review' ]
```

发给 gateway 的请求（`/tmp/gateway-request.json`）：

- system 消息共 2 条：第 1 条为注入的 `<available_skills><skill name="code-review">How to review code effectively</skill></available_skills>`；第 2 条为 Kimi 自己的 system prompt（修复后完整透传）。
- tools 共 28 个 = Kimi 自带 27 个 + 注入的 `get_time`（无重名冲突）。

### Kimi 请求 2：`kimi -p "现在几点" -m local/agent-auto-server`

返回 "现在是 2026年7月21日 14:27:09。"。`get_time` 在 tools 列表中；该 query 未检索到经验（`retrieved: []`），模型从上下文时间直接作答、未发起 tool call，因此 assistant `tool_calls` 透传路径本次未被 live 触发（由新增单测覆盖）。

### gateway 侧确认

```bash
sqlite3 packages/agent-gateway/var/agent_gateway.db \
  "SELECT trace_id, provider, state, purpose FROM model_runs ORDER BY rowid DESC LIMIT 4;"
# 4 行均为 omlx|succeeded|primary
```

curl 非流式 + 两次 Kimi 请求均最终路由到本地 omlx。

## 7. 离线调度 smoke run（MockLLM）

未设置 `LLM_BASE_URL`/`LLM_MODEL`/`TEACHER_MODEL`（Python 端回退 MockLLM），对真实 `var/sessions` 跑一次 `runDailyEvolution`：

```text
checkpoint id: ckpt-d2acc38f010de0b4
kind: evolution | epoch: 1784644386213 | metric: 2
snapshot: {"etlInserted":407,"pipeline":{"skills":0,"sops":0,"cards":2},"promoted":2}
```

DB 复核：

```text
ckpt-d2acc38f010de0b4|evolution|1784644386213|2.0        -- checkpoints 表
ABILITY|active|2 / EVIDENCE|active|4 / EVIDENCE|dormant|407 / SKILL|active|1 / SOP|active|1
```

ETL 从 P0 遗留的旧格式 session 文件抽取了 407 条 dormant EVIDENCE；2 条 card 经验证提升为 active EVIDENCE；checkpoint 行正确写入。

## 8. 决策记录

1. **重置 `var/experience.db` 后重新 seed**，而非让 seed 脚本幂等。
   - 原因：seed 脚本是手工初始化工具，保持简单（主键冲突即报错）；DB 是 runtime 数据且已备份。
2. **终止并重启 8788 上的旧 agent-server 进程**。
   - 原因：该进程加载的是 Task 8/9 之前的代码，无法验证当前实现；重启后验证完毕，本会话启动的进程已按规约关闭。
3. **在 `toOpenAIMessage` 修复 system/tool 历史透传，而非在 `server.ts` streaming 分支另写转换层**。
   - 原因：根因在共享的 OpenAI 映射函数；non-streaming 路径将来收到 OpenAI 格式历史时同样需要该行为。
4. **修复范围包含 assistant `tool_calls` / tool `tool_call_id` 透传**。
   - 原因：SOP 工具注入后模型可能发起 tool call，Kimi 的第二轮请求必带 OpenAI 格式历史，不修复则 tool-call 循环必然 400；属于同一根因的最小完整修复。
5. **离线 smoke run 直接跑在真实 `var/` 上**。
   - 原因：`var/` 是 gitignore 的 runtime 数据；验证目标就是 checkpoint 行写入真实库。ETL 产出的 407 条 dormant 经验不影响在线注入（只有 active 进入 prompt）。

## 9. 遗留

- streaming 路径（`server.ts` 的 `body.stream === true` 分支）不做 session 落盘，Kimi 走的该路径因此没有对应 session JSONL；session 验证经由非流式 `handleStream` 路径完成。是否给 streaming 分支补落盘属后续工作。
- `get_time` 的真实 tool-call 往返未 live 触发（模型选择直接作答）；assistant `tool_calls` 透传目前只有单测覆盖。
- 备份文件 `/tmp/experience.db.bak-task10` 与调试落盘 `/tmp/agent-server-request.json`、`/tmp/gateway-request.json` 为临时文件，不提交。
