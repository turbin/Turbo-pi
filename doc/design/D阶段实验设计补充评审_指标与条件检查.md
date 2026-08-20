# D 阶段实验设计补充评审：缺失指标与条件检查

> 日期：2026-08-19  
> 主题：9B + Teacher Memory 实验设计补充指标与条件

---

## 用户问题

> 你再看下我们是否缺少了其他指标和条件，是否有需要补充的？

---

## 补充评审结论

有，而且再往下审一层后，我认为当前方案还缺几个**非常关键的“机制分解指标”**。尤其是你现在真正想证明的是：

\[
Teacher\ Plan
\rightarrow Memory
\rightarrow Retrieval
\rightarrow 9B\ 理解
\rightarrow 9B\ 执行
\rightarrow Success
\]

现在的指标已经能判断“最终有没有变好”，但如果结果不好，还不一定能判断到底坏在 **教师计划、Memory、检索、9B 理解、9B 执行、停止策略还是 Gate**。

建议新增内容全部作为 **Analysis Addendum v2**，不修改已经启动的主判据①～⑤。

---

# 一、目前最重要的缺口：缺一个“Oracle Teacher Plan”诊断条件

这是现在**最值得补的一项**。

假设 9B + Memory 没提升：

```text
9B Alone        score = 0.30
9B + Memory     score = 0.32
```

我们现在无法知道：

- 是 Memory 没检索到正确经验？
- 还是已经给了正确经验，但是 9B 看不懂/执行不了？

因此建议在一个小规模 diagnostic subset 上增加：

| 条件 | 含义 |
|---|---|
| A | 9B Alone |
| B | 9B + Retrieved Memory |
| C | **9B + Oracle Teacher Plan** |
| D | Teacher Direct Solve |

其中 C 很关键。

Oracle Teacher Plan 指：

> 不经过 BM25 / semantic retrieval，直接把教师为该类任务生成的正确结构化 plan 给 9B。

于是可以得到非常清楚的能力分解。

### Memory 总增益

\[
MemoryGain=B-A
\]

### Retrieval Loss

\[
RetrievalLoss=C-B
\]

如果：

\[
C\gg B
\]

说明：

> **9B 能执行教师计划，真正的问题在 Retrieval / Memory Matching。**

### Student Execution Gap

近似看：

\[
ExecutionGap=D-C
\]

如果：

\[
B\approx C\ll D
\]

说明：

> Memory 找对了，计划也给对了，但 9B 本身执行能力不足。

这个诊断非常重要。

否则以后看到：

```text
task_00021
0.06 → 0.10
```

你不知道应该优化：

- embedding；
- BM25；
- Memory schema；
- Teacher Plan；
- 还是直接换更强 student。

不需要每天跑这个条件。可以只在：

> D2 / D7 + 一小批典型失败任务

上做。

---

# 二、Memory Hit 还需要拆成“命中”和“命中正确”

现在记录：

```text
retrieval_hit
similarity_score
memory_id
```

还不够。

因为：

> **检索到了 ≠ 检索对了。**

建议拆成：

| 指标 | 定义 |
|---|---|
| RetrievalCoverage | 有可用候选 Memory 的任务比例 |
| RetrievalHitRate | 实际发生 Memory 注入的比例 |
| UsefulHitRate | 注入 Memory 后确实帮助任务推进 |
| FalseHitRate | 检索到不相关/误导 Memory |
| NoHitRate | 没有找到任何可用经验 |
| NegativeTransferRate | Memory ON 比 OFF 反而明显更差 |

尤其重要的是：

\[
NegativeTransferRate
=
P(Score_{on}<Score_{off}-\delta)
\]

因为 Memory 系统最危险的并不是：

> “没有帮助。”

而是：

> **错误经验让 9B 更有信心地走错。**

例如：

```text
当前任务
   ↓
检索到表面相似 trajectory
   ↓
9B 认为有成功经验
   ↓
直接 Replay
   ↓
环境其实不同
   ↓
错误路径被强化
```

所以最终必须同时报告：

\[
PositiveTransfer
\]

和：

\[
NegativeTransfer
\]

---

# 三、还缺一个核心层：9B 到底有没有“遵循 Teacher Plan”

这是当前研究假设的中央变量。

你想证明的不是：

> 9B 看到了 Memory。

而是：

> **9B 能够通过语义理解，把 Memory 中的 trajectory/plan 映射到当前环境并执行。**

因此建议增加 Plan Adherence 指标。

例如 Teacher Plan：

```text
1. inspect workspace
2. locate DSL
3. validate DSL
4. patch missing field
5. validate again
6. finish
```

实际 9B：

```text
1. inspect workspace      ✓
2. locate DSL             ✓
3. validate DSL           ✓
4. query workspace again  ✗
5. search unrelated DSL   ✗
6. validate again         ?
```

可以定义：

### Plan Adoption Rate

\[
PlanAdoptionRate
=
\frac{\text{使用检索计划的任务}}
{\text{成功检索到计划的任务}}
\]

### Plan Step Completion Rate

\[
StepCompletionRate
=
\frac{\text{正确完成的计划步骤}}
{\text{要求执行的计划步骤}}
\]

### Plan Deviation Rate

\[
PlanDeviationRate
=
\frac{\text{计划外无必要动作}}
{\text{全部动作}}
\]

### Replan Count

表示：

> 9B 执行经验时多少次偏离后重新规划。

这几个指标能直接回答：

> **9B 是“不会规划”，还是连教师规划都执行不好？**

---

# 四、建议增加一个非常直观的指标：Success@Turn K

平均 round 有一个明显问题：

```text
任务 A = 5 rounds
任务 B = 29 rounds
```

平均：

\[
17
\]

但它完全看不出 trajectory 分布。

任务又有明确：

\[
MAX\_TURNS=30
\]

所以特别适合做：

\[
Success@K=P(\text{任务在第 K 轮前成功})
\]

例如报告：

| 指标 | D1 | D7 |
|---|---:|---:|
| Success@5 | 5% | 20% |
| Success@10 | 15% | 45% |
| Success@15 | 25% | 65% |
| Success@20 | 35% | 75% |
| Success@30 | 45% | 82% |

这会非常直观地展示：

> Memory 是不是把成功轨迹整体“向左移动”。

理想变化：

```text
D1:
               success
                  │
0----10----20----30

D7:
       success
          │
0----10----20----30
```

也就是说：

> **不仅成功更多，而且成功更早。**

这个指标建议加入。

---

# 五、成功最好拆成“Judge Success”和“Functional Success”

目前 score 很大程度依赖 Judge。

但办公自动化任务其实通常有客观状态。

例如：

```text
workflow 是否真的创建？
DSL 是否通过 validator？
文件是否存在？
workspace configuration 是否符合要求？
```

所以最好有：

\[
JudgeSuccess
\]

和：

\[
FunctionalSuccess
\]

两个结果维度。

例如：

```text
Judge score = 0.8
但 workflow 实际没 activate
```

那实际业务上依然失败。

建议增加：

| 指标 | 含义 |
|---|---|
| JudgeScore | DeepSeek 软评分 |
| HardPass | 硬规则全部满足 |
| ArtifactValidity | 交付物是否合法 |
| FunctionalSuccess | 最终系统状态是否达到目标 |

最终最重要的：

\[
AutonomousFunctionalSuccessRate
\]

也就是：

> **9B 没升级教师，并且任务真的做成了。**

它比单独的 `AutonomousSuccessRate` 更硬。

---

# 六、Gate 最好最终变成完整 Confusion Matrix

之前已经补了：

\[
MissedEscalationRate
\]

但严格来说还缺另一边：

> **不该升级却升级了。**

Gate 最终可以看成一个分类器：

| | 实际需要教师 | 实际不需要教师 |
|---|---:|---:|
| Gate 升级 | TP | FP |
| Gate 不升级 | FN | TN |

于是可以得到：

### Missed Escalation

\[
FN
\]

这是最危险的：

> 学生做不出来，Gate 还认为它可以。

### Unnecessary Escalation

\[
FP
\]

表示：

> 9B 本来能完成，却浪费教师成本。

你真正想优化的是：

\[
FN\downarrow
\]

同时：

\[
FP\downarrow
\]

而不是单纯：

\[
EscalationRate\downarrow
\]

如果完整 ground truth 太贵，可以只在一个 audit subset 上做。

---

# 七、Teacher Plan 本身也必须被评估

现在系统隐含了一个假设：

> Teacher 给出的 trajectory 是正确的。

但实际上 Teacher 也可能：

- 计划过长；
- 工具调用冗余；
- 出现错误；
- 给出过度具体、不能泛化的 trajectory；
- 产生任务 ID / object ID 等实例绑定内容。

所以建议记录：

\[
TeacherPlanSuccessRate
\]

\[
TeacherPlanLength
\]

\[
TeacherPlanValidationRate
\]

以及：

\[
TeacherPlanGeneralizability
\]

尤其是在入库前。

理想 Memory pipeline 应该是：

```text
Teacher trajectory
      ↓
Success?
      ├── No → reject
      ↓ Yes
Plan abstraction
      ↓
Validation
      ↓
Promotion
      ↓
Memory
```

而不是：

```text
Teacher生成
↓
直接入库
```

否则 Student 后面失败可能根本不是 Student 的问题，而是 Teacher Memory 本身有问题。

---

# 八、Memory 生命周期指标还可以再补几个

现在已经有 promotion / demotion，但还缺“经验长期有没有价值”。

建议关注：

| 指标 | 用途 |
|---|---|
| MemoryReuseCount | 一条经验被使用多少次 |
| MemorySuccessAfterReuse | 使用该 Memory 后成功概率 |
| MemoryUtility | 该 Memory 的历史平均增益 |
| MemoryAge | 经验存在时间 |
| MemoryConflictRate | 多条经验针对同状态给出冲突方案 |
| MemoryStalenessRate | 经验因环境/Tool 变化失效 |
| DuplicateMemoryRate | 库中高度重复经验比例 |

可以定义一个简单：

\[
MemoryUtility(m)
=
E[\Delta Score\mid memory=m]
\]

长期下来非常有价值。

Memory 库可能不是：

> 越大越好。

而是：

> **少数高价值经验贡献了大部分增益。**

---

# 九、需要特别记录 Context Budget

这个对 9B 尤其重要。

加入 Memory 的副作用是：

\[
ContextLength\uparrow
\]

而 9B 对长 context 中的无关信息可能比 27B 更敏感。

所以 Memory 注入可能出现：

```text
检索更多经验
↓
知识看起来更多
↓
prompt 更长
↓
Attention 被稀释
↓
执行反而变差
```

因此建议增加：

\[
MemoryTokenRatio
=
\frac{MemoryInjectedTokens}
{TotalInputTokens}
\]

以及：

\[
InjectedMemoryCount
\]

并观察：

\[
Score=f(MemoryTokenRatio)
\]

很可能不是单调增加，而类似：

```text
Score
  ^
  |       /\
  |      /  \
  |_____/    \____
  +----------------> Memory tokens
```

也就是存在最优注入量。

这对以后优化 Top-K、Plan compression 非常重要。

---

# 十、必须有 Treatment Compliance 检查

2×2 实验还有一个隐藏问题：

设计了：

```text
X1 Frozen + ON
X2 Current + ON
X3 Current + OFF
X4 Frozen + OFF
```

但必须证明系统实际上也是这么执行的。

建议每个 run 记录：

```text
library_snapshot_hash
library_version
injection_enabled
injected_memory_ids
injected_token_count
prompt_hash
tool_schema_hash
model_hash
judge_model
environment_snapshot_id
```

然后定义：

\[
TreatmentComplianceRate
\]

例如：

\[
TreatmentComplianceRate=
\frac{符合预期 treatment 的 run}
{全部 run}
\]

对于实验完整性，建议要求：

\[
TreatmentComplianceRate=100\%
\]

尤其：

```text
X3/X4 injection OFF
```

必须确认：

\[
InjectedMemoryTokens=0
\]

而不是“配置写着 OFF”。

---

# 十一、需要 Task Difficulty 分层

现在 20 个重复任务的平均值可能隐藏一个问题。

例如 Memory：

```text
简单任务：0.8 → 0.95
复杂任务：0.1 → 0.1
```

总平均也会提高。

但这不能说明它解决了 9B 的真正能力瓶颈。

建议按**实验前就能定义的信息**进行分层，例如：

```text
工具调用复杂度
任务类别
是否涉及 DSL
是否涉及 multi-object
是否涉及多阶段 validation
D1 baseline difficulty
```

然后分别看：

\[
MemoryGain_{easy}
\]

\[
MemoryGain_{medium}
\]

\[
MemoryGain_{hard}
\]

特别关注：

\[
MemoryGain_{30round\ baseline\ tasks}
\]

如果 Memory 只改善原本 5 轮就能做完的任务，价值不大。

如果它能够：

\[
D1:\ 30轮失败
\rightarrow
D7:\ 12轮成功
\]

这才是强证据。

---

# 十二、建议增加“失败迁移矩阵”

这和触顶/成功 2×2 可以继续结合。

不仅报告每天的比例，还可以直接看**同一任务从 D1 到 D7 迁移到了哪里**。

例如：

| D1 → D7 | 数量 |
|---|---:|
| Exhausted Failure → Efficient Success | 8 |
| Exhausted Failure → Boundary Success | 2 |
| Exhausted Failure → Early Failure | 1 |
| Efficient Success → Efficient Success | 6 |
| Efficient Success → Failure | 1 |

其中最重要的是：

\[
EF\rightarrow ES
\]

可以定义：

\[
RecoveryConversionRate
=
P(D7=EfficientSuccess
\mid D1=ExhaustedFailure)
\]

这个指标非常贴近当前问题：

> **9B 原来 30 轮做不出来的任务，有多少在 Memory 后真正被救活？**

这是一个很强的核心机制指标。

---

# 十三、还必须关注“回归 / 负迁移”

学习系统不能只统计变好的任务。

需要同时看：

\[
ImprovedTaskRate
\]

\[
UnchangedTaskRate
\]

\[
RegressedTaskRate
\]

特别定义：

\[
RegressionRate
=
P(Score_{D7}<Score_{D1}-\delta)
\]

以及：

\[
MemoryInducedRegressionRate
=
P(Score_{ON}<Score_{OFF}-\delta)
\]

这样可以发现：

> 平均分提高，其实是 5 个任务大幅提高、另外 8 个任务被伤害。

均值会把这个问题隐藏掉。

---

# 十四、Held-out Transfer 还要增加“泄漏检查”

既然要证明 Transfer：

> 测试任务绝对不能以 exact 或 near-duplicate 的形式进入 Memory。

因此建议记录：

\[
MemoryLeakageRate
\]

目标必须：

\[
MemoryLeakageRate=0
\]

不仅检查：

```text
task_id 不一样
```

还应该检查：

- prompt near duplicate；
- object IDs 不同但模板相同；
- teacher trajectory 是否直接来自测试实例；
- future task 有没有因为数据流水线错误提前进入 library。

否则所谓：

\[
TransferGain
\]

有可能还是 replay。

---

# 十五、建议做少量“重复运行稳定性”审计

如果每个 task 每天只运行一次，可能受到：

- sampling；
- Tool 网络状态；
- Judge；
- 环境 timing；

影响。

不需要全面重跑。

只选比如：

```text
5 个典型任务
×
3 次重复
```

看：

\[
RunToRunVariance
\]

这样可以知道：

> +5pp 到底是真变化，还是模型自然波动。

这尤其适合：

- 高分任务；
- 30 round 失败任务；
- Memory 明显改善任务；
- Memory 反向退化任务。

---

# 十六、成本里还缺“Teacher Memory 摊销成本”

现在有：

\[
CostAdjustedQuality
\]

但 Teacher 生成经验属于前置成本。

如果教师为一个 Memory 花：

\[
C_{teacher}=100
\]

后来这个经验被复用 100 次：

\[
AmortizedCost=1/use
\]

如果只用一次：

\[
AmortizedCost=100/use
\]

所以真正比较：

> 9B + Memory vs 27B

时应该加入：

\[
AmortizedTeacherCost
=
\frac{TeacherPlanGenerationCost}
{SuccessfulReuseCount}
\]

最终：

\[
TotalSystemCost
=
StudentInference
+
Escalation
+
AmortizedTeacherMemory
+
MemoryInfrastructure
\]

这才能公平回答：

> “9B + 外部经验到底便宜多少？”

---

# 十七、建议把指标体系升级成七层

| 层级 | 要回答的问题 | 核心指标 |
|---|---|---|
| **1 Outcome** | 做成了吗？ | Score、HardPass、FunctionalSuccess |
| **2 Autonomy** | 靠自己做成了吗？ | Escalation、AutonomousFunctionalSuccess、Gate FN/FP |
| **3 Trajectory** | 是不是少绕路？ | EfficientSuccess、ExhaustedFailure、Success@K、Repeat/Retry |
| **4 Retrieval** | Memory 找对了吗？ | Coverage、UsefulHit、FalseHit、NegativeTransfer |
| **5 Plan Execution** | 9B 能执行教师经验吗？ | Adoption、StepCompletion、Deviation、Replan |
| **6 Memory Quality** | 经验库本身好吗？ | Utility、Conflict、Staleness、Reuse、Leakage |
| **7 Economics** | 值不值得？ | Latency、Token、Escalation Cost、Amortized Teacher Cost |

---

# 十八、如果只能再补 8 项，优先补这些

因为 D 阶段已经起跑，不建议无限增加指标。按价值排序：

1. **Oracle Teacher Plan diagnostic condition**
2. **Efficient Success / Boundary Success / Early Failure / Exhausted Failure 2×2**
3. **Success@5/10/15/20/30**
4. **Useful Hit / False Hit / Negative Transfer**
5. **Plan Adoption / Plan Deviation**
6. **Functional Success，而非只有 Judge score**
7. **Treatment Compliance + snapshot/hash 校验**
8. **D1 ExhaustedFailure → D7 EfficientSuccess 的 RecoveryConversionRate**

这八个基本可以把核心假设完整闭环。

---

# 十九、最终“突破 30 轮”的判定建议

不要定义成：

> CapRate 下降。

而定义成一个机制组合条件：

\[
EfficientSuccessRate_{D7}
>
EfficientSuccessRate_{D1}
\]

同时：

\[
ExhaustedFailureRate_{D7}
<
ExhaustedFailureRate_{D1}
\]

且：

\[
FunctionalSuccess_{D7}
\ge FunctionalSuccess_{D1}
\]

并且：

\[
NegativeTransferRate
\text{ 不出现明显恶化}
\]

再加上：

\[
TreatmentCompliance=100\%
\]

如果 Memory-on 与 Control 的 paired comparison 也支持同样方向，那么才可以比较稳地说：

> **教师经验外置没有简单延长或缩短运行，而是真正将部分原本“耗尽 30 轮仍失败”的任务，转化成了“在回合预算内成功完成”的任务。**

这个 claim 会比“30 轮触顶率从 40% 降到 15%”强很多。

而 **Oracle Teacher Plan 条件** 是这轮补充里价值最高的一个，因为它第一次能把“Memory 检索能力”和“9B 执行教师规划的能力”真正拆开。如果这一层不做，后面无论成功或失败，都容易把多个机制混在一起解释。
