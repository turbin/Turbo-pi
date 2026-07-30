# Agent Server P2 Task 5：benchmark 接线——变更与决策

日期：2026-07-22
范围：`packages/agent-server/src/offline/scheduler.ts`、`test/offline/scheduler.test.ts`、`benchmark/benchmark.example.json`（新增）
来源：P1 最终评审 P2 事项 4（skill_evolution.pipeline 无 --benchmark 时恒输出 []，三条管线有一条空转），见 `doc/design/2026-07-21-agent-server-p1-closeout-and-p2-followups.md`

## 变更

1. `DailyEvolutionOptions` 新增 `benchmarkPath`；`runDailyEvolution` 按优先级解析后透传给 `runOfflinePipeline`：`pipelineOptions.benchmarkPath`（显式）> `options.benchmarkPath` > `AGENT_SERVER_BENCHMARK` env > undefined（skill 阶段继续输出 []，行为不变）。
2. 新增 `benchmark/benchmark.example.json`：手工维护的训练任务集样例（initial_skill / samples[id, concept, question, solvable] / iterations），契约与 `python/skill_evolution/pipeline.py` CLI 注释一致。
3. 测试：4 次运行覆盖优先级链与 undefined 默认值。

## 决策

| 决策 | 理由 |
|---|---|
| benchmark 数据来源 = 用户手工维护文件 + env/option 接线（计划已定的方案 A） | Python 侧 `--benchmark` 已完整实现消费端，缺的只是 scheduler 入口；自动生成 benchmark（从 session 派生 samples）是另一量级的功能，P2 不立项。 |
| 优先级：显式 pipelineOptions > options.benchmarkPath > env | 与既有选项注入模式一致（测试可精确控制，部署用 env，避免重复配置）。 |
| 未提供时透传 `undefined` 而非跳过 pipeline | 保持三管线并行语义；Python 侧对缺省 benchmark 的处理（输出 [] + stderr 说明）已存在且有测试覆盖，不重复实现。 |
| 样例文件放 `benchmark/` 目录 | 该目录已存在（mock-benchmark results 的落点），benchmark 相关资产归拢一处。 |

## 验证

- agent-server 全套 128 测试通过。
- `npm run check` 干净。
