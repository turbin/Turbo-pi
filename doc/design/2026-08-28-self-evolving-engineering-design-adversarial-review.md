# 自我进化工程设计对抗审核记录

日期：2026-08-28  
对象：`plans/2026-08-27-self-evolving-engineering-design-plan.md`  
审核组：Kimi（补充观点与修订建议）× Codex（多源检索、漏洞搜索与反方批判）  
轮次上限：5 轮

## 审核方法

- Kimi 完整读取目标文档与 `AGENTS.md`，每轮只提出意见，不直接写共享工作区。
- Codex 用仓库事实与外部一手来源交叉核验，提出反例和不可实施路径。
- 只有双方都能给出工程约束与失败路径的问题才进入 V3；数值、供应商和运营主体无法从现有证据推出时，保留为 Phase 0 预注册参数。
- 本审核只修改设计文档，不授权代码实施、配置切换、真实模型调用或跑批。

## 第 1 轮：独立红队

Kimi 提出八项问题：M0 只有目录约定、provisional 与 validation 边界不清、共享工作树下 slot 不可靠、回滚环境合同不完整、Go Gate 缺量化门、ETL 丢失结构化状态、skills/extensions 是提示注入面、预算停止规则未绑定统计功效。

Codex 同意问题方向，但补充四项更根本的缺口：

1. 单一 artifact `status` 混合不可变身份、评估裁决和多槽部署状态。
2. `append-only` 没有独立写入主体、签名、断链检测或外部锚点，不具备防重写语义。
3. 跨模型验证被写成统一硬门，会误杀预注册为单模型专用的 specialist。
4. 仅检查共享工作树是否 dirty 仍有竞态；运行时不得从工作树加载部署版本。

## 第 2 轮：逐项反驳与收敛

双方收敛为十项 V3 必改项：

1. TEK 从“目录不可写”升级为独立安全主体和可执行信任边界。
2. search/dev、selection、confirmation 分层，限制反馈披露并补入新鲜任务。
3. artifact identity、evaluation attestation、deployment event 三态分离。
4. slot 只指向内容寻址 bundle/OCI，不从共享工作树加载。
5. 回滚明确区分可控 artifact 与不可控远程 provider/API 漂移。
6. Phase 1 必须交付结构化 evidence artifact。
7. 静态解析只做筛选，runtime capability sandbox 才是主要强制面。
8. 稀有灾难使用上界与严重度预算；功效不足时 `inconclusive/no-go`。
9. 稳定门按预注册风险、效应和功效判断，不以固定发布周期替代。
10. 跨模型要求服从 artifact 的 `model_scope`；专用候选不能替换范围外 active。

## 第 3 轮：信任主体与数据模型

Codex 反驳“lineage/verdict 元数据永久保留”和“TEK 私钥签全部事件”：前者可能保留用户可关联信息，后者混合评价者与审计者；无外部锚点的哈希链也允许管理员重写整条链。

Kimi 接受后，双方把控制面拆为四个正交对象：

- `artifact_immutable_manifests`：内容寻址且无可变状态。
- `evaluation_attestations`：由 TEK evaluation signer 签发，可多次追加或显式吊销。
- `deployment_event_stream`：由独立 audit writer 签发，slot 状态从事件流派生。
- `runtime_resolved_manifests`：记录进程实际加载的 blob、模型/API、环境与部署事件。

同时确认生产事件链需要外部 WORM/只读审计域锚定；本地开发链只作断链诊断，不能宣称抵抗管理员重写。

## 第 4 轮：安全白名单与证据边界

双方继续收敛：

- 严格 shadow 不得改变用户输出、工具副作用、active memory 或 deployment slot；真实成本只能来自预批准预算。
- 不设“永久保留”默认；按 data class 规定 TTL、legal hold、erasure、tombstone，关联 hash 同样受删除策略约束。
- 构建和运行 egress 分离：hermetic build 只访问受控镜像，runtime 默认无网并使用任务级短期 capability。
- Phase 5 删除现有 `.pi/skills`、`.pi/extensions` 任意代码首批白名单，先建设 capability-limited candidate extension ABI。
- generation 只能检索 archive 的预算内摘要和元数据，禁止全量 dump。

外部证据边界：Dwork reusable holdout 直接支持自适应验证隔离；SLSA/in-toto 只支持 provenance/attestation 类比，本文不宣称达到某个 SLSA 等级；NIST AI 600-1 支持持续 TEVV 与治理但不证明具体密码算法；OWASP 支持威胁分类，不能替代具体架构控制。

## 第 5 轮：V3 终审

Kimi 重新完整读取 V3、审核记录和决策记录，给出“基本同意作为待实施设计基线”的裁定，同时发现三项实施阻断和五项文字/参数缺口。Codex 同意并完成收口：

1. TEK 从同包目录规划移为独立私有包、进程、OS 身份和凭据，只开放认证窄 IPC/API。
2. hermetic build 增加 signed dependency exception manifest，禁止运维临时绕过。
3. 新增 bundle builder/registry，并把 generation-0 真实 bundle 构建/加载纳入 Phase 0a 验收。
4. provider 不暴露版本时显式记录 `external_drift/unknown`，不伪造可复现性。
5. 测试增加签名伪造、密钥轮换/吊销、断链、锚点、CAS 和进程/凭据隔离。
6. Phase 0 拆为 0a 原则/合同与 0b 运营/数据参数，未裁决参数不得冒充冻结基线。

## 最终共识与残余参数

五轮后没有需要用户在架构原则上二选一的分歧。双方共同接受 V3 为**待实施设计基线**，但它不授权实施或跑批。以下仍是 Phase 0b 必须由责任人预注册的运营参数，而不是当前文档可以凭空决定的结论：

1. 各 data class 的 TTL、聚合粒度、合法保留依据与 tombstone 形式。
2. production WORM/KMS 的运营主体和锚定频率。
3. shadow 的人工预配置预算、耗尽动作和扩额人。
4. 构建依赖例外、内部镜像、运行端点和临时 capability 白名单。
5. candidate ABI 每类 capability 的扩大节奏与批准人。

## 外部一手来源

- The reusable holdout：<https://arxiv.org/abs/1506.02629>
- SLSA provenance：<https://slsa.dev/spec/v1.2/provenance>
- in-toto attestation：<https://github.com/in-toto/attestation>
- NIST AI 600-1 Generative AI Profile：<https://doi.org/10.6028/NIST.AI.600-1>
- OWASP Agentic AI Threats and Mitigations：<https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/>
