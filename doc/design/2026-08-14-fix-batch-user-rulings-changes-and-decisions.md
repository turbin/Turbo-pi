# 2026-08-14 C 后统一修改方案：用户五项裁决 决策记录

日期：2026-08-14
对象：doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md（v2 → v3）

## 裁决与理由

1. **B' 27B 重跑取消，实验主线切 9B 全量重跑批**（原裁决 1 A/B/C 三选作废）
   - 理由（用户）：不为 27B 补基线，直接换 9B 重跑。
   - 新增实验顺序决策点（用户指定）：后续实验流程先跑 QwenClawBench 一类 office 案例集 → 报告用户测试结论 → 用户确认后才进入 ALFWorld 测试。
   - 答辩方补充含义（已写入方案 §6-1）：9B 低基线 = 更大 headroom，是测量"能力绝对提升"的更好设计；前置需 omlx 9B 可用性确认、测速、pilot 重校 max_tokens（叙述风格不同），length 升级率 <5% 门控不变。issue-003 以"27B 纯基线不再测量，主线转 9B"关闭。

2. **管线断点持久化：翻转为立项（最小断点）**（答辩方原建议"降级为已知风险"，经用户提问重新评估后修订）
   - 翻转理由：①原"降级"依据的两个前提（C 阶段 5/5 零故障、单次重跑 45min）在低负载下成立，9B 全量重跑使批次数数倍增长、故障暴露次数线性上升；②issue-002 三连故障均为分布边缘型，9B 轨迹分布未经验证，复现概率不为零；③0.5-1 天保费相对 4 天跑批 + 每日进化的总盘子合理。
   - 范围收敛：只做最贵阶段（打分，issue-002 r3 的 1608 次/13-27h 估算来源）的产物落盘 + --resume；ETL/提取阶段视 office 先行阶段故障率再定。排在 F0 之后、9B 起跑前。

3. **SOP/SKILL 晋升闸：不做双轨，机制完善并统一**（新增批次 F4）
   - 用户裁决原文："不做双轨，将机制完善并统一。"
   - 落实形态：不是把 SOP/SKILL 塞进现役 0.5 自评闸（issue-010 已证其与实战脱钩），而是把晋升机制升级为"可证伪的验证闸"后全卡类统一——Method/Guard 过交付物检查+实战归因，SOP 保留预验证并纳入统一框架，SKILL 建立 utility→可验证任务映射或暂缓入库。红线 3 随之修订。

4. **演进方案 6（库版本交叉评估臂）：补 plan 立项**
   - 按答辩方建议执行；plan 已补写 `doc/design/plans/2026-08-14-plan-library-version-cross-eval.md`（2×2 交叉臂：冻结库/当日库 × 注入开/关，差分口径预注册），与 9B 重跑批合并排期，受实验顺序决策点约束（office 先行）。

5. **DLP：建立默认敏感列表**
   - 用户裁决：身份证号 + 密钥类作为默认审核内容，列表可持续扩充。
   - 落实：内置默认模式 = 身份证号 + 密钥类（AWS key / PEM 私钥 / api_key 赋值，即现有 3 条），配置化扩充（config 追加模式即生效）；scan_envelope 扩展扫 tools[]（SOP schema 出网盲区）随同一 quick win 实施。

## 影响面

- 方案 v3：§4.5 新增 F4 批次、§5 DLP/断点批注、§6 五项全部关闭转决议、执行顺序 F0→最小断点→F1→F2→F3→F4
- 新增 plan：plans/2026-08-14-plan-library-version-cross-eval.md
- INDEX.md：登记交叉臂 plan 与本决策记录，统一修改方案条目刷新为 v3
- 遗留：27B 相关历史结论的引用口径（凡引用 B 阶段/C 阶段 27B 数据处，后续报告需注明"27B 线已停，主线 9B"）

Refer Spec：doc/design/plans/2026-08-14-post-c-unified-fix-batch-plan.md v3；doc/design/reviews/2026-08-14-fix-batch-adversarial/（round-1~3）；doc/issues-snapshot/issue-002/003；doc/design/2026-08-13-agent-server-high-level-design-v2.md §5/§6/§7
