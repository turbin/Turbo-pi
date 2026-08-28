import { sha256Hex } from "../canonical.ts";
import type { MethodContext, VerificationResult } from "../ipc/contract.ts";
import { asObject, requireSha256Hex, requireString } from "./validate.ts";

/**
 * 验证顺序（任一失败即拒绝，fail closed）：
 * 1. payload 可解析为 JSON 对象，且 sha256(payload) === attestationId → 否则 chain_break；
 * 2. payload.signerKeyId === 请求 signerKeyId（防 key-id 混淆）→ 否则 bad_signature；
 * 3. signerKeyId 在密钥注册表内 → 否则 unknown_key；
 * 4. 签名验证 → 否则 bad_signature。
 * 撤销（revoked）在 0a 无独立撤销存储（撤销事件属 evolution.db，Phase 1 接入），
 * 本方法保留枚举位但恒不命中；verdict_effective 派生由 agent-server 读取路径实现（§6.2）。
 */
export async function handleVerifyAttestation(_ctx: MethodContext, params: unknown): Promise<VerificationResult> {
	const req = asObject(params);
	const attestationId = requireSha256Hex(req, "attestationId");
	const payload = requireString(req, "payload");
	const signature = requireString(req, "signature");
	const signerKeyId = requireString(req, "signerKeyId");

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return { valid: false, reason: "chain_break" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { valid: false, reason: "chain_break" };
	}
	const payloadRecord = parsed as Record<string, unknown>;

	if (sha256Hex(payload) !== attestationId) {
		return { valid: false, reason: "chain_break" };
	}
	if (payloadRecord.signerKeyId !== signerKeyId) {
		return { valid: false, reason: "bad_signature" };
	}
	if (!_ctx.signer.hasKey(signerKeyId)) {
		return { valid: false, reason: "unknown_key" };
	}
	if (!_ctx.signer.verifyString(payload, signature, signerKeyId)) {
		return { valid: false, reason: "bad_signature" };
	}
	return { valid: true, reason: "ok" };
}
