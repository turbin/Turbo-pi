# P3-2：benchmark 自动从 session 派生 —— 决策记录

日期：2026-07-22

## 决策

**仅生成文件（不自动启用）**（2026-07-22 用户拍板）：派生器产出 benchmark.json，用户仍通过 `AGENT_SERVER_BENCHMARK` env 显式启用，scheduler 不自动派生。

**不使用 LLM 提取 concept**（确定性）：使用正则规则提取概念标签，保证完全可复现、零网络、零延迟。

**模块位置**：`src/offline/benchmark.ts`（离线管线内，与 pipeline.ts 同级），而非 `scripts/`。理由：与 pipeline/scheduler 共享 session 解析逻辑，方便后续按需从 `runDailyEvolution` 调用。

## 实现

### `src/offline/benchmark.ts`

- `deriveBenchmark(sessionDir, options?)` → `BenchmarkFile`（符合 `skill_evolution.pipeline.py` 的 `--benchmark` 契约）
- `question`：取 session 首个 user 消息文本（与 `collectTrajectories` 的 `parseSessionFile` 同款逻辑）
- `concept`：规则化提取 —— 去前缀（what is/how to/fix/debug 等）→ 匹配两词名词短语 → 回退为首两实义词
- `solvable`：有 assistant message 且无 error custom entry → `true`，否则 `false`
- 去重：同 question（case-insensitive）只保留一条
- 上限：默认 50 条（`maxSamples` 可调）
- CLI：`node --import tsx src/offline/benchmark.ts <sessionDir> <outputPath>`

### 测试

9 个测试（`test/offline/benchmark.test.ts`）：空目录、非 jsonl 跳过、question+concept 提取、无 assistant→solvable=false、error→solvable=false、去重、上限、自定义 initial_skill、benchmark JSON contract 完整性。

### CLI 验证

```bash
# 从 repo root 运行
./node_modules/.bin/tsx packages/agent-server/src/offline/benchmark.ts \
  packages/agent-server/var/sessions /tmp/benchmark.json
# 输出：Wrote 3 samples to /tmp/benchmark.json
```

输出 3 个样本：
1. `ping`: concept=ping solvable=False（无 assistant message）
2. `什么是量子计算？请简短回答`: concept=量子计算 solvable=True
3. `帮我 review 代码`: concept=review solvable=True

## 验收

- 9 个新测试 + 79 个现有测试 = **88 测试全通过**（9 文件）
- 根 `npm run check` 干净
- CLI 生成文件符合 benchmark.json 契约（`{initial_skill, iterations, samples: [{id, concept, question, solvable}]}`）
