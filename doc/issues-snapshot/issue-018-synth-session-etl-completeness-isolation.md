# issue-018: T6 ETL 完整性判据与合成器契约断裂——campaign 合成 session 全部"半截隔离"（dormant 挖掘断流）

- 状态：**deferred（2026-08-20 用户裁决：登记延后处理；D2 夜间进化前应用修法①）**
- 报告：2026-08-20（D1 夜间进化 checkpoint 分析：etlInserted=0 / etlIsolated=32）
- 影响面：`packages/agent-server/eval/synthesize_campaign_sessions.py`（合成器）× `packages/agent-server/src/offline/etl.ts`（T6 完整性判据）；ETL dormant 挖掘路径（主流水管线不受影响）

## 现象

D1 夜间进化 checkpoint（ckpt-af2b6eec9751f1c7）：`etlInserted=0, etlIsolated=32`——32 个合成 session **全部**被 T6 完整性判据（2026-08-14 M5 落地：pi-native session 有头 + response_completed/error/aborted 闭合标记 = 完整；有头无闭合 = 半截落盘中断，整体隔离）判为半截隔离，dormant 候选零摄入。

实测合成 session：有 `{"type":"session","version":3,...}` 头，`response_completed` 计数 = 0——合成器（2026-08-09 写就，早于 T6）从不写闭合标记。

## 根因

T6 判据假设所有 session 生产者都写闭合标记；`synthesize_campaign_sessions.py` 未随 T6 更新——**契约断裂**。C 阶段（T6 之前）合成 session 正常摄入，此问题在 D1 进化首次暴露。

## 影响评估

- **主进化水管线不受影响**：verification_selection 直接读 session 文件提取轨迹（D1 已正常产 28 卡：6 ABILITY + 22 EVIDENCE，过 F4 闸晋升）。
- **dormant 挖掘断流**：ETL→dormant 池零增长；M3 复升排除/dormant cleanup 在空池上空转（无故障，但设计的一条供给线失效）。
- agent-server 在线 session（8789 真实流量）有闭合标记，不受影响。

## 建议修法（延后处理时参考）

1. **合成器补闭合条目**（推荐，最小）：每个合成 session 末尾追加 `response_completed` custom entry（与 session-writer v3 同契约），恢复 T6 完整性语义——D2 夜间进化前落地，否则 dormant 池持续断流；
2. ETL 对带合成器标识（metadata 前缀/前缀命名）的 session 豁免完整性判据（次选，判据出现特例）；
3. 防回退测试：合成 session 经 etlSessionFiles 后 inserted≥1 且 isolated=0。

## 回归测试

延后处理时按修法 ③ 补（test/regressions/issue-018-synth-session-closing-marker.test.ts 或 eval pytest 等价物）。

## 临时处置

无需——主流水管线正常；D2 前按修法①落地即可恢复 dormant 供给线。
