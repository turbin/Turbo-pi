# Agent-Server：C 决策 3 修正（失败经验三层化）+ R2 进化进料方案——变更与决策记录

日期：2026-08-04
SPEC：`doc/design/2026-07-31-agent-self-evolution-roadmap.md`（R0-R4）；`doc/design/2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md`（E5 §7）
状态：**已批准（用户 08-04：D1/D2/D5 按建议执行）**

---

## 1. 决策记录

| # | 决策 | 修正对象 | 理由 |
|---|---|---|---|
| A-D1 | **C 决策 3 修正**：失败经验从"低分轨迹直接丢弃"细化为三层——①原始失败文本不入库不注入；②失败轨迹作为离线归因输入（败局对照）；③归因产出（Guard/修正卡）经回放验证后入库（Guard 只来自验证通过产出、上限≤5） | C 决策 3【改】 | 五条独立证据链：Reflexion（失败反思 ALFWorld 75%→97%，无微调）；2605.29463（自由诊断反思 100% 虚构、坏记忆不如无记忆 → 层①防火墙必需）；ETO（成败对照对）；NAT（负例须显式区分）；FCRF（独立教训池 +2.2%）。原决策内核（原始失败文本不作注入）保留，外延（失败数据不参与学习）修正 |
| A-D2 | **进化进料三路合并**：学生轨迹 + 同局老师胜局轨迹 + 败局对照（层②输入）；提炼产物限方法级（Method/Guard/修正卡），位置类碎片降权 | R2 进料方案 | E5 §7：碎片修格式够不到规划层；同局配对把"差距"显形为可学知识点（ZPD 粒度匹配） |
| A-D3 | **学习回路触发器从门控升级迁移到局级胜负**（won=False → 败局重放对照 → 提炼） | R2 任务书【改】 | 27B 换型后门控升级率 0%——门控只测形式、不测任务正确性；形式合格的规划失败只有局级信号可捕 |
| A-D4 | **教训/修正卡的产生必须程序化提取 + 回放验证，禁止自由自我诊断** | 实现红线（写入 R2） | 2605.29463：自由自我诊断 0/121 命中正确目标物（confabulation）；程序化轨迹信号提取 0%→86% |

## 2. 对既有文档的修订

- `doc/design/2026-07-31-agent-self-evolution-roadmap.md` R2 节：触发器描述由"escalation 回流"修订为"escalation 回流 + 局级败局对照双通道"（门控升级率高的学生用前者，低升级率/门控免疫的学生用后者）
- INDEX 决策时间线 C 决策 3 条目标【改】，指向本记录

## 3. 证据引用

`doc/design/2026-07-31-agent-model-selection-and-planner-executor-literature.md` §4.6（五条证据链全文）；`doc/design/2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md` §7（分层瓶颈分析）

Refer Spec：`doc/design/2026-07-31-agent-self-evolution-roadmap.md`；`doc/design/2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md`（C 决策 3 原文）
