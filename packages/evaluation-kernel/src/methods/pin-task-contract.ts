import { canonicalJson, sha256Hex } from "../canonical.ts";
import type { ChainMode, MethodContext, PinTaskContractRequest, SignedTaskContract } from "../ipc/contract.ts";
import { CHAIN_MODE, M0_POLICY_VERSION } from "../policy.ts";
import { asObject, requireBudget, requirePrefixedSha256Hex, requireSha256Hex } from "./validate.ts";

/**
 * 合同 payload 为全链重建输入：请求字段原样 + chainMode + policyVersion。
 * 无时间戳/随机字段（A3：canonical 稳定；同一请求产出同一 contractId）。
 *
 * A10 语义（post-D / issue-023）：
 * - preflightId 引用含余额检查与账户类错误快速失败条目的 preflight 清单版本（issue-023 待修第 3 条）；
 * - denylistRef 引用 runner denylist / M0 路径 denylist 版本；
 * - taskManifestSha 引用含确认集 denylist 的任务清单（post-D §154–155）。
 * 0a 只固定引用格式（`preflight-<sha256hex>` / `denylist-<sha256hex>`）并随签名对象透传，
 * 清单本体的解析与余额检查属 Phase 1+（P8 数值未裁决前不实现）。
 */
export function buildContractPayload(req: PinTaskContractRequest, chainMode: ChainMode, policyVersion: string): string {
	return canonicalJson({
		taskManifestSha: req.taskManifestSha,
		graderSha: req.graderSha,
		preflightId: req.preflightId,
		budget: req.budget,
		denylistRef: req.denylistRef,
		chainMode,
		policyVersion,
	});
}

export async function handlePinTaskContract(ctx: MethodContext, params: unknown): Promise<SignedTaskContract> {
	const req = asObject(params);
	const request: PinTaskContractRequest = {
		taskManifestSha: requireSha256Hex(req, "taskManifestSha"),
		graderSha: requireSha256Hex(req, "graderSha"),
		preflightId: requirePrefixedSha256Hex(req, "preflightId", "preflight"),
		budget: requireBudget(req, "budget"),
		denylistRef: requirePrefixedSha256Hex(req, "denylistRef", "denylist"),
	};

	const payload = buildContractPayload(request, CHAIN_MODE, M0_POLICY_VERSION);
	const contractId = sha256Hex(payload);
	const { signature, keyId } = ctx.signer.signString(payload);
	return { contractId, payload, signerKeyId: keyId, signature, chainMode: CHAIN_MODE };
}
