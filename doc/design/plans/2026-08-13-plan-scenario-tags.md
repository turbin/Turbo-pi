# 方案：经验卡情景维度（domain/task_pattern 标签 + 检索过滤）

- 状态：**待启动（C 阶段完成后询问用户确认；backlog 优先级中）**
- 来源：issue-012 评审采纳项 5；08-13 情景维度缺口分析
- 预估：0.5-1 天

## 问题

经验卡无情景维度：跨域隔离靠物理分库，检索的情景匹配完全依赖 bm25 字面重合。同库多域卡片存在跨域串扰风险（B 阶段注入集合头部集中现象相关）。

## 方案（最小实现，明确不做 HMM 自动推断）

1. **schema**：payload 增加 `domain`（alfworld/office/wenshu/...）与 `task_pattern`（任务模式，如 pick_clean_then_place / report_generation）
2. **写入**：蒸馏管线按轨迹来源自动打标（合成器已带 task_type/arm 元数据，直接透传）
3. **检索**：bm25 召回后按 domain 过滤（当前任务 domain 由 harness 随请求传入，如 extra_body 或注入侧推导）；同 domain 优先、跨域降权或排除（具体策略 A/B 实测）
4. **回归测试**：跨域卡片不被注入到异域任务；同域命中率不受影响

## 验收

- 混合库（ALFWorld + 办公卡同库）下跨域注入为零
- C 重复集分数不因过滤退化

Refer：doc/issues-snapshot/issue-012（项 5）；概要设计 §5.3
