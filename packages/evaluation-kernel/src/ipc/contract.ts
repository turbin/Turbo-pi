// TEK 窄 IPC/API 契约（对齐架构文档 §7 完整契约草案）。
// 本文件是 TEK 对外唯一接口面；evaluation-kernel 其余模块不对外。
// 契约规则：无批量/分页/内省方法；每次调用独立认证，无长会话状态；
// ipcVersion 不匹配 → 拒绝；入参缺任一必填字段 → missing_field（fail closed）。

export const IPC_VERSION = 1;

/** 单帧上限（字节）；超长载荷直接拒绝并断开。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

export type ArtifactId = string; // sha256 hex
export type SlotName = string; // 如 "experience.active"
export type KeyId = string;
export type Signature = string; // base64
export type ChainMode = "local_diagnostic" | "worm_anchored";

export interface Budget {
	tokensCap: number; // 上限值由 Phase 0b 预注册，0a 只固定字段
	costCapMicros: number;
	wallTimeCapMs: number;
}

export interface PinTaskContractRequest {
	taskManifestSha: string; // 任务清单 SHA（含确认集 denylist 引用，post-D）
	graderSha: string; // grader 实现 SHA
	preflightId: string; // preflight 清单版本（含余额检查项，issue-023）
	budget: Budget;
	denylistRef: string; // runner denylist / M0 路径 denylist 版本
}

export interface SignedTaskContract {
	contractId: string; // sha256(canonical contract payload)
	payload: string; // canonical JSON（全链重建输入）
	signerKeyId: KeyId;
	signature: Signature;
	chainMode: ChainMode;
}

export interface VerifyBundleRequest {
	artifactId: ArtifactId;
	blobShas: string[]; // 实际持有 blob 的 SHA256 列表
	manifest: string; // canonical manifest JSON
}

export interface BundleVerification {
	verified: boolean;
	checks: {
		blobs: boolean; // blobShas 与 manifest 声明一致
		manifestId: boolean; // 重算 artifact_id 与声明一致
		m0Denylist: boolean; // manifest 无 M0 路径/字段触碰
		signature: boolean; // bundle 签名有效
	};
	failReason?: "hash_mismatch" | "id_mismatch" | "denylist_hit" | "signature_invalid" | "missing_field";
}

export interface SignAttestationRequest {
	contractId: string;
	artifactId: ArtifactId;
	baselineArtifactId?: ArtifactId; // gen0 缺省（NULL 合法）
	workspaceTreeSha: string; // post-D E0.2
	metrics: {
		success: number;
		deliveryCompleteness: number;
		disaster: number; // 灾难率（含零事件上界标记）
		toolFailures: number;
		realTokens: number; // 真实 token
		costMicros: number;
	};
	traceRef: string;
	failureClassification: string;
	verdict: "pass" | "reject" | "quarantine" | "inconclusive";
}

export interface SignedAttestation {
	attestationId: string;
	payload: string;
	signerKeyId: KeyId;
	signature: Signature;
	chainMode: ChainMode;
}

export interface VerifyAttestationRequest {
	attestationId: string;
	payload: string;
	signature: Signature;
	signerKeyId: KeyId;
}

export interface VerificationResult {
	valid: boolean;
	reason?: "bad_signature" | "unknown_key" | "revoked" | "chain_break" | "ok";
}

export interface M0PolicySnapshot {
	policyVersion: string;
	denylistSha: string;
	immutablePaths: string[]; // M0 路径清单（只读挂载 + capability 拒绝）
	chainMode: ChainMode;
}

export interface TekHealth {
	status: "ok";
	ipcVersion: number; // 契约版本；不匹配的调用方拒绝
	signerKeyId: KeyId;
	chainMode: ChainMode;
}

export interface TekMethods {
	health: { params: undefined; result: TekHealth };
	pinTaskContract: { params: PinTaskContractRequest; result: SignedTaskContract };
	verifyBundle: { params: VerifyBundleRequest; result: BundleVerification };
	signAttestation: { params: SignAttestationRequest; result: SignedAttestation };
	verifyAttestation: { params: VerifyAttestationRequest; result: VerificationResult };
	getM0Policy: { params: undefined; result: M0PolicySnapshot };
}

export type MethodName = keyof TekMethods;

export type ErrorCode =
	| "unauthorized"
	| "unknown_method"
	| "ipc_version_mismatch"
	| "missing_field"
	| "invalid_request"
	| "internal_error";

/** 调用方错误（handler 抛出；server 映射为错误响应）。 */
export class TekError extends Error {
	readonly code: ErrorCode;
	readonly field?: string;

	constructor(code: ErrorCode, message: string, field?: string) {
		super(message);
		this.name = "TekError";
		this.code = code;
		this.field = field;
	}
}

// --- 传输帧（Unix domain socket, NDJSON） ---

export interface IpcRequest {
	ipcVersion: number;
	token: string;
	id: string;
	method: string;
	params: unknown;
}

export interface IpcSuccess {
	id: string;
	ok: true;
	result: unknown;
}

export interface IpcFailure {
	id: string;
	ok: false;
	error: { code: ErrorCode; message: string; field?: string };
}

export type IpcResponse = IpcSuccess | IpcFailure;

// --- 方法上下文（结构性类型，避免 contract.ts 依赖具体实现） ---

export interface SignerLike {
	keyId: KeyId;
	signString(payload: string): { signature: Signature; keyId: KeyId };
	verifyString(payload: string, signature: Signature, keyId: KeyId): boolean;
	/** keyId 是否在密钥注册表内（用于区分 unknown_key 与 bad_signature）。 */
	hasKey(keyId: KeyId): boolean;
}

export interface MethodContext {
	signer: SignerLike;
	policy: M0PolicySnapshot;
}

export type MethodHandler = (ctx: MethodContext, params: unknown) => Promise<unknown>;
