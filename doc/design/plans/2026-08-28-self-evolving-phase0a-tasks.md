# Phase 0a 实施任务书：冻结原则与 fail-closed 合同

日期：2026-08-28
状态：**任务书草案，未授权代码实施**
上游：`plans/2026-08-28-self-evolving-phase0a-architecture.md`（架构设计，下称"架构"）、`plans/2026-08-27-self-evolving-engineering-design-plan.md`（V3）、`2026-08-28-self-evolving-engineering-design-adversarial-review.md`（对抗审核）、`doc/design/progress/2026-08-28-existing-modules-survey.md`（代码库调研）、`AGENTS.md`
关联：本文件与架构文档的 `doc/design/INDEX.md` 登记及 commit 由用户/主会话决定，不在本任务书执行范围内。

## 1. 总体约束

1. **范围硬边界**：所有任务严格限定 Phase 0a。不实现 Phase 1–6 业务逻辑：真实证据采集、候选生成、grader/runner 执行、shadow/canary 流量切换、scaffold 版本运行时切换、任何真实 LLM 调用或跑批。本阶段无真实模型、无 API key、无云端请求；测试全部使用确定性 mock（coding-agent 侧沿用 `registerFauxProvider`，agent-server 侧沿用调研 §6 `testing.py` 的 Mock 链模式）。
2. **冻结原则**：M0 面（`packages/evaluation-kernel/`、manifests、graders、preflight、DLP/budget 定义、promotion controller 源码、bundle-builder/registry 写面、路径 denylist）对候选进程只读；`packages/agent/src/agent-loop.ts` 本阶段**零改动**（架构 §1.2）。任何任务不得以"顺手修一下"为由触碰冻结面。
3. **fail-closed 合同**：架构 §10 的全部失败模式必须可机械验证。任何"降级到无签名继续"的路径都视为实现错误。
4. **行数上限**：每个任务提交行数上限 3000（新增+修改，含测试）。超限必须拆分子任务（提交单元按文件分组拆分，不改变任务边界）。
5. **TDD 纪律**：每任务先写 failing test（red），再实现（green），再重构，最后跑通。TDD 入口测试文件名与核心断言见各任务条目，不得以"先实现后补测"替代。
6. **文件冲突约束**：任务之间尽量不交叉修改同一文件。冲突矩阵见 §2 末尾；唯一允许修改现有大文件的任务是 T6b（`packages/coding-agent/src/core/agent-session.ts`，最小 diff），其余任务只新增文件。
7. **测试运行约束**（AGENTS.md）：agent-server 相关测试用 `scripts/with-node25.sh` 下的 vitest；coding-agent 测试用 `test/suite/harness.ts` + faux provider，禁止真实 provider 与 key；跑批前置核验清单不适用于本阶段（无跑批），但 T9 的 gen0 机械构建属脚本执行，不触发该清单。
8. **提交纪律**：coder 只 stage 自己会话修改的文件；每个任务完成后按 AGENTS.md 更新 progress 文件；任务书文档本身的 commit 由用户决定。
9. **0b 参数隔离**：P1–P10 一律不裁决数值。gen0 bundle 中未裁决项必须显式使用 `pending_0b` 占位引用（架构 D5/D6、§9），不得假装已冻结。

## 2. 工作分解结构（WBS）

调用链映射：T1→C4/C6/C8 的存储底座；T2→C3/C4 的标识合同；T3→C3/C4；T4→C2/C5；T5→C6；T6→C7/C8；T7→C1 合同；T8/T9→架构 §8 A1–A11 全量验收。

### 任务条目说明

每个任务含：目标 / 输入 / 输出 / 负责人 / 行数预算 / Token 估算 / 依赖 / 可并行 / TDD 入口 / 验收 / 风险。Token 估算口径统一为：**轮次 × 每轮 20–30k tokens**。每轮 = 一次 TDD 红绿循环（读规范引用 + 写测试 + 实现 + 跑通 + 重构），输入约 15–25k（规范文档引用占比高：架构文档全文约 13–15k tokens，V3 约 15k），输出约 4–8k。轮次数按文件数 × 0.5 加测试迭代次数粗估，理由在各任务内说明。估算为范围值，不拍精确数字。

---

### T1：evolution.db schema 与不变性约束

- **目标**：建立独立 `evolution.db` 的四张冻结表 + `evolution_journal` + `attestation_revocations`，全部只追加，UPDATE/DELETE 被 SQLite trigger 拒绝。
- **输入**：架构 §6（字段级定义）、§10.2（半截写入规则）；survey §4（`experience-store.ts` 的 better-sqlite3 用法与 TEXT JSON 数组约定）。
- **输出**：`packages/agent-server/src/evolution/schema.sql`（或等价的建表 TS 模块）、`db.ts`（连接 + trigger 安装 + 迁移入口）、`append-only DAO`（只暴露 append 方法）、约束测试。不输出任何业务方法。
- **负责人**：coder-A。
- **行数预算**：约 900（schema 150 + db/trigger 150 + DAO 200 + 测试 400）。
- **Token 估算**：4 轮 × 20–30k ≈ 80–120k。依据：6 张表字段多（架构 §6.1–6.5 合计约 60 字段），约束测试矩阵（NOT NULL/CHECK/FK/UNIQUE/trigger）约 15–20 个断言用例。
- **依赖**：无。
- **可并行**：T2、T4。
- **TDD 入口**：`packages/agent-server/test/evolution/schema.test.ts`。核心断言：四表 + journal + revocations 存在且字段/约束与架构 §6 逐项一致；`UPDATE`/`DELETE` 任何一行被 trigger 拒绝；缺任一必填字段写入返回明确拒绝原因（fail closed，A2）；`state` 只能取 `written`/`committed`（A11）。
- **验收**：A2（四 schema 冻结，含 trigger 与必填字段拒绝）、A11（journal 状态枚举与恢复前提）。
- **风险与 fail-closed**：better-sqlite3 需 Node 25.9.0（用 `scripts/with-node25.sh`）；trigger 与 FK 的 SQLite 行为差异——测试必须覆盖"触发器不存在时 DAO 仍不可变"的防御（DAO 层拒绝 UPDATE/DELETE 语句，不依赖 trigger 单一防线）；时间一律 INTEGER epoch ms、数组一律 TEXT JSON，与 experience-store 约定一致，避免类型混用。

### T2：canonical artifact manifest 与 content-addressed hash

- **目标**：冻结 canonical JSON 序列化（键排序、无随机字段、无时间戳噪声）与 `artifact_id = sha256(canonical_manifest + blob_hashes)` 计算合同。
- **输入**：架构 §3.3、§6.1、§7（`VerifyBundleRequest` 的 manifest 语义）、A3；post-D 的 canonical request hash 先例（确定性与键排序规范）。
- **输出**：`packages/agent-server/src/evolution/canonical.ts`（稳定序列化 + sha256 + artifact_id 计算）、`artifact-schema.ts`（manifest TS 类型 + 字段校验器，与 T1 表字段同名同义）、单元测试。
- **负责人**：coder-B。
- **行数预算**：约 450（实现 150 + 测试 300）。
- **Token 估算**：3 轮 × 20–30k ≈ 60–90k。依据：纯函数、文件少；但序列化稳定性用例多（语义字段逐一变更触发 hash 变化，约 10 个用例）。
- **依赖**：无（字段名与 T1 的约定以架构 §6.1 为准，两边独立实现，T8 交叉验证）。
- **可并行**：T1、T4。
- **TDD 入口**：`packages/agent-server/test/evolution/canonical.test.ts`。核心断言：同内容同 `artifact_id`；`scope`、`model_fingerprint`、任一 blob 内容变化 hash 必变；序列化稳定（键排序、两次序列化字节相同、不含时间戳/随机字段）（A3）。
- **验收**：A3。
- **风险与 fail-closed**：与 T4 的 kernel 内独立实现可能漂移——canonical 规范必须写成纯文本规则（键排序算法、JSON 数字处理、字符串编码）固化在本任务输出中，T8 用跨实现对账测试兜底；`cost_micros` 等整数精度不能因 JSON 解析丢失。

### T3：bundle builder / artifact registry（含 generation-0 构建）

- **目标**：实现 bundle 结构、内容寻址 registry（CAS 同 ID 不同内容拒绝并留冲突事件）、加载端逐 blob 校验（fail closed），并机械构建一个 generation-0 bundle。
- **输入**：架构 §3.3、§4（时序第 5–7 步）、§5 C3/C4、§8 A6；T1（表 + journal）、T2（canonical + artifact_id）。
- **输出**：`bundle-builder.ts`（`buildGenerationZeroBundle`）、`artifact-registry.ts`（`storeArtifact`/`fetchBundle`，CAS 校验 + 冲突事件写入 journal）、`fingerprint.ts`（P7 默认清单的指纹采集：scaffold 组合哈希、experience.db 快照 SHA、model_fingerprint、config 指纹、M0 denylist 版本；覆盖范围如实标注）、`build-gen0.ts`（gen0 构建脚本：operator=`draft`、parent_ids=`[]`、evidence_refs=冻结决策记录引用、retention_policy_ref=`pending_0b` 占位）、测试。
- **负责人**：coder-A。
- **行数预算**：约 1300（builder 300 + registry 350 + fingerprint 250 + gen0 脚本 150 + 测试 250）。
- **Token 估算**：6 轮 × 20–30k ≈ 120–180k。依据：三个模块 + 脚本，CAS 冲突路径与 blob 校验失败的测试约 8–10 用例；指纹采集需阅读现有配置/库文件（survey §4、§9 复用矩阵）。
- **依赖**：T1、T2。
- **可并行**：T7（M1 内）。
- **TDD 入口**：`packages/agent-server/test/evolution/registry.test.ts`。核心断言：同 ID 不同 blob 内容写入被拒且冲突事件入库（A6）；`fetchBundle` 逐 blob SHA256 校验、任一失败拒绝激活（A6）；`buildGenerationZeroBundle` 输出 bundle 的 operator/parent_ids/evidence_refs/retention_policy_ref 符合 D5 与 `pending_0b` 要求；缺任一冻结指纹拒绝构建。
- **验收**：A6（机械构建 + CAS + 加载校验）、A3（经 registry 写入的 manifest 与 T2 hash 合同一致）。
- **风险与 fail-closed**：指纹采集范围依赖 P7 默认清单——脚本必须输出"已采集路径清单"与"未覆盖范围"报告，不得声称全覆盖；registry 写面是 M0 面，必须提供"仅已批准 manifest 可触发"的守卫（本阶段批准人 = gen0 脚本自身，守卫以显式 allowlist 参数实现）。

### T4：Trusted Evaluation Kernel（TEK）骨架

- **目标**：建立独立私有包 `packages/evaluation-kernel`：signer、ipc-server、窄 API 契约 6 方法、独立进程入口与凭据目录布局。
- **输入**：架构 §3.1/§3.2/§7（完整契约草案）、§6.2（attestation 字段）、§8 A4/A5/A9/A10；对抗审核第 5 轮收口 1；issue-023（preflight 含余额检查项）；post-D（确认集 denylist、workspace_tree_sha）；T2（canonical 规范，kernel 内独立实现）。
- **输出**：`packages/evaluation-kernel/`（private 包：`package.json`、`src/ipc/contract.ts`、`src/signer.ts`、`src/ipc-server.ts`、`src/methods/*`（health/pinTaskContract/verifyBundle/signAttestation/verifyAttestation/getM0Policy）、`src/policy.ts`（M0 策略快照）、进程入口 `bin/`、dev 密钥生成脚本（key_id 前缀 `dev-`）、凭据目录布局（`chain_mode` 恒为 `local_diagnostic`））、进程级测试。**不实现** grader 执行、runner、候选生成接口。
- **负责人**：coder-C。
- **行数预算**：约 1800（包配置 100 + signer 200 + contract 150 + ipc-server 400 + 6 方法 550 + 入口/密钥脚本 200 + 测试 400）。
- **Token 估算**：9 轮 × 20–30k ≈ 180–270k。依据：全新包，文件数 8+；IPC 认证与进程测试（spawn、socket、token）迭代成本高；契约草案 §7 需全文对齐（约 15 个类型 + 6 方法签名）；"kernel 不 import 任何 `@earendil-works/*`"约束要求独立实现 canonical 与签名逻辑。
- **依赖**：T2（文档级：canonical 规范；代码独立实现，不 import agent-server）。
- **可并行**：T1、T2。
- **TDD 入口**：`packages/evaluation-kernel/test/ipc.test.ts`（进程级：spawn 真实进程 + Unix socket 调用）。核心断言：未认证调用拒绝；未知方法拒绝；`ipcVersion` 不匹配调用方拒绝连接（A5）；`PinTaskContractRequest` 缺任一字段返回 `missing_field`（A5）；`verifyBundle` 四检查逐项可失败（A6 的 kernel 侧）；`signAttestation` 输出可被 `verifyAttestation` 验证、伪造/错 key 签名被拒（A9）；`getM0Policy` 返回 denylistSha 与 immutablePaths。
- **验收**：A4（独立包/进程/凭据分离的可验证部分）、A5（窄 IPC）、A9（chain_mode 透传与签名可验证）、A10（`pinTaskContract` 的 preflightId/denylistRef 字段语义对齐 post-D 与 issue-023）。
- **风险与 fail-closed**：本地 macOS 无法真实切换 OS 身份——A4 的真实 uid 隔离测试放 CI Linux 容器；本地以"凭据目录 mode 检查 + socket mode 0600 + 属主校验"降级验证（报告如实标注）；包入仓方式（private、不进发布集、不被 root build 引用、不 import workspace 包）需与主会话确认后固定；认证令牌为 0a 最小实现（启动时生成 + 按调用校验），mTLS 只留接口不实现。

### T5：Promotion Controller 骨架与 deployment_event_stream

- **目标**：实现 audit_writer 签名事件写入（CAS previous_event_id、seq 单调、状态机非法跳转拒绝）与 slot 派生状态视图。
- **输入**：架构 §5 C6、§6.3、§8 A8、§10.1 C6 行；T1（表 + journal）、T3（registry 读面，联调用）。
- **输出**：`promotion-controller.ts`（状态机校验：`shadow→canary_pending_approval→canary→active_pending_approval→active` 与 `rollback`/`quarantine`/`reject` 合法跳转表）、`audit-writer.ts`（dev 签名密钥 `dev-` 前缀、事件签名、key_id 记录）、slot 派生视图 SQL/查询（按 slot 分组取最大 seq）、`rollback` 事件支持、测试。
- **负责人**：coder-B。
- **行数预算**：约 1200（状态机 250 + audit-writer 200 + 派生视图 200 + rollback 100 + 测试 450）。
- **Token 估算**：6 轮 × 20–30k ≈ 120–180k。依据：状态机跳转矩阵测试（合法路径 4–5 条 + 非法路径 5–6 条）、CAS 并发语义（BEGIN IMMEDIATE 事务 + UNIQUE seq 重试）是迭代热点。
- **依赖**：T1（必需）、T3（联调：artifact 存在性校验最终走 registry 只读接口；T3 未完成前用 FK 约束替代，M1 末切换）。
- **可并行**：T7（M1 内）。
- **TDD 入口**：`packages/agent-server/test/evolution/promotion.test.ts`。核心断言：无 `shadow` 直接 `active` 被拒（A8）；`previous_event_id` 不匹配被拒、同 `seq` 重复被拒（A8）；首事件必须 `previous_event_id IS NULL`；slot 当前状态 = 最大 seq 事件派生、且表内无任何可变 status 列（D4）；`seq` 断号被检出并置 fail-closed（派生视图标记 slot 未知，拒绝基于该 slot 的晋升裁决，A8）；rollback 事件可写入且派生状态正确。
- **验收**：A8、A9（事件携带 chain_mode 与 key_id）。
- **风险与 fail-closed**：并发写者竞态靠 SQLite `BEGIN IMMEDIATE` + UNIQUE 重试，测试需模拟两写者；状态机跳转表必须与架构 §6.3 的 CHECK 枚举一致（`shadow,canary_pending_approval,canary,active_pending_approval,active,rollback,quarantine,reject`）；事件流整体不可用时不得产生"无签名激活"回退。

### T6：runtime_resolved_manifest 与在线 loop 版本合同注入

按里程碑归属拆为两个提交批次，共享同一任务边界与总行数预算（合计 ≤3000）：

#### T6a（M1，Runtime 主线）：slot 解析与 resolved manifest 记录

- **目标**：实现 `resolveSlot`（只从事件流派生 + registry 内容寻址加载，禁止共享工作树）与 `recordResolvedManifest` 真值记录。
- **输入**：架构 §4（时序 14–18 步）、§5 C7/C8、§6.4、§10.1 C7/C8 行；T1、T3、T5。
- **输出**：`runtime-resolver.ts`（`resolveSlot`/`fetchBundle` 校验失败拒绝加载，无上一版本时拒绝启动）、`record-resolved.ts`（写入 + `UNIQUE(task_id, slot, resolved_at)` 幂等 + FK 拒绝）、对账查询（联查 deployment_event_stream，artifact_id 不一致派生 `drift_flag=slot_mismatch`）、测试。
- **负责人**：coder-A。
- **行数预算**：约 800（resolver 250 + record 150 + 对账 100 + 测试 300）。
- **Token 估算**：4 轮 × 20–30k ≈ 80–120k。
- **依赖**：T1、T3、T5。
- **可并行**：T7（若未完成）。
- **TDD 入口**：`packages/agent-server/test/evolution/resolver.test.ts`。核心断言：`resolveSlot` 只接受事件流派生状态；blob 校验失败拒绝加载（C7 fail closed）；`recordResolvedManifest` 缺任一必填字段拒绝（C8）；引用不存在 deployment_event_id 被 FK 拒绝（C8）；重复写同一 `(task_id, slot, resolved_at)` 幂等；对账查询发现 slot 声称与实际 artifact 不一致时派生 `slot_mismatch`（§6.4）。
- **验收**：A7（resolved manifest 对账输入）、A11（journal 幂等）。

#### T6b（M2，在线注入）：agent-session 版本合同注入

- **目标**：coding-agent 会话最小侵入式注入 `artifactId`/`scaffoldHash`/`snapshotSha`，会话结束如实记录 resolved manifest。
- **输入**：架构 §10.1（不改 loop，用现有钩子）；survey §3（agent-session 结构、`_installAgentNextTurnRefresh`、扩展绑定）、§1（agent-loop 钩子）；T6a。
- **输出**：`packages/coding-agent/src/core/evolution/version-contract.ts`（新模块：版本合同读取与注入）、`agent-session.ts` 最小 diff（仅挂载点 3–5 处）、会话生命周期记录 resolved manifest 的挂钩、测试。**agent-loop.ts 零改动**。
- **负责人**：coder-B。
- **行数预算**：约 700（新模块 250 + agent-session diff 150 + 测试 300）。
- **Token 估算**：4 轮 × 20–30k ≈ 80–120k。依据：agent-session.ts 是 3283 行单体，diff 需反复核对现有逻辑，迭代成本高。
- **依赖**：T6a。
- **可并行**：T7（若未完成）。
- **TDD 入口**：`packages/coding-agent/test/suite/evolution/version-contract.test.ts`（faux provider，无真实 key）。核心断言：会话启动后上下文携带 artifactId/scaffoldHash/snapshotSha；会话结束写入 resolved manifest（含 actual_provider_model/env 快照）；注入不影响现有注入/对照臂字段（arm/injection 语义不变）；`git diff` 静态检查确认 agent-loop.ts 无改动。
- **验收**：A7（在线记录参与 gen0 对账）、架构 §1.2（在线行为零改动）。
- **风险与 fail-closed**：agent-session 大文件改动风险——提交前必须 diff review；T6b 是唯一允许修改 `agent-session.ts` 的任务，其他任务不得触碰；若注入失败，会话仍须正常完成（注入是尽力而为，但 resolved 记录缺字段必须 fail closed 拒写而非静默填 null）。

### T7：evidence plane 结构化字段扩展

- **目标**：冻结 `recordEvidence` 写入合同：tool event 摘要、产物 manifest、gateway escalation join key、失败 taxonomy 枚举；**只定义接口与字段校验，不实现采集**（Phase 1 才接入）。
- **输入**：架构 §1.2（0a/Phase 1 切分）、§5 C1、§10.1 C1 行；V3 §8.1；survey §4（request_traces 现有字段：taskId/arm/condition/canonicalRequestHash）。
- **输出**：`packages/agent-server/src/evolution/evidence-schema.ts`（recordEvidence 契约类型 + 字段级校验器）、`taxonomy.ts`（失败分类枚举：环境/模型/支架/检索/经验内容/交付/judge/unknown，对齐 V3 §8.1）、escalation join key 字段规范（与 gateway 的 sequence/quality_signals 对应关系文档化）、测试。
- **负责人**：coder-C。
- **行数预算**：约 500（schema 150 + taxonomy 80 + 测试 270）。
- **Token 估算**：3 轮 × 20–30k ≈ 60–90k。依据：纯类型 + 校验 + 枚举，文件少；需与 survey §4 的现有 trace 字段对齐。
- **依赖**：T1（ID/引用格式约定：task_id、trace_ref 与表字段同名同义）。
- **可并行**：T3、T5、T6a（M1/M2 全程并行）。
- **TDD 入口**：`packages/agent-server/test/evolution/evidence-schema.test.ts`。核心断言：taxonomy 枚举与 V3 §8.1 六类 + unknown 一致；`recordEvidence` 缺任一必填字段返回字段级错误且拒绝写入（C1 fail closed）；escalation join key 字段存在且与 gateway sequence/quality_signals 文档对应；产物 manifest 字段引用 T2 的 blob_hashes 格式。
- **验收**：A10（post-D/issue-023 字段纳入的证据面部分）、架构 §1.2（无真实采集实现）。
- **风险与 fail-closed**：边界滑移——本任务严禁写任何采集 hook 或改 request_traces 写入路径；字段命名与 T1 表列、T6 的 resolved 字段三方一致（命名表在本任务输出中固化）。

### T8：契约测试与 fail-closed 测试套件

- **目标**：跨模块集中契约测试：canonical 跨实现一致性、状态机非法跳转矩阵、伪造签名、CAS 冲突、断链、半截记录、静态 import 扫描。
- **输入**：架构 §8（A1–A11 全量）、§10；V3 §12.1；T1–T7 全部输出。
- **输出**：`packages/agent-server/test/evolution/contract-suite.test.ts`（含子套件：consistency/signature/chain/crash/permission）、静态扫描脚本（controller 不 import kernel 内部符号；agent-loop.ts 零改动断言）、M0 路径写拒绝守卫测试、测试辅助（双 key 生成、断链注入、journal 半截构造）。
- **负责人**：coder-A。
- **行数预算**：约 1500（子套件 1000 + 扫描/守卫 250 + 辅助 250）。
- **Token 估算**：7 轮 × 20–30k ≈ 140–210k。依据：测试文件最多；伪造签名与断链注入需要专门的测试辅助；跨实现一致性测试要跑 kernel 进程。
- **依赖**：T1–T7。
- **可并行**：无（可先行编写测试辅助与 A1 静态扫描部分，主体在 T6 后）。
- **TDD 入口**：`packages/agent-server/test/evolution/contract-suite.test.ts`。核心断言：T2 与 T4 的 canonical 实现对同一 manifest 产出相同 artifact_id；伪造/错 key 的 attestation 与 event 被拒（A9）；`seq` 断号后 slot 派生视图 fail-closed（A8）；journal `state='written'` 记录在恢复路径不被视为成功（A11）；M0 路径写守卫拒绝（A1）；静态扫描确认 controller 无 kernel import（A1）；本地链产物 `chain_mode=local_diagnostic` 且导出路径不声称防重写（A9）。
- **验收**：A1、A5、A8、A9、A11 的集中机械验证。
- **风险与 fail-closed**：A1 的 OS 身份/capability 真实测试在本地 macOS 受限——CI Linux 容器执行真实 uid 测试，本地用权限位 + 守卫函数降级（在测试输出中标注降级项）；断链注入不能违反只追加约束（用测试库直接构造缺口 seq，不得提供"删历史"通道）。

### T9：集成验收脚本（generation-0 一键重建）

- **目标**：一条命令完成"指纹采集 → gen0 bundle 构建 → registry 存储 → TEK 签名 attestation → deployment event → slot 解析 → resolved manifest 记录 → 全链对账"，输出逐项对账报告。
- **输入**：架构 §4（完整时序）、§8 A6/A7；T3–T6 输出；T8 作为回归护栏。
- **输出**：`packages/agent-server/src/evolution/cli.ts`（`gen0-rebuild` 命令 + 对账报告：artifact_id/scaffold_hash/experience 快照 SHA/task manifest SHA/grader SHA/budget/deployment event/resolved manifest 逐项比对）、集成测试。
- **负责人**：coder-B。
- **行数预算**：约 600（cli 250 + 对账 150 + 集成测试 200）。
- **Token 估算**：4 轮 × 20–30k ≈ 80–120k。依据：脚本串全链，调试跨模块集成约 2 轮额外迭代。
- **依赖**：T1–T8（可并行启动脚本开发，验收判定在 T8 全绿后）。
- **可并行**：T8（开发并行，验收串行）。
- **TDD 入口**：`packages/agent-server/test/evolution/gen0-rebuild.integration.test.ts`。核心断言：一条命令（无交互、无 LLM）产出可加载 gen0 bundle；对账报告逐项一致（A7）；任一字段缺失/不一致时命令退出码非 0 且报告标出缺项（A7 fail closed）；重建输出与 T8 契约套件无回归。
- **验收**：A6（机械脚本一条命令）、A7（全链可重建）。
- **风险与 fail-closed**：重建可复现性——canonical 无时间戳噪声保证 hash 稳定，但 resolved 记录含时间字段（不在 hash 内，仅对账比对值）；脚本必须纯机械（无 LLM、无网络），否则触发跑批前置核验清单。

### 文件冲突矩阵

| 文件/目录 | 归属任务 | 其他任务约束 |
|---|---|---|
| `packages/agent-server/src/evolution/`（新目录） | T1/T2/T3/T5/T6a/T7 各自独立文件 | 各任务只写自己的文件；共享类型经 T2 的 `artifact-schema.ts` 引用，跨任务改动需主会话协调 |
| `packages/evaluation-kernel/`（新目录） | T4 | 独占，其他任务只读测试辅助；T8 可新增 `test/` 文件 |
| `packages/agent/src/agent-loop.ts` | 无 | 零改动（T8 静态断言） |
| `packages/coding-agent/src/core/agent-session.ts` | T6b | 唯一允许修改；diff 必须最小化并人工评审 |
| `packages/coding-agent/src/core/evolution/`（新目录） | T6b | 独占 |
| `packages/agent-server/test/evolution/`（新目录） | T1/T2/T3/T5/T6a/T7/T8/T9 | 各任务独立测试文件 |

## 3. 并行开发分组

| 波次 | 里程碑 | 并行启动 | 串行/联调 | 负责人 |
|---|---|---|---|---|
| 波次 1 | M0 | T1（A）、T2（B）、T4（C） | T4 与 T2 仅规范对齐（T8 交叉验证） | coder-A/B/C 各 1 |
| 波次 2 | M1 | T3（A）、T7（C）；T3 完成后 T5（B） | T5 联调切换 registry 只读接口 | coder-A/B/C |
| 波次 3 | M2 | T6a（A，依赖 T5）；T6b（B，依赖 T6a）；T7 若未完（C） | T6b 在 T6a 后 1–2 天启动 | coder-A/B/C |
| 波次 4 | M3 | T8（A）先行测试辅助；T9（B）脚本开发 | T9 验收判定在 T8 绿后 | coder-A/B |

依赖 DAG：

```text
T1 ──┬─▶ T3 ──▶ T5 ──▶ T6a ──▶ T6b ──┐
     │                                  ├──▶ T8 ──▶ T9
T2 ──┴─▶ T3（canonical 合同）           │
T2 ──（规范）──▶ T4（独立实现）──────────┤
T1 ────────────────▶ T7 ───────────────┘
```

关键路径：T1 → T3 → T5 → T6a → T6b → T8 → T9（7 步串行）。T7 全程并行不占关键路径。T2/T4 在波次 1 与 T1 并行。

## 4. 里程碑与人工检查点

进度文件：`doc/design/progress/2026-08-28-phase0a-progress.md`（随 M0 立项创建，按该目录 README 规范维护）。

### M0：Schema + TEK 包结构 + bundle registry 合同冻结

- **目标**：T1（evolution.db 全 schema）、T2（canonical/hash 合同）、T4（kernel 包结构 + 窄 IPC）三方冻结，形成可评审的合同基线。
- **包含任务**：T1、T2、T4。
- **进入条件**：无（首里程碑）。
- **退出条件（可验证 checklist）**：
  - T1 约束测试全绿：六表建表、trigger 拒绝 UPDATE/DELETE、缺字段拒绝写入。
  - T2 canonical 测试全绿：同内容同 hash、语义字段变更 hash 必变、序列化稳定。
  - T4 进程测试全绿：认证拒绝、未知方法拒绝、ipcVersion 拒绝、missing_field、签名可验证。
  - T2 与 T4 的 canonical 实现冒烟对账（T8 的前置抽查，一个 manifest 手工比对）。
  - 命名表（字段名三方一致：T1 表列 / T2 manifest / T7 evidence 预留）在 progress 文件登记。
- **人工检查点**：
  - 检查内容：T1 schema 逐字段对照架构 §6（字段名/类型/约束/CHECK 枚举）；T4 包结构与 §7 契约逐类型对照；gen0 元数据取值（D5）与 `pending_0b` 占位机制；`chain_mode` 透传设计（D6）；T2/T4 冒烟对账结果。
  - 检查人：架构师（主查） + 用户（最终确认 TEK 包名、目录、本地 dev 降级口径）。
  - 必须确认的问题：① 字段名/约束是否与架构 §6 完全一致；② kernel 包入仓方式（private/不进发布集/不 import workspace 包）是否可接受；③ 本地降级验证（权限位 + socket mode 0600）是否作为 A4 的本地口径。
  - 拒绝标准：任一字段与架构 §6 不一致；trigger 可被绕过；canonical 含时间戳/随机字段；kernel 暴露契约外方法；`pending_0b` 未显式出现于 gen0 设计。
- **向用户汇报模板**：见 §6，附 M0 检查点结论表（三任务测试计数 + 冒烟对账 + 待确认问题清单）。

### M1：Artifact/Promotion/Runtime 三条主线可独立跑通

- **目标**：T3（Artifact 主线：bundle 构建/存储/加载校验）、T5（Promotion 主线：签名事件流 + slot 派生）、T6a（Runtime 主线：slot 解析 + resolved 记录）各自独立跑通。
- **包含任务**：T3、T5、T6a（T7 可并行启动但计入 M2 验收）。
- **进入条件**：M0 退出条件达成。
- **退出条件（可验证 checklist）**：
  - CAS 冲突拒绝 + 冲突事件入库（A6）；gen0 bundle 机械构建并加载成功（A6）。
  - 状态机非法跳转 / 重复 seq / previous_event_id 不匹配拒绝（A8）；slot 派生视图正确、无 status 列（D4）；断号 fail-closed 检出（A8）。
  - resolveSlot 只消费事件流 + 内容寻址 bundle；blob 校验失败拒绝加载（C7）；recordResolvedManifest 幂等 + FK 拒绝（C8）。
  - T5 联调完成：artifact 存在性校验走 T3 registry 只读接口。
- **人工检查点**：
  - 检查内容：现场演示 CAS 冲突（同 ID 不同内容写入被拒 + 冲突事件）；演示状态机非法跳转与断号 fail-closed；审查 gen0 bundle 内容清单 vs 架构 §3.3（scaffold 指纹/快照 SHA/model_fingerprint/config 指纹/denylist 版本/retention 占位/chain_mode）；审查 signer 密钥管理（dev- 前缀、凭据目录布局）；审查 P7 默认清单的"覆盖范围如实标注"报告。
  - 检查人：架构师（主查）+ 用户。
  - 必须确认的问题：① gen0 bundle 是否全部字段来自 P7 默认清单且未裁决项显式占位；② 事件流断号处理是否满足"slot 未知即拒绝晋升"的业务语义；③ fingerprint 覆盖范围标注是否诚实。
  - 拒绝标准：registry 存在绕过 CAS 的写入路径；slot 派生依赖任何可变 status 列；gen0 bundle 混入已裁决数值（P1–P10 任何一项）。
- **向用户汇报模板**：见 §6，附三条主线演示输出摘要。

### M2：Evidence plane 扩展 + 在线 loop 版本合同注入完成

- **目标**：T6b（在线版本合同注入）与 T7（evidence 合同冻结）完成；T6a/T6b 全链打通。
- **包含任务**：T6b、T7（T6a 已在 M1 完成）。
- **进入条件**：M1 退出条件达成。
- **退出条件（可验证 checklist）**：
  - T6b 测试全绿：会话注入 artifactId/scaffoldHash/snapshotSha（faux provider）；会话结束如实记录 resolved manifest；agent-loop.ts 零改动静态断言通过。
  - T7 测试全绿：taxonomy 六类 + unknown；recordEvidence 字段级拒绝；escalation join key 文档对应。
  - 对账查询可用：slot 声称 vs 实际加载不一致派生 drift_flag（含 `slot_mismatch`）。
  - 无任何真实采集实现越界（git diff 审查确认未触碰 request_traces 写入路径与注入行为）。
- **人工检查点**：
  - 检查内容：T6b 的 agent-session.ts diff review（最小侵入性、不影响 arm/injection 对照臂）；T7 的 taxonomy 与 escalation join key 字段评审；确认 Phase 1 边界未越界（无采集 hook）；review 注入失败时的 fail-closed 行为（注入失败会话照常、记录缺字段拒写）。
  - 检查人：架构师 + 用户。
  - 必须确认的问题：① 注入点选择（coding-agent 直连路径）是否满足 A7 对账要求，agent-server 代理路径注入是否显式列为 Phase 1；② taxonomy 枚举是否需要与 V3 §8.1 之外的现有失败分类对齐（如 judge 分类引用）。
  - 拒绝标准：任何 agent-loop.ts 改动；注入改变现有行为；taxonomy 与 V3 §8.1 不一致；resolved 记录存在静默填 null 路径。
- **向用户汇报模板**：见 §6，附注入 diff 摘要与 taxonomy 枚举表。

### M3：契约测试 + 集成验收 + generation-0 一键重建通过

- **目标**：T8 契约套件全绿、T9 一键重建全链对账通过，A1–A11 验收矩阵逐项闭环。
- **包含任务**：T8、T9。
- **进入条件**：M2 退出条件达成。
- **退出条件（可验证 checklist）**：
  - T8 全部子套件绿：一致性/签名/断链/crash/权限 + 静态扫描（A1、A5、A8、A9、A11）。
  - T9 集成测试绿：一条命令重建 gen0 全链、对账报告逐项一致、缺字段退出码非 0。
  - A1–A11 验收矩阵表（架构 §8）逐项填写证据（测试名 + 结果），A4 的真实 uid 项标注 CI 执行结果。
  - `npm run check` 全绿（biome + tsgo + 无 any）；`./test.sh` 相关包全绿，无真实 provider/key 依赖。
- **人工检查点**：
  - 检查内容：用户 + 架构师逐条过 A1–A11；现场演示一键重建输出与对账报告；现场演示三类 fail-closed（伪造签名拒绝 / 断链 fail-closed / journal 半截恢复）；对照 §9 确认 P1–P10 未决参数未混入冻结合同。
  - 检查人：用户（最终验收）+ 架构师。
  - 必须确认的问题：① A1 的 OS 身份测试在 CI Linux 的覆盖是否视为通过（本地降级项清单）；② 是否有任何验收项需要降级口径（走 §5 降级策略且必须用户确认）；③ Phase 0a 是否整体收口、0b 预注册任务是否可排期。
  - 拒绝标准：任何 A 项不通过；出现真实 LLM 调用/跑批；chain_mode 缺失；降级未经用户确认。
- **向用户汇报模板**：见 §6，附 A1–A11 矩阵表 + 一键重建日志摘要。

## 5. Token 成本总估算与预算控制

### 汇总表

| 任务 | 行数预算 | 轮次 | 每轮 | 估算（范围） | 占比 |
|---|---|---|---|---|---|
| T1 schema | 900 | 4 | 20–30k | 80–120k | 8% |
| T2 canonical | 450 | 3 | 20–30k | 60–90k | 7% |
| T3 bundle/registry | 1300 | 6 | 20–30k | 120–180k | 13% |
| T4 TEK 骨架 | 1800 | 9 | 20–30k | 180–270k | 20% |
| T5 promotion | 1200 | 6 | 20–30k | 120–180k | 13% |
| T6a resolver | 800 | 4 | 20–30k | 80–120k | 9% |
| T6b 在线注入 | 700 | 4 | 20–30k | 80–120k | 9% |
| T7 evidence | 500 | 3 | 20–30k | 60–90k | 7% |
| T8 契约套件 | 1500 | 7 | 20–30k | 140–210k | 15% |
| T9 集成验收 | 600 | 4 | 20–30k | 80–120k | 9% |
| **合计** | **约 9700 行** | **50** | | **约 0.9–1.5M（中点约 1.2M）** | 100% |

估算依据：每轮为一次 TDD 红绿循环；输入以规范文档引用为主（架构全文约 13–15k、V3 约 15k、survey 约 5k），单轮输入 15–25k、输出 4–8k；轮次数与文件数、接口数、测试用例数线性相关（T4/T8 因进程测试与契约矩阵轮次最多）。行数合计约 9700，低于 9×3000 上限，冗余用于联调修复。

### 汇报节奏

- 每里程碑一次人工检查点（§4 模板），检查点之间 coder 每日在 progress 文件更新状态。
- 每日一次状态简报（基于 progress 文件状态表，无需额外会议）。
- 里程碑退出条件全绿后 24 小时内向用户提交里程碑汇报。

### 超出预算时的降级策略（需用户确认后执行）

| 级别 | 动作 | 影响 |
|---|---|---|
| 一级（T8 简化） | 状态机矩阵只测架构点名的非法跳转（无 shadow 直接 active 等 4–5 条），不枚举全 8×8 矩阵；A1 本地降级项不再补 Linux 真实验证（标注 deferred 到 CI 打通） | A8/A1 覆盖收窄但核心断言保留 |
| 二级（T6b 后移） | 在线注入仅保留 coding-agent 直连路径；agent-server 代理路径注入显式列入 Phase 1（A7 由 T9 脚本直驱记录覆盖，验收口径不变） | M2 范围收窄，不影响 A6/A7 |
| 三级（T7 收窄） | taxonomy 只冻结枚举与 unknown 桶，字段级校验降为顶层必填字段 | A10 字段完整性检查降级，Phase 1 补全 |
| 不可降级项 | CAS 拒绝、trigger 只追加、fail-closed 加载、canonical 稳定性、chain_mode 透传、伪造签名拒绝 | 任何降级提议必须报用户，不自行裁量 |

## 6. 进度汇报模板

每次向用户汇报使用以下模板（无 emoji，技术直述）：

```markdown
# Phase 0a 进度汇报（YYYY-MM-DD）

## 当前里程碑
M<x>：<里程碑名>（进入条件：达成/未达成）

## 已完成任务
- [完成] T<x> <标题>：<验收依据：测试文件名 + 全绿；或检查点结论>

## 进行中任务
- [进行中] T<x> <标题>：当前步骤（red/green/refactor）；预计剩余轮次；阻塞点（如有）

## 阻塞/风险
- [风险] <描述 + 影响 + 建议处理>（等级：高/中/低）

## 下一步计划
- <未来 1–3 天任务安排，含并行波次>

## 需要用户决策的问题
1. <问题 + 选项 + 建议>
```

## 7. 给 coder 的任务领取说明

1. **领取前**：完整阅读本任务书对应任务条目、架构文档对应章节（§/验收/风险）、`doc/design/progress/2026-08-28-existing-modules-survey.md` 相关层、AGENTS.md 的测试与提交纪律。禁止只凭任务摘要开工。
2. **领取动作**：在 `doc/design/progress/2026-08-28-phase0a-progress.md` 的状态表中把任务标记为 `in_progress`，注明执行 agent 标识与时间；若任务有前序未完成（如 T6b 等 T6a），标记 `blocked` 并写明依赖。
3. **TDD 流程**：按任务条目的 TDD 入口测试文件名先写 failing test → 运行确认 red → 实现 → 确认 green → 重构 → 跑通全部相关测试。测试命令遵守 AGENTS.md：agent-server 用 `scripts/with-node25.sh` 下的 vitest，coding-agent 用 harness + faux provider，禁止真实 provider/API key。
4. **完成动作**：运行 `npm run check`（full output，无错误）与本任务相关测试全绿 → progress 状态表标记 `done` + 产出（文件路径/commit）→ 在"交接信息"节登记：环境事实、坑、接口结论（供下游任务引用）。
5. **中断/阻塞**：标记 `blocked`，写明原因与需要的决策（如 T4 的包入仓方式、T6b 注入点选择），不得静默搁置；恢复时更新状态。
6. **文件纪律**：只修改本任务条目声明归属的文件（§2 冲突矩阵）；progress 文件用最小编辑（edit 单行状态），不整篇重写；commit 只 stage 本会话文件，格式遵循 AGENTS.md。
7. **验收自检**：对照任务条目"验收"列的 A 编号，逐条确认有对应测试与结果；拿不准的判定（如 A4 本地降级口径）在汇报中显式列出，不自行宣布通过。
