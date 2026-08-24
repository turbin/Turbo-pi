# issue-022: Langfuse Redis 磁盘写满 → 摄入 500 → campaign SDK 队列膨胀 → 64GB RSS 被 macOS jetsam 杀死

- 状态：**fixed（2026-08-25 磁盘清理恢复，待观察；防复发项见"建议修法"）**
- 报告：2026-08-25（D6 campaign 于任务 20/31 处无报错静默消失）
- 影响面：Langfuse 自托管栈（colima docker 数据盘）、campaign/evolution 等所有 langfuse SDK 客户端进程、D6 批次（resume 恢复）

## 现象

D6 campaign（PID 43928）在任务 20/31 完成后**无 traceback 静默退出**；日志尾部仅有 Langfuse "Internal Server Error / Failed to export span batch" 重试行。macOS kernel 日志定位：`memorystatus: killing largest compressed process python3.12 [43928] 64604 MB`——进程内存 64.6GB 被 jetsam 杀掉。

## 根因链（逐环实证）

1. **colima docker 数据盘 /dev/vdb1 40G 写满 100%**（5 天 Langfuse 数据 + 32GB 镜像 + 16GB build cache 累积）；
2. Langfuse Redis RDB 落盘失败（`rdbSaveRio: No space left on device`）→ `stop-writes-on-bgsave-error` 触发，拒绝写；
3. Langfuse 摄入队列堵塞 → 对客户端返回 500；
4. campaign 进程内 langfuse SDK 的 span 缓冲队列**无上限积压** → RSS 涨到 64.6GB；
5. macOS jetsam 按"最大压缩进程"杀掉 campaign。

同类 D5 收尾的 export 报错是同一链条的早期表现（当时未致命）。

## 修复（已执行）

- `docker builder prune -af`（16.3GB）+ `docker image prune -a -f`（~1GB）→ /dev/vdb1 降至 67%（13G 可用）；
- redis `bgsave` 与写探测恢复（`set healthcheck-ok → OK`）；
- D6 以 resume 重启（20 已完成任务自动跳过）。

## 建议修法（防复发，待办）

1. **磁盘水位监控**：每日 cron 检查 `docker exec langfuse-redis-1 df -h /data` + docker system df，>80% 告警（入跑批前置清单 E 节）；
2. **Langfuse 数据保留策略**：trace 保留期评估（当前全量保留，ClickHouse 持续增长）；
3. **colima 磁盘扩容**（40G→80G）或定期 prune 自动化；
4. **SDK 侧防御**：campaign/oracle 等长寿命进程的 langfuse client 考虑 `flush_at` 更小批次 + 摄入失败时丢弃策略评估（当前重试无上限——这正是队列膨胀源；修 langfuse SDK 配置即可，不改线上行为语义）。

## 回归测试

不适用于本 infra 项（以监控项 1 替代）；若执行修法 4，补"摄入 500 时进程 RSS 有界"的压测断言。
