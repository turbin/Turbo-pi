# Task 9: Offline Scheduler and Checkpoint — Changes and Decisions

Date: 2026-07-21
Scope: `packages/agent-server/`（P1 plan Task 9）

## Changes

- `src/offline/scheduler.ts`（新增）: `runDailyEvolution(store, options?)` — 一次完整离线进化流程：ETL session JSONL → `runOfflinePipeline` → `promoteStagedOutputs` → `writeCheckpoint`，返回 checkpoint id。
- `src/offline/checkpoint.ts`（新增）: `writeCheckpoint` / `readCheckpoint` / `latestCheckpoint`。
- `src/experience-store.ts`（修改）: `initSchema` 新增 `checkpoints` 表与 `idx_checkpoints_kind_epoch` 索引；新增 `Checkpoint` 类型与 `insertCheckpoint` / `getCheckpoint` / `getLatestCheckpoint` 方法。
- `test/offline/scheduler.test.ts`（新增）: 5 个测试（成功路径、失败无 checkpoint、缺失输入目录容错、checkpoint 读写回环、latestCheckpoint 按 epoch 取最新）。

## Decisions

1. **Checkpoint 存储在 ExperienceStore 数据库（`checkpoints` 表），不另建文件。**
   理由：SPEC §7 明确 P1 在 Experience Store schema 中新增 `checkpoints`（进化 checkpoint）表；checkpoint 与其描述的 experiences 同库可共享一份备份/迁移路径。建表用 `CREATE TABLE IF NOT EXISTS`，与现有 `initSchema` 模式一致， additive 且幂等 —— 多 session 共享同一 DB 时安全。

2. **checkpoint 列：id / kind / epoch / metric / snapshot / created_at。**
   理由：brief 草图给出 kind/epoch/metric/snapshot 四元组；`id` 作为主键（`ckpt-<sha256(kind|epoch|snapshot)[:16]>`，确定性、可去重），`created_at` 与 `experiences` 表保持一致便于审计。`kind` 区分 checkpoint 流（当前只有 `"evolution"`），`epoch` 为调用方注入的运行时间戳（测试可固定）。

3. **metric = 本次 promote 为 active 的条目数，而不是 pipeline 抽取计数之和。**
   理由：brief 草图用 `skills+sops+cards`（抽取数），但 SPEC §4.2 step 4-6 的重点是 verifier 筛选后的 active 集更新；promoted 数才刻画"这一跑改变了多少 active 经验"。pipeline 抽取计数不丢 —— 放进 snapshot JSON（`{etlInserted, pipeline, promoted}`）。

4. **失败路径：错误直接上抛，不写 checkpoint。**
   理由：SPEC §9「Python 子进程调用失败/超时 → 失败时保留上一 checkpoint」。checkpoint 写入排在流程最后，任何一步失败自然没有新 checkpoint，上一 checkpoint 仍然描述当前 active 集；无需额外回滚逻辑。

5. **不接入 server 启动，无 cron 库。**
   理由：SPEC §4.2「每日一次或手动触发」把触发放在外部；spec 未要求 server 内置调度。`runDailyEvolution` 保持可被 cron/CLI 调用的纯模块，符合"no new external dependencies"约束。

6. **依赖注入模式沿用 pipeline.ts。**
   理由：`inputDir`/`outputDir`（默认 `./var/sessions`、`./var/evolution`，与仓库 `packages/agent-server/var/` 数据目录约定一致）、`now`、`etlFn`/`pipelineFn`/`promoteFn` 均可注入，测试用内存 store + 临时目录 + fake pipeline 跑真实 promote/checkpoint 路径。

7. **输入目录缺失时按空运行处理（mkdir -p 后继续）。**
   理由：全新部署还没有 session 目录时 cron 首跑不应报错；ETL 收到空文件列表、pipeline 产出空数组、checkpoint 照常写入（etlInserted=0）。

## Verification

- `node ../../node_modules/vitest/dist/cli.js --run`（packages/agent-server，Node v24.15.0 arm64）：15 个测试文件、111 个测试全部通过（含新增 scheduler.test.ts 5 个）。
- `npm run check`（仓库根目录，同 Node）：biome / pinned-deps / ts-imports / shrinkwrap / install-lock / tsgo --noEmit / browser-smoke 全部通过。server.ts 的既有改动（非本任务产生）未暂存、未提交。

## Refer Spec

- `doc/design/2026-07-19-agent-server-p1-spec.md` §4.2 / §5.2 / §7 / §9
- `doc/design/2026-07-19-agent-server-p1-plan.md` Task 9
