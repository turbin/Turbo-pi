# issue-006: 经验库快照模式下 getByContentHash 读冻结库（写侧去重可能漏重 → 重复晋升）

- 状态：fixed（2026-08-09 修复，commit 899745d6）
- 报告：2026-08-09（P0 批次修复校验 diff 复查发现）
- 修复：2026-08-09——`getById`/`getByContentHash` 改回 live 库（写路径服务查询；检索路径 search/listActive 仍读快照），注释固化原则
- 影响面：`packages/agent-server/src/experience-store.ts`（快照读路径）、`src/offline/verifier.ts:69`（写侧去重调用点）

## 现象

M10 快照修复把 `getByContentHash` 一并切到了只读快照库（`readDb`）：`AGENT_SERVER_STORE_SNAPSHOT` 开启时，进化晋升的 contentHash 去重查询读的是**冻结快照**，看不到快照之后写入 live 库的经验，可能判"不存在"而重复晋升同内容卡片。

## 根因

`experience-store.ts` 构造函数中 `readDb = snapshotPath ? new Database(snapshotPath, { readonly: true }) : this.db`，`getByContentHash`（:238-248）使用 `readDb.prepare(...)`。该方法的唯一写侧调用点是 `offline/verifier.ts:69`（晋升前去重）——写路径一致性应读 live 库，检索路径（search/listActive/getById）才应读快照。实际触发场景有限：需快照 env 泄漏到进化进程（server 不背进化职责，run-evolution CLI 独立），但语义错误应修正。

## 修复

`getByContentHash` 改回读 `this.db`（live）；或更系统地：读路径（search/listActive/getById）走 readDb，所有服务于写路径的查询一律走 this.db，并在 `ExperienceStoreOptions` 注释中固化该原则。

详见 `doc/design/2026-08-09-adversarial-review-experiment-validity.md` §6 V3。

## 回归测试

已落地（red-first，2026-08-09）：`test/regressions/issue-006-snapshot-write-dedup.test.ts`——快照模式开启时 `getByContentHash`/`getById` 能查到 live 新写入，`search` 仍冻结；M10 既有测试断言同步更新。
