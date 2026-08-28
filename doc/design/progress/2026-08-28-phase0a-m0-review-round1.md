# Phase 0a M0 第一轮 critic-reviewer 审查报告（T1/T2/T4）

日期：2026-08-28
审查人：critic-reviewer（M0 首轮）
范围：T1（evolution.db schema / DAO）、T2（canonical / artifact manifest）、T4（evaluation-kernel TEK 骨架）
依据：任务书 `plans/2026-08-28-self-evolving-phase0a-tasks.md`（§2 各任务条目、§4 M0 退出条件）、架构 `plans/2026-08-28-self-evolving-phase0a-architecture.md`（§6/§7/§8/§10）、进度文件 `progress/2026-08-28-phase0a-progress.md`、`AGENTS.md`

验证方式：全部测试实跑（agent-server 40/40 绿、kernel 20/20 绿，均经 `scripts/with-node25.sh`）；tsgo --noEmit 全量实跑并核对归属；biome 实跑；T2/T4 canonical 跨实现字节对账脚本实跑；TEK 进程重启/超长帧/畸形帧手工 socket 验证。

---

## 1. 审查结论

**有条件通过（conditional pass）**。

架构一致性、契约正确性与 fail-closed 设计整体扎实：六表字段/类型/约束/CHECK 枚举与架构 §6 逐项一致；§7 六个方法签名与类型逐类型一致；T2/T4 canonical 跨实现字节级对账通过（含边界值）；未触碰任何冻结面；M0 拒绝标准（字段不一致 / trigger 可绕过 / canonical 含时间戳 / 契约外方法 / pending_0b 缺失）**均未触发**。

但存在 **3 个 blocking 级问题**，修复前 M0 不应关闭：

- **B1**：T1 自带测试文件 `schema.test.ts` 有 **15 个 tsgo 类型错误**（`npm run check` 的 CI 门会红；vitest 因 esbuild 剥类型而假绿）。
- **B2**：T1 `schema.test.ts:6` 存在未使用 import（biome `--error-on-warnings` 红）；进度文件声称已修复，实际未修复。
- **B3**：TEK 进程重启缺陷——未注入 `TEK_AUTH_TOKEN` 时第二次启动必然 EEXIST 崩溃（`main.ts:29`），常驻进程无法被 supervisor 重启。

B1/B2 是检查门违规（AGENTS.md 硬约束），B3 是 T4 进程入口交付物的功能性缺陷。三者均不涉及架构语义错误，修复量小；建议修复后复审一次（见 §7）。

---

## 2. 逐任务审查表

| 任务 | 测试实测 | 行数（预算） | 关键优点 | 问题 / 风险 |
|---|---|---|---|---|
| **T1** schema/DAO | 23/23 绿（实跑） | 1396 行（~900 估算；3000 硬上限内） | ① 六表字段/类型/PK/NOT NULL/DEFAULT/FK/UNIQUE/CHECK 与 §6 逐列一致（PRAGMA 断言 + 行为断言双覆盖）；② 7 个 CHECK 枚举列全部有 invalid/valid 用例；③ 全部 8 条 FK（含自引用 previous_event_id、baseline_artifact_id）有悬挂引用拒绝用例；④ DAO 层防御纵深：原型面只有 append* 方法 + 无 trigger 环境下 SQL 捕获断言全部为 INSERT（A2 核心）；⑤ trigger 拒绝 UPDATE/DELETE 且断言行存活；⑥ UNIQUE(task_id, slot, resolved_at) 幂等键、UNIQUE(seq)、'[]' 默认值均有覆盖 | **B1**（15 个 tsgo 错，见 §4）；**B2**（未用 import）；M3（重复吊销无显式用例，仅靠 PK 隐式覆盖）；注：`previous_event_id IS NULL ⇒ seq=1` 属 T5 状态机职责，T1 不承担（与任务书一致） |
| **T2** canonical/manifest | 17/17 绿（实跑） | 510 行（~450 估算） | ① 冻结规范以纯文本写入 `canonical.ts` 头注释（键排序算法/数字处理/字符串转义/失败语义），满足"规范固化"要求；② 未知字段拒绝（created_at/artifact_id/随机字段进 manifest 即拒）保证 hash 无噪声（A3）；③ `recomputeArtifactId` 对非 canonical 存储文本抛错（全链重建锚点 fail closed）；④ -0→0、2^53 内整数纯十进制（cost_micros 精度）、NaN/Infinity/undefined/function/symbol/bigint 一律抛错不静默降级；⑤ MANIFEST_FIELDS 与进度文件登记的冻结命名表一致 | 无 blocking 问题。M2 中提到与 kernel 的 scope 非空口径差异（见 §5） |
| **T4** TEK 骨架 | 20/20 绿（实跑） | 1616 行（~1800 估算） | ① §7 六个方法签名/类型/错误码逐类型一致，HANDLERS 恰为 6 个，无契约外方法；② 认证顺序 fail-closed 且先查 ipcVersion 再查 token；③ verifyAttestation 四步顺序（hash→key-id 混淆→注册表→验签）防 key-id 混淆；④ bundle 无签名块时 signature 检查恒 false（不静默通过）；⑤ key_id=`dev-` 前缀、凭据目录 0700/密钥 0600/socket 0600 强制并在测试断言；⑥ A4 本地降级如实标注（不冒充 uid 隔离）；⑦ chain_mode 恒 `local_diagnostic` 且随 health/policy/contract/attestation 透传；⑧ payload 无时间戳，同请求同 payload 确定性有测试 | **B3**（重启 EEXIST 崩溃）；M1（超长帧/畸形帧/缺 token/缺 ipcVersion 有行为无测试）；M2（kernel 未做 manifest schema 校验，`scope:[]` 通过而 T2 校验器拒绝）；M4（bin/ 与独立密钥脚本以 npm script + 启动时生成替代，属口径偏差需用户知悉）；M6（sendErrorAndClose 后若继续收到帧可能 write-after-end，无害但可加 destroyed 守卫） |

---

## 3. 跨实现对账（T2 vs T4 canonical）

手工构造一个 §6.1 语义的 manifest（kind=experience_snapshot、operator=draft、scope=[packages/experience/, config/agent.md]、evidence_refs=架构文档引用、scaffold_hash=64 hex、model_fingerprint=JSON 对象、data_class=diagnostic_ops、retention_policy_ref=`pending_0b`、blob_hashes=[b×64, c×64]），分别用 T2（`agent-server/src/evolution/canonical.ts`）与 T4（`evaluation-kernel/src/canonical.ts`）计算：

| 对账项 | 结果 |
|---|---|
| canonical 序列化字节 | **一致**（两实现输出完全相同文本） |
| `artifact_id` | **一致**：`e782e2417c424afd79346627c4968e6d577592b11b084f1dfea6ee2346cfb0f6` |
| kernel 带 `bundle_signature` 的 bundle 剥离签名块后 ID | 与无签名 ID 一致（剥离约定生效） |
| 边界值：`-0`、`9007199254740991`（2^53-1）、`1.5`、`1e21`、`\n`/U+2028 控制字符、嵌套键序 | 两实现输出一致 |
| NaN / Infinity / undefined | 两实现均抛错（fail closed 一致） |
| T2 `recomputeArtifactId(存储文本)` | 与 kernel ID 一致（全链重建锚点互通） |

**结论：T2/T4 的 canonical 与 artifact_id 字节合同已手工对账一致**（任务书 §4 M0 退出条件第 4 项达成，可作 T8 前置抽查记录）。残留差异仅一处：kernel 校验器不检查 `scope` 非空与 `scaffold_hash`/`blob_hashes` 的 64-hex 格式（T2 校验器检查），见 §5 M2——不影响 hash 合同，但 T8 对账时应把"同一 manifest 两边的接受/拒绝集"固定下来。

---

## 4. 问题清单（必须修复）

### B1（blocking）T1 测试文件 15 个 tsgo 类型错误

- **位置**：`packages/agent-server/test/evolution/schema.test.ts`，错误行：391、403、551、552、557、566、567、574、603、604、605、606、607、618、619（涉及用例："DAO rejects every missing required field"、"rejects invalid enum values"、"rejects malformed JSON text fields"、"rejects non-array JSON array fields"、"throws AppendRejectedError"、"DAO omitting optional array fields"、"appendJournal accepts written state"）。
- **严重程度**：blocking（检查门）。
- **原因**：测试用 `Record<string, unknown>` 泛化 DAO 方法并做 `{...typedInput, field: "bad"}` 覆盖，typed input 接口与 `Record<string, unknown>` 不兼容（TS2322/TS2352/TS2740/TS2739）；vitest 经 esbuild 剥类型，运行时全绿造成"测试过了"的假象。
- **影响**：`npm run check`（AGENTS.md 硬约束 + CI `.github/workflows/ci.yml` 会跑）在 T1 文件上失败；当前全仓 tsgo 58 个错误中 **15 个属于本任务**（其余 43 个为 `packages/ai/test` 预存在问题，与本任务无关）。
- **建议修复**：DAO 输入统一以 `Record<string, unknown>` 构造（fixture 函数返回类型改为 `Record<string, unknown>`），非法值用例用 `as never`/先构造 unknown 再断言，与 `dao.appendArtifact({ ...daoArtifactInput(), kind: "binary_patch" })` 同款手法统一即可；修完跑 `npx tsgo --noEmit` 确认 evolution 目录零错误。
- **对应验收**：AGENTS.md 检查门；任务书 M3 退出条件（`npm run check` 全绿）的前置。

### B2（blocking）T1 测试文件未使用 import

- **位置**：`packages/agent-server/test/evolution/schema.test.ts:6`（`APPEND_ONLY_TRIGGERS_SQL` 导入后无任何使用）。
- **严重程度**：blocking（检查门；biome `--error-on-warnings` 红）。
- **原因**：重构后该符号不再被引用（trigger 存在性改查 `sqlite_master`，无 trigger 场景只用 `SCHEMA_SQL`）。
- **影响**：`npm run check` 的 biome 步骤失败；进度文件 2026-08-28T14:25 条目隐含已修复，与现状矛盾（交接信息失真，见 M7）。
- **建议修复**：删除该 import 项。
- **对应验收**：AGENTS.md 检查门。

### B3（blocking）TEK 进程重启必然崩溃（auth.token EEXIST）

- **位置**：`packages/evaluation-kernel/src/main.ts:29`（`writeFileSync(join(credsDir, AUTH_TOKEN_FILE), token, { mode: 0o600, flag: "wx" })`）。
- **严重程度**：blocking（T4 进程入口交付物功能性缺陷）。
- **原因**：未注入 `TEK_AUTH_TOKEN` 时每次启动都生成新 token 并 `wx` 独占写；凭据目录持久化后第二次启动（supervisor 重启、崩溃恢复——正是架构 §10.2"TEK 进程不可用→全部暂停，恢复依赖重启"的场景）必然 EEXIST，进程 exit 1。已实跑复现（exit code 1，堆栈指向 main.ts:29）。
- **影响**：本地 dev 常驻进程无法重启；虽然"起不来"本身是 fail-closed（不会弱化认证），但违背"进程入口/凭据目录布局"交付意图，且会让下游（T9 一键重建、T8 进程测试）在真实 dev 目录上踩坑。
- **建议修复**：`auth.token` 已存在时改为读取并复用（读取前断言 mode 0600，与 signer 文件同款 `assertPrivateFile`）；不存在才生成（保持 `wx`）。token 持久化复用不影响"每调用认证"语义。
- **对应验收**：任务书 T4 输出（进程入口与凭据目录布局）、§10.2 恢复路径。

---

## 5. 建议清单（可选优化，非阻塞）

- **M1（建议）超长/畸形帧行为无测试**：`ipc-server.ts` 的 `MAX_FRAME_BYTES` 超长拒绝、畸形 JSON、非对象帧、缺 token 字段、缺 ipcVersion 字段的拒绝行为已手工 socket 验证全部 fail-closed 正确，但 `test/ipc.test.ts` 20 个用例均未覆盖（A5 明确列"超长载荷拒绝"）。建议补 5 个 raw-socket 用例。
- **M2（建议）kernel 与 T2 的 manifest 校验口径差异需在 T8 固定**：kernel `verifyBundle` 只做四检查，不做 manifest schema 校验；kernel 测试 fixture 用 `scope: []`，而 T2 冻结命名表要求 `scope` 非空、`scaffold_hash`/`blob_hashes` 为 64-hex——同一 manifest T2 拒收、kernel 验收。0a 语义上可接受（kernel 是验证者不是作者，空 scope 无写意图、denylist 检查自然通过），但 T8 跨实现对账必须把"接受/拒绝集"对齐或显式文档化，避免 gen0 构建（T3 走 T2 校验器）与 TEK 验证（走四检查）出现事实漂移。
- **M3（建议）重复吊销无显式用例**：`attestation_revocations` PK=attestation_id 隐式保证"至多一次撤销"，但 T1 无对应显式断言；建议补一条"同 attestation 二次吊销被 UNIQUE 拒绝"。
- **M4（知悉）交付物形态偏差**：任务书列"进程入口 `bin/`、dev 密钥生成脚本"，实际为 npm script `start: tsx src/main.ts` + 启动时 `loadOrCreate` 生成。功能等价，但 M0 检查点"包入仓方式/目录布局"需用户确认时一并说明此形态。
- **M5（清理）仓库根目录残留 `debug-schema.mjs`**：未跟踪文件，内容是 T1 schema 的宽松简化版（PK 无 NOT NULL、无 trigger）——有被误用的风险，且违反"只 stage 自己会话文件"的卫生要求。建议删除或移入 /tmp 类位置。
- **M6（极低）`ipc-server.ts` write-after-end 可能**：`sendErrorAndClose` 后若同一连接继续发帧，`handleLine` 仍会处理并向已 `end()` 的 socket 写响应（异步 EPIPE 被 error handler 吞掉）。无安全影响（fail-closed 方向），可在写前加 `socket.destroyed` 守卫。
- **M7（交接）进度文件失实条目**：progress §3 中 coder-C 记录的"coder-A schema.test.ts 未用 import 1 个 biome warning"目前仍成立（B2 未修），而 T1 的 done 条目未标注检查门未过；建议修复 B1/B2 后同步更新进度文件（含 T1 的 `npm run check` 归属结论：58 错误中 15 个属 T1，43 个为 ai/test 预存在）。

---

## 6. M0 检查点评定（任务书 §4 退出条件逐项）

| # | M0 退出条件 | 判定 | 证据 |
|---|---|---|---|
| 1 | T1 约束测试全绿：六表建表、trigger 拒绝 UPDATE/DELETE、缺字段拒绝写入 | **有条件达成** | 23/23 实跑绿；但 B1（15 tsgo 错）+ B2（biome warning）未过检查门 |
| 2 | T2 canonical 测试全绿：同内容同 hash、语义字段变更 hash 必变、序列化稳定 | **达成** | 17/17 实跑绿；tsgo/biome 对该任务文件零错误 |
| 3 | T4 进程测试全绿：认证拒绝、未知方法拒绝、ipcVersion 拒绝、missing_field、签名可验证 | **达成（附缺陷）** | 20/20 实跑绿（spawn 真实进程 + socket）；B3 重启缺陷不影响用例但影响交付物 |
| 4 | T2/T4 canonical 冒烟对账（一个 manifest 手工比对） | **达成** | §3：字节一致，artifact_id=`e782e241…b0f6` 两边一致，含边界值（已在本报告留存） |
| 5 | 命名表（T1 表列 / T2 manifest / T7 预留）在 progress 文件登记 | **达成** | progress §3 有冻结命名表；T2 `MANIFEST_FIELDS` 与之逐项一致 |

M0 拒绝标准复核：字段与 §6 不一致——无（逐列核对 + PRAGMA 断言）；trigger 可被绕过——无（DAO 层无 UPDATE/DELETE/REPLACE 路径 + 无 trigger 环境 SQL 捕获测试）；canonical 含时间戳/随机字段——无；kernel 暴露契约外方法——无（恰 6 个）；`pending_0b` 未显式出现——否（T1 fixture/DAO 注释、T2 校验器提示、kernel 契约注释均显式出现）。

待用户/架构师确认项（不阻塞代码，但 M0 人工检查点需要）：① kernel 包入仓方式（private + lockstep 0.80.10 + package-lock 登记 12 行 + 不进 publish.mjs + 不进 root build——已按计划执行，待确认）；② A4 本地降级口径（权限位 + socket 0600 替代 uid 隔离，CI Linux 补测）已如实标注，待确认。

---

## 7. 下一轮审查触发条件

修复以下问题后触发 round 2 复审：

1. **B1**：schema.test.ts 15 个 tsgo 错误清零（`npx tsgo --noEmit` 确认 evolution 目录零错误，全仓错误回落至 43 个预存在项）。
2. **B2**：未使用 import 删除，biome 对 `packages/agent-server/src/evolution`、`test/evolution`、`packages/evaluation-kernel` 零告警。
3. **B3**：TEK 无 token 注入连续两次启动成功（凭据目录复用，auth.token 读取路径 + mode 0600 断言），并补一条进程级重启测试。

复审通过后 M0 方可向架构师/用户提交正式检查点汇报。M1–M5 为可选优化，可随下一轮一并处理（M1 建议与 T8 契约套件合并实施）。

---

## 附：验证环境记录

- 测试：`packages/agent-server` 下 `scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run test/evolution/schema.test.ts test/evolution/canonical.test.ts` → 2 files / 40 passed；`packages/evaluation-kernel` 下同命令 `test/ipc.test.ts` → 20 passed。
- tsgo：`npx tsgo --noEmit` → 58 错误，其中 15 个属 T1 schema.test.ts，43 个为 packages/ai/test 预存在；T2/T4 文件零错误。
- biome：`npx biome check packages/agent-server/src/evolution packages/agent-server/test/evolution packages/evaluation-kernel` → 23 files，1 warning（B2）。
- 手工验证：T2/T4 对账脚本（§3 结果）；TEK 重启（B3 复现）；超长帧 2MB / 畸形 JSON / 非对象帧 / 缺 token / 缺 ipcVersion 五项 socket 实测均 fail-closed 正确。
- 范围控制：`git diff HEAD` 对 `packages/agent/src/agent-loop.ts`、`retrieval.ts`、`injection.ts`、`experience-store.ts`、`agent-harness.ts`、`agent-session.ts` 均为空；无 `any`；kernel 无任何 `@earendil-works` import；无 enum/namespace（erasable syntax 合规）。
