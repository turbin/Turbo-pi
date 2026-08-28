# 自我进化工程设计决策记录

日期：2026-08-27

引用：`plans/2026-08-27-self-evolving-engineering-design-plan.md`、`plans/2026-07-31-agent-self-evolution-roadmap.md`、`plans/2026-08-11-self-improve-skill-plan.md`、`plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md`

## 结论

完成当前工程结构、在线 agent loop、离线经验进化 loop、经验检索注入、orchestrator 和 D 后评估纪律的代码/文档审查，并对照 OpenRSI/OpenMLE、DGM、AlphaEvolve、ADAS、SICA 与 autoresearch。2026-08-28 又完成 Kimi × Codex 最多五轮的对抗审核，将 V2 修订为 V3。

当前系统判定为“经验层自适应”，尚不是完整的可验证 harness 自我进化系统。推荐建设双时间尺度、三层变异面、可信评估核、候选档案与晋升回滚状态机；近期只推进可信测量、证据平面和经验候选 shadow，不直接开放源码自改。

## 决策

### SE-01：把当前成熟度定义为经验层自适应，而非完整 RSI

原因：现有系统能从 session 提炼并注入经验，但没有对 harness 候选做外部可执行评估、谱系管理和跨代父代选择。避免用“自我进化”名义掩盖尚未闭环的工程条件。

### SE-02：采用双时间尺度

在线快环只执行任务并记录证据；离线慢环生成和验证候选。原因是在线边做边改会污染归因、放大振荡，也无法稳定回放。

### SE-03：变异面按经验、配置、源码顺序开放

原因：三者 blast radius 逐级增大。能用低风险层解决的问题不升级到高风险层；源码级自举需要单独 Go Gate。

### SE-04：建立独立 Trusted Evaluation Kernel

TEK 持有任务 manifest、grader、preflight、DLP、预算、安全门和晋升 verdict；候选无权修改。原因是 verifier 与被优化对象同权会形成直接 reward hacking 路径。

### SE-05：LLM verifier 分数降级为候选筛选信号

经验 active 晋升最终由成对可执行 replay/validation 和安全门决定。原因是“文本轨迹优于最小参照”不能证明注入后真实任务效用。

### SE-06：统一 EvolutionArtifact 与六种 operator

经验快照、scaffold 配置和代码 patch 共用不可变 artifact、父版本和 `draft/improve/debug/crossover/consolidate/rollback` 操作符。原因是可建立统一谱系、评估和回滚，而无需照搬 OpenRSI 的权重训练。

### SE-07：采用 archive，不采用单链 hill-climbing

保留 champion、stepping-stone 和 specialist。原因是 DGM 证明低分祖先可能孕育后续改进；单一最高分父代容易早熟收敛。

### SE-08：新增独立 evolution.db

推荐把候选、谱系、evaluation attestation 与 deployment event 放在独立控制面数据库，不继续扩张 experience.db 职责。原因是运行时经验数据与进化控制状态的权限、生命周期和恢复语义不同。

### SE-09：复用 post-D 测量纪律，不新建平行标准

独立 workspace、canonical request hash、确认集封存、真实 token、尾部灾难率、任务级前瞻 shadow 和七类 preflight 直接成为 TEK 的基础约束。原因是这些问题已经过工程调查与对抗审查。

### SE-10：orchestrator 只作为可选 worker adapter

当前 orchestrator 只提供实例启停和 RPC 桥接，尚无任务 DAG、租约、预算和强隔离；安全关键控制面不落在其中。原因是避免把实验包提升为未经验证的可信根。

### SE-11：源码候选只产 patch，不写 active 工作树

每个候选在全新 worktree/container 评估；人工批准 canary/merge，禁止自动 commit/push。原因是共享工作区存在其他用户/agent 改动，且宿主级自改不可安全回滚。

### SE-12：本轮只交付设计，不授权实施或跑批

下一授权点为 Phase 0a 的设计细化和 TDD 任务书，并与 post-D P0 + E0 去重；Phase 0b 参数确认后才进入 Phase 1。任何真实 batch 仍需逐项通过 `2026-08-19-run-batch-preflight-checklist.md`。

### SE-13：autoresearch 作为内层有界微循环，不取代外层 archive

每个失败簇以固定 baseline、单一变异 scope、不可变 evaluator 和定额预算运行“小改→测量→记录→暂留/丢弃”循环；跨候选族选择仍由 TEK、archive 和 promotion controller 负责。原因是 autoresearch 擅长局部快速实验，DGM/OpenRSI 式谱系更适合避免单链早熟收敛。

### SE-14：保留三角色隔离，但不用 git reset 作为控制面

采用 `prepare.py/train.py/program.md` 对应的“评估核/变异对象/人类研究协议”分离；运行实现改为临时 worktree + immutable artifact + 签名事件链，生产链外部锚定。原因是本仓库存在共享脏工作区、禁止未经授权 commit，失败试验也必须保留受 retention policy 约束的审计证据。

### SE-15：不采用无限循环与单指标一次 keep

每个 `ExperimentProgram` 必须有最大试验数、连续 crash、预算和平台期停止规则；小样本改善只进入 provisional frontier，正式晋升仍过多指标 hard gates 和完整 validation。原因是 agent 任务高方差、会出云和执行副作用，风险结构与固定五分钟 `val_bpb` 搜索不同。

### SE-16：TEK 是可执行信任边界，不是目录约定

TEK 作为独立安全主体使用签名 bundle、独立凭据、只读挂载和 OS/容器 capability；policy、denylist 和静态扫描只作纵深防御。原因是候选与 evaluator 同权限时，任何“不可修改”都只是可绕过约定。

### SE-17：拆分 artifact、evaluation、deployment 与 runtime 真值

不可变 artifact manifest 不含 `status`；TEK 只追加 evaluation attestation；独立 audit writer 只追加 deployment/lineage event；每任务生成 runtime resolved manifest。原因是候选身份、裁决、槽位和实际加载版本具有不同写入者与生命周期，不能混入单一状态字段。

### SE-18：审计完整性使用签名分权和外部锚定

evaluation signer 与 audit writer 的凭据分离，生产事件链周期锚定到外部 WORM/只读审计域；本地哈希链只作诊断。原因是没有独立信任主体和外部锚点的 append-only/哈希链无法阻止管理员重写整段历史。

### SE-19：验证集按自适应消费阶段隔离

search/dev、selection、confirmation 严格分层，限制逐题反馈，长期 campaign 补入新鲜任务，并预注册多重比较与可选停止控制。原因是 archive/search loop 会自适应过拟合反复使用的 validation，即使使用 alpha spending 也不能消除内容泄漏。

### SE-20：严格 shadow 必须零用户影响

M1 只有在 TEK attestation 和预批准预算内才能自动进入 shadow；shadow 不改变用户输出、工具副作用、active memory 或 deployment slot。任何外部影响都升级为人工批准 canary。原因是把在线副作用称为 shadow 会绕过发布门。

### SE-21：跨模型验证服从声明范围

跨模型验证仍是默认门，但 artifact 可以预注册 `model_scope`；专用候选只在范围内裁决且不能替换范围外全局 active。原因是统一跨模型硬门会误杀有明确适用边界的 specialist。

### SE-22：稀有灾难与功效不足一律保守裁决

采用零事件/贝叶斯上界、严重度预算和重大事件单例熔断；预算耗尽仍未达到预注册功效时结果为 `inconclusive/no-go`。原因是“没有观察到灾难”不等于安全，provisional winner 不能替代证据。

### SE-23：Phase 5 先建设 capability-limited ABI

首批源码白名单不再包含现有 `.pi/skills` 或 `.pi/extensions` 任意代码，而是只允许新 candidate extension ABI 内的声明式策略和纯转换。原因是 skills/extensions 本身是提示注入与任意代码面，静态扫描不能证明安全。

### SE-24：数据保留按 data class 和合法依据管理

不默认永久保留失败 blob、lineage 或可关联 hash；Phase 0 定义 TTL、legal hold、erasure、tombstone 和聚合策略。原因是审计需求不能自动覆盖隐私删除义务，内容哈希也可能保持可关联性。

### SE-25：构建与运行网络能力分离

候选构建默认 hermetic，只访问固定 lockfile 的受控镜像；runtime 默认无网，只按任务获得模型代理/测试端点的短期 capability 并经过 DLP。原因是源码候选有依赖供应链与数据外泄双重风险。

### SE-26：TEK 独立部署，不与 controller 共享进程身份

TEK 落在独立私有包、进程、OS 身份和凭据域，只暴露认证窄 IPC/API；现有 `agent-server/eval` 是输入资产而不是最终信任边界。原因是同包同进程会共享内存与漏洞面，无法满足独立安全主体承诺。

### SE-27：Hermetic build 例外必须成为签名 artifact

缺失依赖只能通过带审批人、来源、内容哈希、有效期与原因的 signed exception manifest 进入隔离镜像，禁止手工临时放网。原因是完全无例外会诱发旁路，而无审计例外会破坏 provenance。

### SE-28：Phase 0 拆为原则冻结与运营参数预注册

Phase 0a 固定 fail-closed 原则、四层 schema、TEK 边界与 generation-0 bundle；Phase 0b 再确认密钥/WORM、数据保留、shadow 预算、依赖/端点白名单和 ABI 扩大节奏。原因是把所有运营参数压进 2–3 天会把未裁决事项误报为已冻结基线。

## 对既有方案的影响

- `plans/2026-07-31-agent-self-evolution-roadmap.md` 的 R3 方向保留，但“失败批次→配置候选→人工审批”的表述升级为 artifact/archive/TEK/promotion state machine。
- `plans/2026-08-11-self-improve-skill-plan.md` 可作为候选生成器与交互入口，但不能自行承担验证闸；其 extension 必须服从 TEK attestation 和 deployment event 状态。
- `plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md` 仍是近期真实实验入口。本方案是更高层工程蓝图，不解冻 v1 记忆、不解除 ALFWorld 阻断、不改变其授权边界。
