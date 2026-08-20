# issue-016: campaign run-id 缺省值按当天日期生成——跨日 resume 静默开新批次

- 状态：**deferred（2026-08-20 用户裁决：登记延后处理，非故障演进项）**
- 报告：2026-08-20（D1 resume 启动时主会话实测发现，已人工拦截）
- 影响面：`packages/agent-server/eval/campaign.py`（`--run-id` 缺省值）；跨自然日的多日 campaign（D1-D7 常态跨午夜）

## 现象

D1 批次（run-id=campaign-20260819）暂停后于次日 08:43 以缺省参数重启：

```text
ap.add_argument("--run-id", default=f"campaign-{time.strftime('%Y%m%d')}")
```

缺省 run-id 变为 `campaign-20260820`——**静默新开一个空批次**（新 results 目录、无 run.jsonl、completed_keys 为空），从 task 1 重跑，无任何"检测到同 day 未完成批次"的告警。若未人工发现：同一天的实验数据将分裂到两个 run 目录，判据核算口径混乱，且重复消耗 ~14h 机时。

拦截过程：启动后未见 `resume: N tasks already completed` 行但进程已与 8789 建立 LLM 连接（不一致信号）→ 定位为 run-id 跨日漂移 → kill、清理误建目录、显式 `--run-id campaign-20260819` 重启后 resume 正常（3 任务跳过）。

## 根因

run-id 的缺省值把"批次标识"与"启动当天日期"耦合——resume 场景（跨日续跑是 D 阶段多日 campaign 的常态，单日 9-14h 必跨午夜）缺省行为错误且 fail silent。

## 建议修法（延后处理时参考）

1. `--day N` 存在同 day 既有 run 目录且其 run.jsonl 未覆盖当日批次时，缺省 run-id 复用该目录而非新建（resume 语义优先）；
2. 或：缺省 run-id 与已存在的同 day 其他 run 目录冲突时 fail loud（提示显式 --run-id）；
3. 短期纪律（已生效）：跨日 resume 一律显式传 `--run-id`——已写入跑批前置清单 F4 项待补（见下）。

## 回归测试

延后处理时补：`eval/tests/` 下构造"同 day 两个候选 run 目录"场景，断言缺省行为按修法 1 或 2 执行（防回退）。

## 临时处置（已执行）

- 2026-08-20 D1 以显式 `--run-id campaign-20260819` 正常 resume（监视中）。
- 前置清单 F4 补充项（跨日 resume 必须显式 run-id）随下一批文档更新落盘。
