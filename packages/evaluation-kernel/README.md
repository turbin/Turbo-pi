# @earendil-works/evaluation-kernel（TEK，Phase 0a 骨架）

Trusted Evaluation Kernel —— 独立私有包（`private: true`，不进发布集，**不 import 任何
`@earendil-works/*` workspace 包**）。0a 只做合同固定、bundle 验证、attestation 签发与
M0 策略暴露；**不实现** grader 执行、runner、候选生成（架构 §1.2）。

- 架构：`doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md`（§3.1/3.2 部署与 IPC、§7 契约）
- 任务书：`doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md`（T4）

## 布局

```text
src/ipc/contract.ts          唯一对外接口面：契约类型、帧格式、错误码（对齐架构 §7）
src/ipc/protocol.ts          NDJSON 帧编解码
src/ipc/client.ts            kernel 内 IPC 客户端（测试与内部使用；外部调用方须按契约自实现）
src/canonical.ts             canonical JSON + sha256 + artifact_id（kernel 独立实现，T2 跨实现对账）
src/signer.ts                Ed25519 dev 密钥（key_id 前缀 dev-）、凭据目录权限强制（fail closed）
src/policy.ts                M0 策略快照（chain_mode / denylistSha / immutablePaths）
src/ipc-server.ts            Unix socket（mode 0600）+ 每调用令牌认证，只分发 6 方法
src/methods/*.ts             health / pinTaskContract / verifyBundle / signAttestation /
                             verifyAttestation / getM0Policy
src/main.ts                  进程入口
test/ipc.test.ts             进程级测试（spawn 真实进程 + socket 调用）
```

## 运行

```bash
npm run test                # vitest（进程级 ipc.test.ts）
npm run start               # 启动 TEK 进程（需先 npm install 后 tsx 可用）
```

环境变量：`TEK_CREDENTIALS_DIR`（默认 `~/.pi-tek/credentials`，mode 0700）、
`TEK_SOCKET_PATH`（默认 `~/.pi-tek/tek.sock`）、`TEK_AUTH_TOKEN`（默认启动时生成并写入
`<credsDir>/auth.token`，mode 0600）。

## 契约要点

- 6 个方法，全部要求认证（每调用独立，无长会话）；未知方法、`ipcVersion` 不匹配、超长载荷均拒绝。
- 入参缺任一必填字段 → `missing_field`（含字段名）；格式错误 → `invalid_request`（fail closed）。
- 所有签名输出携带 `chain_mode`，0a 恒为 `local_diagnostic`（D6/P2）；本地链不得宣称防重写（A9）。

## canonical 规则（与 T2 对账的纯文本规范）

1. canonical JSON：对象键按 UTF-16 码元字典序、数组保序、无空白、数字按 JSON 数字字面量。
2. `artifact_id = sha256_hex(canonical_manifest + canonical(blob_hashes))`（架构 §3.3），
   canonical manifest 为剥离顶层 `bundle_signature` 后的对象；bundle 签名覆盖同一 canonical manifest。
3. 不含时间戳/随机字段：同一输入产出同一字节序列（A3）。

## A4 本地降级口径

本地 macOS 无法真实切换 OS 身份：以「凭据目录 mode 0700 + 密钥文件 mode 0600 + socket mode 0600」
降级验证 A4 的可验证部分（测试输出中有标注）；真实 uid 隔离（pi-tek vs pi-evo/pi-run）由 CI Linux
容器覆盖（T8）。
