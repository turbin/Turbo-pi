import { canonicalJson, computeArtifactId, stripBundleSignature } from "../canonical.ts";
import { type BundleVerification, type MethodContext, TekError } from "../ipc/contract.ts";
import { manifestHitsM0Denylist } from "../policy.ts";
import { asObject, requireSha256Hex, requireString, requireStringArray } from "./validate.ts";

function extractBundleSignature(
	manifest: Record<string, unknown>,
): { signerKeyId: string; signature: string } | undefined {
	const block = manifest.bundle_signature;
	if (typeof block !== "object" || block === null) return undefined;
	const record = block as Record<string, unknown>;
	if (typeof record.signer_key_id !== "string" || typeof record.signature !== "string") return undefined;
	return { signerKeyId: record.signer_key_id, signature: record.signature };
}

export async function handleVerifyBundle(ctx: MethodContext, params: unknown): Promise<BundleVerification> {
	const req = asObject(params);
	const artifactId = requireSha256Hex(req, "artifactId");
	const blobShas = requireStringArray(req, "blobShas");
	const manifestString = requireString(req, "manifest");

	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestString);
	} catch {
		// 不可解析的 manifest 不是合法输入（fail closed）
		throw new TekError("invalid_request", "field manifest must be valid JSON", "manifest");
	}
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new TekError("invalid_request", "field manifest must be a JSON object", "manifest");
	}
	const manifestRecord = manifest as Record<string, unknown>;

	const declared = manifestRecord.blob_hashes;

	// 1) blobs：实际持有 blob 与 manifest 声明一致
	const blobsOk =
		Array.isArray(declared) &&
		declared.length === blobShas.length &&
		declared.every((hash, index) => typeof hash === "string" && hash === blobShas[index]);

	// 2) manifestId：重算 artifact_id 与声明一致
	let manifestIdOk = false;
	if (Array.isArray(declared)) {
		try {
			manifestIdOk = computeArtifactId(manifestRecord) === artifactId;
		} catch {
			manifestIdOk = false;
		}
	}

	// 3) m0Denylist：manifest 无 M0 路径/字段触碰
	const denylistOk = !manifestHitsM0Denylist(manifestRecord);

	// 4) signature：bundle 签名（覆盖剥离签名块后的 canonical manifest）
	let signatureOk = false;
	const bundleSignature = extractBundleSignature(manifestRecord);
	if (bundleSignature) {
		const canonical = canonicalJson(stripBundleSignature(manifestRecord));
		signatureOk = ctx.signer.verifyString(canonical, bundleSignature.signature, bundleSignature.signerKeyId);
	}

	const checks = { blobs: blobsOk, manifestId: manifestIdOk, m0Denylist: denylistOk, signature: signatureOk };
	const verified = blobsOk && manifestIdOk && denylistOk && signatureOk;
	let failReason: BundleVerification["failReason"];
	if (!verified) {
		if (!blobsOk) failReason = "hash_mismatch";
		else if (!manifestIdOk) failReason = "id_mismatch";
		else if (!denylistOk) failReason = "denylist_hit";
		else failReason = "signature_invalid";
	}

	return { verified, checks, failReason };
}
