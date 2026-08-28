# Turbo-pi 自我进化工程设计方案

日期：2026-08-27  
状态：**V3 对抗审查定稿（Kimi × Codex 五轮收敛），待 Phase 0b 参数预注册；不授权代码实施、配置切换或真实跑批**  
定位：在现有“本地学生 + 云端教师 + 经验库”体系上，建设可执行、可归因、可回滚的 AI 自举能力  
上游约束：`2026-08-13-agent-server-high-level-design-v2.md`、`plans/2026-07-31-agent-self-evolution-roadmap.md`、`plans/2026-08-11-self-improve-skill-plan.md`、`plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`

## 1. 技术结论

当前工程已经具备自我进化的四个重要零件：完整 agent/tool loop、会话与 trace 留痕、离线经验提炼管线、经验检索注入与生命周期管理。但它目前只能称为**经验层自适应系统**，还不能称为完整的“自我进化 harness”，原因是：

1. 被自动改变的主要对象是经验数据，而不是 agent 的控制流、工具策略、prompt、检索策略或源代码。
2. 经验晋升主要依赖 LLM 偏好分与固定阈值；真实任务可执行结果尚未成为统一晋升依据。
3. 没有统一的候选 artifact、父子谱系、版本化运行合同、候选种群和跨代档案。
4. 没有与被优化对象形成可执行信任边界的评估核；系统若开始改 verifier、测试或运行器，会形成直接的 Goodhart/Wireheading 路径。
5. 没有完整的 `candidate → shadow → canary → active → rollback` 发布状态机。

因此，推荐路线不是直接允许 agent 改自己的主分支，而是建设一个**双时间尺度、三层变异面、一个可信评估核**的系统：

- 快环：每个任务记录结果、归因和失败信号，只生成证据，不改变 active 版本。
- 慢环：按失败簇生成经验、配置或代码候选，在隔离环境做可执行评估。
- 变异面依次开放：经验数据 → 支架配置 → 源代码；越靠后，权限越小、门槛越高。
- 可信评估核独立维护任务清单、grader、预检、预算、安全策略和晋升裁决；被优化者无权修改。

目标架构吸收 OpenRSI 的统一进化算子与执行反馈、DGM 的谱系档案和开放式分支、AlphaEvolve 的多 evaluator 反馈、SICA 的自改代码沙箱，以及 autoresearch 的“固定评估核 + 单一变异面 + 定额实验 + keep/discard 日志”纪律；但不照搬 OpenRSI 的权重训练路线，不照搬 DGM 的自动源码替换，也不照搬 autoresearch 的无限单指标爬山。当前仓库的首要目标是**可验证的 harness 自举**，不是宣称通用递归自我改进。

## 2. 范围与成功定义

### 2.1 本方案中的“自我进化”

只有同时满足以下五项，才计为一次有效的自我进化：

1. 系统根据自身真实轨迹提出对自身能力载体的修改。
2. 修改形成不可变候选，带父版本、操作符、证据和内容哈希。
3. 候选在独立执行环境由外部 evaluator 验证，不以候选自报分数裁决。
4. 候选在未参与生成/调试的任务上改善预注册指标，且安全、成本和尾部风险不过界。
5. 晋升后的版本成为下一代候选的父版本；失败候选按数据分级与保留策略留下可审计的谱系、裁决或删除墓碑，不默认永久保存原始内容。

只做“反思后写一条记忆”属于学习；只改 prompt 后人工看起来更好属于调优；只有上述闭环才属于本方案所说的工程化自我进化。

### 2.2 近期目标

- 保持“不微调、外挂记忆”的既有产品约束。
- 先让经验与支架配置可验证进化，再评审是否开放源码级候选。
- 让重复任务的教师升级率下降，同时任务成功率不降、灾难率不升、云成本下降。
- 每个结论可追到任务、轨迹、候选、父版本、评估合同和最终裁决。

### 2.3 非目标

- 不在本阶段修改模型权重或建设 RL/SFT 训练集群。
- 不允许 agent 自动合并主分支、自动 push、自动发布或自动修改线上数据库。
- 不允许候选修改 evaluator、held-out manifest、preflight、DLP、预算器和回滚器。
- 不把 benchmark 分数单点上涨等同于系统能力提升。
- 不以同一任务的多次重复冒充更多独立样本。

## 3. 当前工程结构与职责

| 层 | 主要路径 | 当前职责 | 对自举的价值 |
|---|---|---|---|
| 模型适配层 | `packages/ai` | 多 provider 统一流式 API、模型目录与兼容映射 | 保持进化结果与单一模型解耦，可做跨模型迁移验证 |
| 在线 agent 核 | `packages/agent/src/agent-loop.ts` | LLM 响应、工具调用、steering/follow-up、turn hooks | 可插入策略版本、任务级 detector、候选控制流 |
| harness/session | `packages/agent/src/harness/`、`packages/coding-agent/src/core/agent-session.ts` | 资源加载、扩展钩子、session 树、compaction、retry | 支架变异的主要目标面；已有热加载与可观测事件 |
| 多实例监督 | `packages/orchestrator` | 启停 pi RPC 实例并持久化状态 | 可作为未来 worker adapter，但当前不是可靠任务调度/隔离器 |
| 经验在线层 | `packages/agent-server/src` | 检索、注入、session/trace、OpenAI 代理 | 已形成闭环的数据入口与在线观测点 |
| 经验离线层 | `packages/agent-server/src/offline` + `python/*` | ETL、三管线、verifier、晋升、复评、checkpoint | 当前自适应核心；可演进为候选生成器的一种 operator |
| 路由层 | `packages/agent-gateway` | 本地学生质量门控、云教师升级、DLP/预算 | 产生重要失败/教师纠正信号，但不应承载跨回合 harness detector |
| 评估与运维 | `packages/agent-server/eval`、未来私有 `packages/evaluation-kernel`、`doc/issues-snapshot`、`doc/design` | A/B、judge、preflight、问题回归、决策记录 | 现有脚本是输入资产；可信评估核必须形成独立包、进程、OS 身份与凭据边界 |

工程边界判断：`packages/orchestrator` 目前只管理进程与 RPC 状态，没有任务 DAG、租约、隔离 worktree、资源预算和 evaluator 不可变性。第一版进化控制器不应把安全关键逻辑放入该实验包；可以把它作为 worker 启动适配器，控制面仍放在 agent-server 的离线域或新建独立私有包。

## 4. 当前 loop 设计

### 4.1 在线执行 loop

`packages/agent/src/agent-loop.ts` 是核心状态机：

```text
用户消息
  ↓
外层循环：处理一批 follow-up
  ↓
内层循环：LLM → tool calls → tool results → 下一 turn
  ├─ steering 可在下一次 LLM 前注入
  ├─ beforeToolCall / afterToolCall 可拦截或改写
  ├─ prepareNextTurn 可刷新 model/context/tools
  └─ shouldStopAfterTurn 可在完整 turn 后停止
```

关键优点：

- tool call 在执行前验证参数；长度截断时整批拒绝，避免执行半截参数。
- 工具可顺序或并行执行，最终 tool results 保持源顺序。
- 每 turn 都可以刷新 system prompt、tools、model 和 thinking level。
- extension/harness 钩子已经覆盖 context、tool call、tool result 和 session 生命周期。

关键限制：

- loop 负责“完成当前任务”，不负责“比较并选择下一代 loop”。
- 当前动态刷新没有强制绑定一个不可变 `scaffoldVersion`。
- compaction、retry、follow-up 是可靠性机制，不是能力进化机制。

### 4.2 在线经验 loop

```text
最后一个真实 user query
  → FTS5 bm25 候选
  → token-set cosine × confidence 重排
  → domain 过滤
  → EVIDENCE / Method / Guard 注入 user 消息
  → SKILL 目录注入 system prompt
  → SOP 注入 tool schema
  → 请求 trace 记录 retrieved/injected ids
```

当前实现支持 active/dormant/removed 生命周期、精确 contentHash 去重、按置信度降权、情景域过滤和请求级归因。这是良好的经验数据面，但检索与注入策略仍以固定规则为主：候选 24、最终 top-k、Method/Guard 各 5、Skill 10、SOP 15，以及固定拼接位置都没有进入统一版本合同。

### 4.3 离线经验进化 loop

`runDailyEvolution` 当前执行：

```text
完整 session JSONL
  → ETL：句子级 dormant EVIDENCE
  → skill_evolution / sop_lifecycle / verification_selection
  → LLM pairwise / vs-reference 评分
  → 交付物字段与 schema 检查
  → quality ≥ 0.5 晋升
  → dormant 有界复评、TTL/cap 清理
  → checkpoint
```

已经具备的工程质量：

- 半截 session 隔离、幂等重跑、事务晋升、断点评分和 prompt 指纹失效。
- 实战置信度与复升排除能阻断“自评分复升→再注入→再失败”的直接循环。
- 低分候选保留 dormant 并受 TTL/cap 控制，不会无限增长。

尚未闭环的关键点：

- ETL 把轨迹压成首个 user task + assistant/tool 文本，丢失环境状态、产物差异、工具前后置条件和 grader 结果。
- 主 verifier 判断“文本轨迹比最小参照更好”，不等于候选在真实任务上产生正效用。
- SKILL 暂缓晋升；SOP 的 `quality=1` 表示管线预验证，而非统一 held-out 任务验证。
- active 经验会直接影响后续请求，但缺少完整 shadow/canary 发布阶段。
- 日批 checkpoint 的 metric 是晋升条数，不是能力提升量。

### 4.4 路由与评估 loop

gateway 的质量门控解决单请求层面的本地失败与云端升级；D 阶段与 post-D 方案已经把独立 workspace、arm 等价、确认集封存、真实 token、尾部灾难率和任务级 shadow detector 列为硬门。这部分不应被新自举系统复制，应直接升级为统一的可信评估核。

## 5. 外部实现的可迁移经验

### 5.1 OpenRSI / OpenMLE

OpenRSI 把 AI4AI 限定在可执行的机器学习工程域，使用 OpenMLE-Gym、OpenMLE-RL、OpenMLE-Evo 连接任务环境、操作符学习和长程搜索，并把 `Draft / Improve / Debug / Crossover` 同时用于训练和推理。其最值得迁移的不是大模型后训练，而是：

- 统一操作符空间；
- 程序/候选数据库包含 parent、generation mode、score、reward、feedback；
- 真实 sandbox score 用于父代选择，模型自评分默认不可信；
- 标准与异步搜索共享 journal、checkpoint、memory、parent selection 和输出合同；
- 验证集与公开结果有明确外部依赖和复现边界。

对本工程的映射：把“程序”扩展为 `EvolutionArtifact`，支持经验库、scaffold 配置和代码 patch；暂不引入 RL 权重更新。

### 5.2 Darwin Gödel Machine（DGM）

DGM 的核心不是单链 hill-climbing，而是保留一个不断增长的 agent 档案，从不同祖先分叉；较弱祖先也可能成为后续突破的 stepping stone。源码修改在 Docker 中完成，patch、父版本、运行日志和 benchmark 结果组成谱系。

对本工程的映射：

- 保留 top-performing、novel、safe 三类候选，而不是只保留单一最高分版本。
- 所有源码候选只以 patch artifact 存储和评估，不直接写 active 工作树。
- 候选失败不删除，记录失败类型和适用边界，用于避免重复探索。

### 5.3 AlphaEvolve / ADAS / SICA

- AlphaEvolve 表明 LLM 候选生成必须由一个或多个自动 evaluator 持续反馈；适合可自动判分的程序与策略，不适合把主观 judge 当唯一真值。
- ADAS 的 growing archive 支持组合和跨模型/跨域验证，但后续研究也提醒：盲目扩大历史上下文可能降低效果，搜索成本在大量部署前未必经济。
- SICA 展示了 agent 在自身代码库上工作、保存每代完整代码与 benchmark 轨迹的最小闭环，并明确要求容器隔离。

工程裁决：采用“档案 + 可执行 evaluator + 成本核算”，拒绝“把全部历史塞进 meta-agent context”和“无沙箱直接自改”。

### 5.4 autoresearch

Karpathy 的 autoresearch 把自主研究压缩成三个角色清晰的文件：

| autoresearch | 职责 | Turbo-pi 映射 |
|---|---|---|
| `prepare.py` | 固定数据、时间预算和 `evaluate_bpb`；agent 禁止修改 | TEK：固定任务、grader、preflight、预算与 verdict |
| `train.py` | agent 唯一可修改对象 | scope manifest 指定的 experience/scaffold/patch artifact |
| `program.md` | 人类编写的研究目标、操作边界和循环协议 | 人类拥有的 evolution policy；运行期间候选不可修改 |
| `results.tsv` | commit、指标、资源、keep/discard/crash、假设摘要 | append-only experiment ledger；数据库为真值，可导出 TSV |
| 独立实验分支 | 保存当前 winner，失败试验回退 | 每 run 独立临时 worktree + immutable artifact，不 reset 共享分支 |

其可迁移价值：

- **先跑 baseline**，没有 generation-0 基准就不开始优化。
- **单一、显式变异范围**，避免 agent 同时修改目标、数据和评价器。
- **固定资源预算**，使不同架构尝试在同一平台上可比较。
- **一轮一个假设**，修改、运行、读机械指标、记录、保留或丢弃。
- **失败也记录**，crash/near-miss 是搜索证据，不应从历史中消失。
- **复杂度纳入判断**，相同效果下删除代码优于增加脆弱机制。

不能直接照搬的部分：

1. `val_bpb` 是近确定性的单一标量，而 agent 成功、安全、成本和尾部风险是多指标且高方差，不能用“一次分数更好就 keep”。
2. 固定五分钟训练预算适用于同机训练搜索；Turbo-pi 应固定 task manifest、采样合同、token/金额和 wall-time 上限，并采用 paired block。
3. “loop forever”不适合会出云、写文件和调用工具的 agent；必须有最大试验数、连续 crash 上限、预算耗尽、平台期和人工 kill switch。
4. autoresearch 用 git commit/reset 管理单人独立分支；本仓库是共享脏工作区且禁止未经授权 commit，必须改为临时 worktree、patch artifact 和 slot 切换。
5. 原版 `program.md` 由人修改，不是被优化对象。若未来允许系统改进 evolution policy，那是双层 meta-evolution，必须另开 Go Gate，不能与目标 artifact 同轮共同变化。

工程裁决：把 autoresearch 作为**候选族内部的有界微循环**；OpenRSI/DGM 式 archive、TEK 和 promotion controller 继续作为外层选择与治理。

## 6. 目标架构

```text
                         ┌──────────────────────────────┐
                         │ Trusted Evaluation Kernel    │
                         │ manifests / graders / DLP    │
                         │ preflight / budget / rollback│
                         └──────────────┬───────────────┘
                              │ signed attestation
┌──────────────┐  evidence  ┌───────────▼───────────┐  candidate  ┌─────────────────┐
│ Runtime Loop │───────────▶│ Evolution Controller │────────────▶│ Artifact Archive│
│ agent/gateway│            │ select/operator/search│             │ lineage + blobs │
└──────┬───────┘            └───────────┬───────────┘             └────────┬────────┘
       │                                │ isolated job                       │
       │ active version                 ▼                                    │ parent
       │                    ┌────────────────────────┐                        │
       └────────────────────│ Sandbox Worker Pool    │◀───────────────────────┘
                            │ fresh worktree/container│
                            │ unit/replay/shadow eval │
                            └────────────┬───────────┘
                                         │
                              ┌──────────▼──────────┐
                              │ Promotion Controller│
                              │ shadow→canary→active│
                              │ rollback/quarantine │
                              └─────────────────────┘
```

### 6.1 四个子系统

1. **Evidence Plane**：统一 session、tool event、gateway escalation、grader、产物哈希、用户纠正和成本。
2. **Evolution Controller**：选择失败簇、父版本和 operator，生成候选，管理预算与搜索队列。
3. **Trusted Evaluation Kernel（TEK）**：作为独立私有包和独立进程，以不同 OS 身份、凭据与签名 bundle 提供任务、grader、安全/成本门和 evaluation attestation；候选和 controller 只能通过窄 IPC/API 调用，不能链接进同一进程或取得其写权限、内存与签名凭据。
4. **Artifact Archive + Promotion Controller**：保存谱系，执行 shadow/canary/active/rollback 状态机。

### 6.2 三层变异面

| 层级 | 可变对象 | 自动化上限 | 晋升要求 | 回滚 |
|---|---|---|---|---|
| M1 经验层 | cards、skills、SOP 候选、检索先验 | 可自动生成；经 TEK attestation 后仅可自动进严格 shadow | 可执行 replay + 新任务确认；无尾部伤害 | 切回冻结库 SHA |
| M2 支架配置层 | system prompt 片段、检索/注入参数、工具启用、compaction/retry 策略 | 自动生成与评估；人工批准 canary/active | 配对 held-out + 声明的 model scope 验证 + 安全/成本门 | 切回 scaffoldVersion |
| M3 源码层 | capability-limited candidate extension、tool/loop 策略、代码 patch | 仅隔离生成；人工批准每次 canary/merge | 全检查、专项测试、benchmark、人工 diff 审查 | 停 canary + 切回上一不可变 bundle |

严格 shadow 不改变用户输出、工具副作用、active memory 或 deployment slot，只在预批准预算内执行离线/并行评估；任何影响用户或外部系统的运行都属于 canary，必须人工批准。

TEK、preflight、任务 manifest、grader、DLP、预算器、promotion controller 永久属于 M0 不可变面，任何候选不得修改。这里的“不变”不是目录约定：M0 使用独立安全主体、独立凭据、签名 bundle、只读挂载和 OS/容器 capability 强制；policy/denylist 与静态扫描只做纵深防御，不构成安全证明。

## 7. 核心数据模型

建议新建独立 `evolution.db`，不把搜索实验状态继续塞入 `experience.db`。经验库可以是候选 artifact 的一个 blob，但不承担进化控制面。

### 7.1 `artifact_immutable_manifests`

| 字段 | 含义 |
|---|---|
| `artifact_id` | 内容寻址 ID：`sha256(canonical manifest + blob hashes)`；内容变化即新 ID |
| `kind` | `experience_snapshot / scaffold_config / source_patch / composite` |
| `parent_ids` | 1 个为 improve/debug，2 个以上为 crossover |
| `operator` | `draft / improve / debug / crossover / consolidate / rollback` |
| `scope` | 允许修改的文件/字段白名单 |
| `evidence_refs` | 触发候选的失败簇、issue、trace、task IDs |
| `scaffold_hash` | system prompt、tools、extensions、settings、代码 commit 的组合哈希 |
| `model_fingerprint` | 生成候选所用模型与采样合同 |
| `data_class` | artifact/evidence 的数据等级与可关联性 |
| `retention_policy_ref` | TTL、legal hold、erasure、tombstone 与冷存策略引用 |
| `created_at` | 创建时间 |

manifest 不含可变 `status`。候选身份、评估裁决和部署状态必须正交，不能靠修改同一行表达生命周期。

### 7.2 `evaluation_attestations`

TEK 只追加并签发 evaluation attestation，记录 `attestation_id`、artifact、baseline、task manifest SHA、grader SHA、workspace tree SHA、运行环境/容器/lockfile SHA、provider/model、采样合同、预算、metrics hash、verdict、真实 token、成本、trace、失败分类、`signer_key_id`、签名和时间。同一 artifact 可有多次 attestation；撤销旧裁决必须另发 revocation event，不能覆盖历史。

### 7.3 `artifact_metrics`

按任务保存：成功、交付完整性、测试通过、灾难失败、工具失败、步数、延迟、token、云升级、DLP finding、用户纠正。聚合统计是派生视图，不作为唯一证据。

### 7.4 `lineage_edges`

保存 parent/child/operator、差异摘要和遗传来源。crossover 必须指出每项配置或 patch hunk 的来源父代，避免“名为交叉、实为重写”。

archive 为证据存储，不是 generation prompt。候选生成时只检索 token 预算内的摘要和元数据；低价值或过期 blob 转冷存或按 retention policy 删除，禁止把全量 archive 注入上下文。

### 7.5 `deployment_event_stream`

独立 `audit_writer` 使用与 TEK 不同的凭据，只追加签发 `shadow/canary/active/rollback/quarantine/reject` 事件。事件至少含 slot、artifact、previous artifact、操作者、原因、时间、key ID 和签名；当前槽位是事件流的派生视图，CAS 比较上一 artifact/event。slot 只指向内容寻址 bundle 或 OCI 镜像，运行时禁止从共享工作树解析 active 版本。

### 7.6 `runtime_resolved_manifests`

每个任务记录实际加载真值：task/slot/artifact、所有 blob SHA、实际 provider/model/API 标识、resolved scaffold hash、环境快照 hash、时间及对应 deployment event。它用于发现“slot 声称版本”与“进程实际加载版本”的错位。

### 7.7 审计完整性与保留

`evaluation_signer` 只签 evaluation attestation；`audit_writer` 签 deployment/lineage/event。生产事件链周期锚定到外部 WORM/只读审计域，并定义 key ID、轮换、吊销和验证策略；本地开发哈希链只用于断链诊断，不宣称能抵抗管理员重写。

Phase 0 按 data class 定义 TTL、legal hold、erasure、tombstone 与聚合规则。无法证明合法保留依据的可关联内容必须删除；只有经验证不可逆且不可关联的聚合统计可以越过原始数据 TTL。内容哈希若仍可关联到任务或用户，也受同一删除策略约束。

## 8. 统一进化协议

### 8.1 证据收集快环（每任务）

1. 运行时固定记录 `artifact_id/scaffold_hash/experience_snapshot_sha`。
2. 保存任务输入、工具事件、产物 manifest、grader、真实 token/成本和终止原因。
3. 任务结束后机械计算 outcome；LLM 反思只作为诊断文本，不作为成功真值。
4. 把失败按“环境、模型、支架、检索、经验内容、交付、judge”分类；不确定项保留 unknown。
5. 只追加 evidence，不直接改变 active slot。

### 8.2 候选生成慢环（日/周）

1. 选择满足最小样本数和复发阈值的失败簇。
2. 为失败簇选择最小变异面：能用经验修复就不改配置，能用配置修复就不改源码。
3. 从档案选择父代：性能父代、novelty 父代或安全父代。
4. 使用统一 operator 生成候选：
   - `draft`：从证据构造新 artifact；
   - `improve`：针对低分指标小步修改；
   - `debug`：针对编译、契约或明确回归修复；
   - `crossover`：合并不同父代已验证特性；
   - `consolidate`：合并重复经验/配置，不改变目标行为；
   - `rollback`：生成指向上一已知良好版本的操作记录。
5. 静态策略门检查 scope、大小、敏感路径、依赖和预算；不通过即 quarantine。

#### 8.2.1 autoresearch 式候选微循环

每个失败簇或研究主题创建一个不可变 `ExperimentProgram`，至少包含：

- baseline artifact；
- 唯一可变 scope；
- 不可变 evaluator/manifest SHA；
- 本轮假设和预期作用指标；
- primary metric、所有 hard guardrails 与复杂度预算；
- 固定任务、采样、token、金额、wall-time 和 worker 数合同；
- `maxTrials`、`maxConsecutiveCrashes`、平台期和总预算停止规则。
- search/dev、selection、confirmation 三层任务 manifest 及每层反馈披露预算；
- 预注册效应量、分析单位、重复测量处理、多重比较/可选停止控制和最低功效。

微循环为：

```text
baseline
  → 提出一个可证伪假设
  → 生成一个最小候选 artifact
  → policy/static check
  → 固定小样本 paired screen
  → ledger 记录 keep_provisional / discard / crash
  → 从 provisional winner 继续，或从 archive 选择新父代
  → 达到 promotion 样本门后转完整 validation
  → 预算/平台期/事故门触发即停止
```

`keep_provisional` 只表示进入本次搜索的当前前沿，不表示可以 shadow/canary/active。provisional 只能消费 search/dev；selection 只用于有限次候选选择，confirmation 在候选与规则冻结后才解封。所有 trial，包括 discard 和 crash，都进入带签名/锚定策略的只追加审计链；禁止用回退覆盖失败证据。

### 8.3 隔离评估

每个候选必须使用全新 worktree/目录和独立服务实例：

1. 构建与加载检查。
2. 受影响最小测试集。
3. 全局 `npm run check`；若修改测试文件，运行对应专项测试；是否运行完整 `./test.sh` 由阶段任务授权决定。
4. 历史失败 replay，但 replay 只证明修复，不计泛化收益。
5. 未见 validation 任务做 paired baseline/candidate。
6. 范围验证：默认至少覆盖学生模型与一个异构模型；允许 artifact 预注册 `model_scope`，专用候选只在声明范围内裁决且不得替换范围外的全局 active。
7. 安全与资源检查：DLP、网络、文件写入范围、超时、token、成本、进程残留。

源码候选必须在容器或等价强隔离环境执行；宿主工程只接收 patch、日志和结果 artifact。构建默认 hermetic，只允许按固定 lockfile 访问受控内部镜像；缺失依赖不能临时直连公网，只能提交带审批人、来源、内容哈希、有效期和原因的 signed exception manifest，下载后进入隔离镜像并留审计事件。runtime 默认无网，仅按任务开放模型代理或测试端点，使用临时最小权限凭据并经过 DLP，其他 egress 默认拒绝。

rollback 只承诺恢复 artifact 记录的 code/config/library 与可控运行合同。runtime manifest 记录可获取的 provider/model/API 标识、端点指纹与响应头；若 provider 不暴露版本，必须标记 `external_drift/unknown`。远程 provider 权重、服务实现或外部 API 漂移无法由本系统回滚，标记 `external_drift/non_reproducible` 并触发重新基线，不能宣称复现成功。

### 8.4 评估与部署双状态机

```text
不可变 artifact
  → policy/build/unit/replay/selection/confirmation attestations
  → verdict: pass / reject / quarantine / inconclusive / revoked

通过 verdict 的 artifact
  → shadow event
  → canary_pending_approval event → canary event
  → active_pending_approval event → active event
  → rollback event（任意已部署槽）
```

artifact 内容永不修改；新内容必须产生新 artifact ID。评估结论由 attestation 集合派生，部署状态由每个 slot 的事件流派生，不能互相覆盖。M2/M3 的 canary 和 active 都需要人工批准。M1 在 TEK attestation 与预批准预算内可自动进入严格 shadow，但不能自动替换 active 库。

## 9. 评估函数与父代选择

### 9.1 指标组

| 组 | 主要指标 | 硬门 |
|---|---|---|
| 效用 | paired task success、`score_simple`、交付完整性 | 置信下界达到预注册最小实用收益 |
| 安全 | 灾难率、越权写入、DLP、错误 tool call | 不得超过绝对率、差值与严重度上界；重大事件单例熔断 |
| 可靠性 | 方差、超时、empty output、重试、进程残留 | 不劣于 baseline 门限 |
| 成本 | token、云成本、wall time、工具调用数 | 单位成功成本不恶化，或有明确收益补偿 |
| 复杂度 | 配置项、代码行、分支数、依赖、维护面 | 同等效果优先更简单；超出 scope/依赖预算直接拒绝 |
| 自举速度 | 单位计算预算带来的验证后增益 | 只作长期趋势，不单独晋升 |
| 多样性 | 与 archive 中候选的行为/结构距离 | 用于保留候选，不覆盖安全/效用硬门 |

### 9.2 保守 fitness

不使用简单加权平均掩盖灾难。推荐两级裁决：

1. 先过硬门：安全、交付、测试、预算、统计功效。
2. 再在可行候选中做 Pareto 排序：效用、成本、延迟、升级率、novelty。

autoresearch 的“更好即 keep”只用于固定小样本的 provisional frontier；正式晋升要求完整 validation。效果统计不可区分时，以复杂度更低者胜；复杂度更高者必须提供预注册的最小额外收益。

稀有灾难使用零事件频率上界或预注册的贝叶斯上界，不把“未观察到”解释为“安全”。预算耗尽仍未达到预注册功效时，裁决必须是 `inconclusive/no-go`，不能以 provisional winner 代替证据。多候选、多次查看与提前停止必须使用预注册的 sequential/multiplicity 控制。

父代采样保留三类：

- `champion`：当前综合最优；
- `stepping_stone`：分数未最高但结构新颖且过安全门；
- `specialist`：特定 domain 明显更好，不能直接替换全局 active。

这比单一 `quality >= 0.5` 更接近 DGM/OpenRSI 的搜索逻辑，也避免早期收敛。

### 9.3 防污染

- search/dev、selection、confirmation 三组任务严格隔离；长期 campaign 按预注册比例补入未被自适应消费的新鲜任务。
- 候选生成器只能看到 search/dev 失败和 selection 的最小聚合 verdict；不得看到 confirmation 任务、答案或逐题反馈。
- evaluator 输出给候选生成器的是最小必要反馈，不直接暴露隐藏测试。
- 确认集 manifest、runner denylist 与 artifact hash 三重约束。
- 任务、grader、模型或 scaffold 变化后，旧结果必须按兼容矩阵决定是否失效。

## 10. 与现有代码的集成设计

### 10.1 不改核心 loop，先补版本合同

第一阶段不重写 `agent-loop.ts`。利用现有 `prepareNextTurn`、`transformContext`、`beforeToolCall`、`afterToolCall` 和 session events 注入：

- `artifactId`、`scaffoldVersion`、`experienceSnapshotSha`；
- task-level progress events；
- tool/outcome attribution；
- shadow policy 的只读建议。

这能保持在线执行语义稳定，同时让每条轨迹明确属于哪一代支架。

### 10.2 目录建议

```text
packages/agent-server/src/evolution/
├── artifact-schema.ts
├── artifact-store.ts
├── bundle-builder.ts
├── artifact-registry.ts
├── evidence-selector.ts
├── operators.ts
├── evaluation-controller.ts
├── promotion-controller.ts
├── lineage.ts
└── cli.ts

packages/evaluation-kernel/          # private package + independent process/OS identity
├── manifests/
├── graders/
├── policy.ts
├── runner.ts
├── signer.ts
├── ipc-server.ts
└── verdict.ts

packages/coding-agent/src/core/scaffold/
├── schema.ts
├── resolver.ts
└── fingerprint.ts
```

评估 kernel 与 evolution controller 分包、分进程、分 OS 身份和凭据；控制器只能通过认证 IPC/API 调用 kernel，不能把 kernel 链接进自己的进程，也不能写其代码、bundle、存储或密钥。`bundle-builder` 只接受已批准 manifest/blob，registry 必须以内容寻址方式拒绝同 ID 不同内容。

### 10.3 scaffold v1 合同

把当前静态策略外提为不可变、可哈希配置：

- system prompt 片段版本；
- active tools 与每工具 execution mode；
- retrieval candidate/final limits；
- Method/Guard/Skill/SOP limits；
- 注入位置与 wrapper template；
- compaction threshold/settings；
- retry policy；
- task-level detector 版本；
- provider/model/sampling 支持矩阵。

解析后生成 canonical JSON 和 SHA256；运行时只使用解析后的 snapshot，不直接读取正在变化的文件。

每次运行还必须生成 `runtime_resolved_manifest`，记录实际解析出的 blob、模型/API、环境和对应 deployment event；配置文件声明值不能替代运行时真值。

### 10.4 经验进化 v2

保留现有 Python 提炼作为 `draft/consolidate` operator，但修改晋升含义：

- LLM verifier 分数只作为候选筛选，不直接 active。
- 候选 experience snapshot 在 replay/validation 上与 baseline 快照成对比较。
- 经验、Skill、SOP 使用同一 promotion state machine；不再用不同语义的 `quality=1` 直接跨越产品效用验证。
- 实战 attribution 更新 confidence，但不能单独证明因果；正式晋升仍需受控评估。

### 10.5 源码候选

Phase 5 首批白名单不包含现有 `.pi/skills` 或 `.pi/extensions` 的任意代码。先定义 capability-limited candidate extension ABI，只允许声明式策略或无 I/O 的纯转换；每增加文件、工具、网络、进程或秘密 capability 都必须单独通过 TEK 验证与人工 Go Gate。`packages/agent/src/agent-loop.ts`、评估 kernel、测试删除、AGENTS.md、release/secret 相关路径均 deny。

候选生成输出 unified diff；controller 在临时 worktree 应用。主工作树、用户未提交变更和其他 agent 的文件不能作为候选写入目标。

## 11. 分阶段实施计划

### Phase 0a：冻结原则与 fail-closed 合同（2–3 天）

- 冻结 M0 不可变面和路径 denylist。
- 定义 immutable artifact、evaluation attestation、deployment event、runtime resolved manifest schema。
- 固定 TEK 独立私有包/进程/OS 身份/凭据与窄 IPC 边界。
- 定义 bundle builder/registry 合同，并机械构建、加载一个 generation-0 bundle。
- 把 post-D 的 workspace、trace、确认集、真实 token、issue-023 要求纳入 TEK。
- 固化当前 active experience/scaffold/model/config 指纹为 generation 0。

验收：同一请求可机械重建其完整 generation-0 合同；任何缺字段都 fail closed。

### Phase 0b：预注册运营与数据参数（获得责任人确认后排期）

- 定义 evaluation signer/audit writer 的密钥轮换/吊销、生产 WORM 主体与锚定频率。
- 定义 data class、TTL、legal hold、erasure、tombstone、聚合与 archive 冷存策略。
- 定义 shadow 人工预配置预算、TEK 预算器、耗尽即暂停/拒绝和人工扩额流程。
- 定义 signed dependency exception manifest、内部镜像、运行端点与短期 capability 白名单。
- 定义 candidate ABI capability 扩大顺序、批准人和每次 Go Gate 证据。

验收：所有参数均有责任人、依据、版本、有效期和 fail-closed 默认值；未裁决项不得被计入 generation-0 已冻结合同。

### Phase 1：证据平面（3–5 天）

- 为 session/task 增加 scaffold/artifact/snapshot 关联。
- 保存结构化 tool event、产物 manifest、grader outcome、用户纠正和 gateway escalation join key。
- 结构化 evidence artifact 同时记录工具前后文件哈希、非秘密环境版本、grader outcome 和依赖状态，并与文本轨迹共同进入 `evidence_refs`。
- 建立失败 taxonomy 与 unknown 桶。
- 不改变现有注入和晋升行为。

验收：随机抽样任务可从 task → request → model run → session → artifacts → grader 完整对账，零孤儿记录。

### Phase 2：经验候选 shadow（4–6 天）

- 将现有 offline pipeline 接成 M1 candidate generator。
- 新增版本化 experience snapshot builder 和 lineage。
- LLM 质量门后增加 executable replay/validation；候选仅进入 shadow。
- 用当前 post-D E0/E1 机制验证测量可信度后再做真实比较。

验收：完成一次 `active v1 → candidate v2 → rejected/accepted shadow` 全链，active 未被自动改写，结果可复算。

### Phase 3：scaffold 配置进化（5–8 天）

- 外提 scaffold v1；实现小范围 operator（检索上限、注入模板、工具启用、prompt 片段）。
- 每批最多生成有限候选，设置成本与 wall-time 预算。
- archive 保留 champion/stepping-stone/specialist。
- 实现 autoresearch 式 `ExperimentProgram`、有界 trial loop、签名事件链和 provisional frontier；生产部署时启用外部锚定。
- 人工批准 canary 与 rollback 演练。

验收：至少一个真实候选完成全评估并按预注册门得到可复算的批准或拒绝结论；若获批则经人工进入 canary；无论候选是否获批，一键切回 generation 0 的演练均成功。

### Phase 4：任务级 detector 与 teacher 回流（4–7 天）

- 把跨回合进展、工具失败、交付缺失放在 agent/harness 层 shadow detector。
- gateway 仍只做 request-level 质量门。
- 云教师纠正经 DLP、脱敏、任务 outcome 对齐后进入 evidence plane。
- detector 必须先冻结再做前瞻 shadow，不能用同一批结果训练和测试。

验收：报告及时召回、误报、漏报、升级成本和最小化外发内容；未授权前不自动干预。

### Phase 5：受限源码级自举（单独 Go Gate，7–12 天）

启动条件：Phase 2–4 达到预注册的效用、安全、成本、统计功效与尾部上界稳定门；TEK、rollback 和 confirmation 集无阻断问题。发布周期数只作观察窗口，不替代量化门。

- 首批只开放新建的 capability-limited candidate extension ABI 内声明式策略和纯转换，不开放现有 `.pi/skills`、`.pi/extensions` 任意代码。
- 每候选独立 worktree + 容器，输出 patch 与完整评估 artifact。
- 人工 diff 审查、人工 canary、人工 merge；禁止自动 commit/push。
- 声明的 model/domain scope 验证通过后才可扩大代码白名单。

验收：一次真实的“失败簇 → 源码候选 → 隔离验证 → 批准或拒绝裁决”闭环；获批时再执行人工 canary 与回滚演练，主分支全程无自动写入。

### Phase 6：是否进入权重层（远期决策点）

只有在外挂记忆和支架搜索收益趋于平台期、数据许可与隐私策略允许、可执行训练任务足够时，才评审 OpenRSI 式 SFT/RL。该阶段会改变“不微调”约束，必须单独征得用户明确批准。

## 12. 测试与验收策略

### 12.1 单元/契约测试

- canonical artifact 同内容同 hash，任一语义字段变化 hash 必变。
- 状态机非法跳转、重复晋升和 CAS 冲突 fail closed。
- 候选不得取得 evaluation signer/audit_writer 凭据，不得写 M0 路径，不得与 TEK/runner 共享进程、内存或 OS 身份；静态检查和 runtime capability 审计都必须覆盖。
- 伪造或错 key 的 attestation/event 被拒绝；轮换后旧 key 事件仍可验证或被显式吊销；断链、重复序号、锚点不匹配和 CAS 冲突 fail closed。
- 本地开发链不得被报告为已具备生产 WORM 防重写语义。
- crash 后 journal 可恢复，半截记录不被当成成功。
- worktree 初始树不一致时评估拒绝开始。
- confirmation denylist 在 generation/validation runner 中机械阻断。

### 12.2 回归测试

- issue snapshot 的所有回归测试永久保留。
- 每个自举事故新建 issue snapshot + red/green regression。
- 特别覆盖 evaluator tampering、隐藏测试泄漏、成本字段缺失、trace 错配、workspace 复用、候选绕过 canary。

### 12.3 Live 验收

任何 campaign/pilot/eval 前必须按 `2026-08-19-run-batch-preflight-checklist.md` 核验七类条件，真实探针通过才开跑。Phase 2 之后每阶段均先使用 shadow；真实 canary 必须用户单独批准。

## 13. 运维、安全与治理

- **最小权限**：生成器、worker、TEK、promotion controller 使用不同文件写权限和凭据。
- **网络默认关**：源码候选评估默认无网；需要 provider 时只开放代理端点。
- **构建/运行分权**：构建只访问受控内部镜像且依赖必须命中固定 lockfile；例外必须签名、哈希锁定、限时和留痕。运行只按任务获得短期 endpoint capability，其他 egress 默认拒绝。
- **秘密不入候选上下文**：只传临时能力，不传 credential 文件；日志做脱敏。
- **预算先预留**：每个 evolution run 有 token、金额、wall-time、worker 数硬上限。
- **kill switch**：promotion controller 可立即把 canary/active slot 切回最后已知良好版本。
- **双重审计**：控制面 journal + 运行面 trace 独立记录，最终对账。
- **签名分权**：TEK evaluation signer 与 audit writer 的凭据、权限、轮换和吊销策略分离；生产事件链外部锚定，本地链只作诊断。
- **审批背压**：审批包必须汇总 diff、证据、风险与回滚范围；队列超限时暂停生成，不因积压自动晋升。
- **archive 预算**：generation 仅检索摘要/元数据，设置 token 与检索数量上限；blob 按 data class 冷存或删除。
- **人类保留权**：M2/M3 的批准、代码 merge、扩大变异白名单和进入权重层永远由人决定。

## 14. 关键风险与对策

| 风险 | 具体路径 | 对策 |
|---|---|---|
| Reward hacking | 候选改 grader/测试或只迎合 judge | TEK 可执行信任边界、独立签名主体、可执行 grader、多指标硬门 |
| 自适应验证过拟合 | 多候选反复查看同一 validation/逐题反馈 | search/dev-selection-confirmation 分层、反馈披露预算、新鲜任务、sequential/multiplicity 控制 |
| 审计链重写 | 同一控制器改历史 trial/verdict/deployment | evaluation signer/audit writer 分离、签名事件、生产 WORM 锚定、断链验证 |
| 数据污染 | 候选看到 confirmation 答案 | manifest + runner denylist + 最小反馈 + hash 审计 |
| 单模型过拟合 | prompt 只适配当前 9B/27B | 跨模型验证，model×harness 分开报告 |
| 单链早熟收敛 | 永远从 champion 微调 | archive + novelty + specialist + crossover |
| 经验毒化 | LLM 高分但真实任务致害 | 质量分只做筛选，shadow/paired outcome 决定晋升 |
| 自改破坏宿主 | agent 直接写主工程 | 临时 worktree/container、patch artifact、无自动 merge |
| 成本失控 | meta-agent 搜索比收益更贵 | 固定预算、停止规则、单位成功成本与设计摊销期 |
| 回滚失效 | 配置/库/代码版本互不匹配 | composite artifact 同时固定 code/config/library/model 合同 |
| 外部漂移不可回滚 | provider 权重/API/依赖镜像变化 | runtime resolved manifest、外部漂移标记、重新基线，不宣称完全复现 |
| 错误归因 | 同时改变模型、剂量、内容、workspace | 复用 post-D 因果隔离与 canonical request hash |

## 15. Go/No-Go 门

| 门 | Go 条件 | No-Go/回退 |
|---|---|---|
| G0 证据面 | 完整对账、独立 workspace、真实 token、TEK fail closed | 继续只记录，不生成候选 |
| G1 经验 shadow | 未见任务有效用信号且灾难率不过界 | 冻结 v1，修检索/质量或停止记忆路线 |
| G2 scaffold canary | paired 效用过门、声明的 model scope 成立、回滚演练通过 | 只保留 archive，不进 canary |
| G3 源码自举 | 预注册效用/安全/成本/功效/尾部上界稳定门通过，TEK/rollback/确认集无阻断 | 保持配置级进化 |
| G4 权重层 | 数据/隐私/算力/收益均有独立论证 | 永久维持外挂记忆 + harness 进化 |

## 16. 推荐的下一步

本方案不建议马上实现源码自改。下一授权包应只包含 **Phase 0a 的设计细化与 TDD 任务书**，并与已批准但未实施的 post-D `P0 + E0` 合并去重；Phase 0b 的责任人与参数确认完成后，才进入 Phase 1。实施顺序为：

1. 先补可信测量与 artifact/scaffold 指纹。
2. 再把现有经验管线改成“生成候选、只进 shadow”。
3. 确认经验层确有可重复收益后，开放小范围 scaffold 配置搜索。
4. 源码级自举作为单独 Go Gate，不与经验 v2 同批开发。

这条路线最大化复用现有资产，同时把最危险的自修改能力推迟到评估核、谱系、隔离和回滚均被真实验证之后。

## 17. 证据来源

### 工程内

- `README.md`：当前五层架构和经验学习目标。
- `packages/agent/src/agent-loop.ts`：在线双层 loop、工具执行与 turn hooks。
- `packages/agent/src/harness/agent-harness.ts`：context/tool/session hooks 与 turn refresh。
- `packages/coding-agent/src/core/agent-session.ts`：session 持久化、extension、compaction、retry。
- `packages/agent-server/src/offline/scheduler.ts`：每日进化顺序与 checkpoint。
- `packages/agent-server/src/offline/pipeline.ts`：TS→Python 三管线、轨迹压缩与断点。
- `packages/agent-server/python/verification_selection/pipeline.py`：pairwise/vs-reference、交付检查、卡片抽取与 canonicalize。
- `packages/agent-server/src/injection.ts`、`retrieval.ts`：在线检索、注入和固定上限。
- `plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`：当前有效的实验可信性约束。

### 外部一手来源

- OpenRSI / OpenMLE：<https://github.com/FrontisAI/OpenRSI>
- Frontis-MA1 / OpenMLE 论文：<https://arxiv.org/abs/2607.28568>
- Darwin Gödel Machine 代码：<https://github.com/jennyzzt/dgm>
- Darwin Gödel Machine 项目说明：<https://sakana.ai/dgm/>
- AlphaEvolve 官方说明：<https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/>
- AlphaEvolve 论文：<https://arxiv.org/abs/2506.13131>
- A Self-Improving Coding Agent：<https://arxiv.org/abs/2504.15228>
- SICA 代码：<https://github.com/MaximeRobeyns/self_improving_coding_agent>
- Automated Design of Agentic Systems：<https://arxiv.org/abs/2408.08435>
- autoresearch 代码：<https://github.com/karpathy/autoresearch>
- autoresearch 实验协议：<https://github.com/karpathy/autoresearch/blob/master/program.md>
- The reusable holdout：<https://arxiv.org/abs/1506.02629>
- SLSA provenance：<https://slsa.dev/spec/v1.2/provenance>
- in-toto attestation：<https://github.com/in-toto/attestation>
- NIST AI 600-1 Generative AI Profile：<https://doi.org/10.6028/NIST.AI.600-1>
- OWASP Agentic AI Threats and Mitigations：<https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/>

## 18. 限制与待裁决问题

1. 本方案是源代码与现有实验文档的静态分析，没有执行任何真实模型、campaign、pilot 或 eval。
2. OpenRSI 首发聚焦 MLE 且采用权重后训练；其结果不能直接外推到办公任务或本地 9B/27B agent。
3. DGM/SICA 的 benchmark 自改结果证明可行性，不证明在本工程的安全性、成本效益或泛化。
4. `evolution.db` 是推荐边界，最终也可新建独立私有 package；需在 Phase 0 任务书中裁决。
5. scaffold 首批白名单、人工批准界面、canary 流量比例和统计阈值需要结合 post-D E0/E1 结果预注册，本文不提前拍数值。
6. autoresearch 的结果只说明该极简循环适合单机、固定时限、单一可执行指标的训练搜索；本文对多指标 agent 评估的改造属于工程推演，需通过 Phase 3 自身对照实验验证。
7. production WORM/KMS 运营主体、data class 的具体 TTL/删除阈值、shadow 预算、signed dependency exception 与 ABI capability 扩大节奏由 Phase 0b 预注册；本文只固定 fail-closed 原则，不提前选择供应商或拍数值。
