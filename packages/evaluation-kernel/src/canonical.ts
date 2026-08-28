// canonical JSON 序列化与内容寻址哈希（kernel 内独立实现，不依赖任何 workspace 包）。
//
// 纯文本规范（T2 任务输出中固化同规则，T8 跨实现对账）：
// 1. canonical JSON：对象键按 UTF-16 码元字典序排序；数组保序；无空白；
//    字符串按 JSON 转义；数字按 JSON 数字字面量（整数不经指数形式）；null/boolean 原样。
// 2. sha256 hex：小写 64 位十六进制。
// 3. bundle 结构：manifest JSON 内嵌声明 `blob_hashes`（blob SHA256 数组）；
//    签名块为顶层 `bundle_signature = { signer_key_id, signature }`，不参与哈希。
//    canonical manifest = 剥离 bundle_signature 后的对象。
// 4. artifact_id = sha256_hex(canonical_manifest + canonical(blob_hashes))（架构 §3.3：
//    "canonical_manifest + blob_hashes"，两个操作数按上述规范编码后字符串拼接）。
// 5. 不含时间戳/随机字段——同一输入永远产出同一字节序列（A3）。
// 6. 数字精度：整数须在 Number.MAX_SAFE_INTEGER 内，避免 JSON 解析精度丢失
//    （cost_micros 等字段调用方负责；本层不做隐式四舍五入）。

export const BUNDLE_SIGNATURE_KEY = "bundle_signature";

import { createHash } from "node:crypto";

export function canonicalize(value: unknown): unknown {
	if (value === undefined) {
		throw new TypeError("canonical JSON: undefined is not representable (fail closed)");
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new TypeError("canonical JSON: non-finite number is not representable (fail closed)");
	}
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			out[key] = canonicalize(record[key]);
		}
		return out;
	}
	return value;
}

/** 稳定序列化：键排序、无空白、无随机字段。 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

/** 剥离 bundle 签名块后返回 canonical manifest 对象。 */
export function stripBundleSignature(manifest: Record<string, unknown>): Record<string, unknown> {
	const { [BUNDLE_SIGNATURE_KEY]: _signature, ...rest } = manifest;
	return rest;
}

/**
 * artifact_id = sha256(canonical_manifest + blob_hashes)。
 * manifest 缺 blob_hashes 数组时抛 TypeError（调用方按检查失败处理，fail closed）。
 */
export function computeArtifactId(manifest: Record<string, unknown>): string {
	const canonicalManifest = stripBundleSignature(manifest);
	const blobHashes = canonicalManifest.blob_hashes;
	if (!Array.isArray(blobHashes)) {
		throw new TypeError("manifest.blob_hashes must be an array");
	}
	return sha256Hex(canonicalJson(canonicalManifest) + canonicalJson(blobHashes));
}
