import { canonicalJson, sha256Hex } from "../canonical.ts";
import type { ChainMode, KeyId, MethodContext, SignAttestationRequest, SignedAttestation } from "../ipc/contract.ts";
import { CHAIN_MODE } from "../policy.ts";
import {
	asObject,
	requireEnum,
	requireNonNegativeInteger,
	requireNumber,
	requireObject,
	requireSha256Hex,
	requireString,
} from "./validate.ts";

const VERDICTS = ["pass", "reject", "quarantine", "inconclusive"] as const;

/**
 * attestation payload 为 canonical JSON，attestationId = sha256(payload)（§6.2）。
 * payload 含 signerKeyId 与 chainMode（D6）：verifyAttestation 以 payload 内 key id 为准，
 * 防止 key-id 混淆；无时间戳字段保证全链可重建。
 * baselineArtifactId 仅在显式提供时进入 payload（gen0 NULL 合法）。
 */
export function buildAttestationPayload(req: SignAttestationRequest, signerKeyId: KeyId, chainMode: ChainMode): string {
	const payload: Record<string, unknown> = {
		contractId: req.contractId,
		artifactId: req.artifactId,
		workspaceTreeSha: req.workspaceTreeSha,
		metrics: req.metrics,
		traceRef: req.traceRef,
		failureClassification: req.failureClassification,
		verdict: req.verdict,
		signerKeyId,
		chainMode,
	};
	if (req.baselineArtifactId !== undefined) {
		payload.baselineArtifactId = req.baselineArtifactId;
	}
	return canonicalJson(payload);
}

export async function handleSignAttestation(ctx: MethodContext, params: unknown): Promise<SignedAttestation> {
	const req = asObject(params);

	const metrics = requireObject(req, "metrics");
	const request: SignAttestationRequest = {
		contractId: requireSha256Hex(req, "contractId"),
		artifactId: requireSha256Hex(req, "artifactId"),
		workspaceTreeSha: requireSha256Hex(req, "workspaceTreeSha"),
		metrics: {
			success: requireNumber(metrics, "success", "metrics.success"),
			deliveryCompleteness: requireNumber(metrics, "deliveryCompleteness", "metrics.deliveryCompleteness"),
			disaster: requireNumber(metrics, "disaster", "metrics.disaster"),
			toolFailures: requireNonNegativeInteger(metrics, "toolFailures", "metrics.toolFailures"),
			realTokens: requireNonNegativeInteger(metrics, "realTokens", "metrics.realTokens"),
			costMicros: requireNonNegativeInteger(metrics, "costMicros", "metrics.costMicros"),
		},
		traceRef: requireString(req, "traceRef"),
		failureClassification: requireString(req, "failureClassification"),
		verdict: requireEnum(req, "verdict", VERDICTS),
	};
	if (req.baselineArtifactId !== undefined) {
		request.baselineArtifactId = requireSha256Hex(req, "baselineArtifactId");
	}

	const payload = buildAttestationPayload(request, ctx.signer.keyId, CHAIN_MODE);
	const attestationId = sha256Hex(payload);
	const { signature, keyId } = ctx.signer.signString(payload);
	return { attestationId, payload, signerKeyId: keyId, signature, chainMode: CHAIN_MODE };
}
