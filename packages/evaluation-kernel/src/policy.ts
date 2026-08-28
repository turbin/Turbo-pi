// M0 策略快照：chain_mode、denylist 版本与 immutablePaths（架构 §2.2、§3.1、§7）。
// chain_mode 在 0a 恒为 local_diagnostic（D6/P2 fail-closed 默认）；
// 任何签名输出/报告必须透传该标记，本地链不得宣称防重写（A9）。
// denylistSha = sha256(canonicalJson({ policyVersion, immutablePaths, chainMode }))，
// 同一快照内容机械可复现。

import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { ChainMode, M0PolicySnapshot } from "./ipc/contract.ts";

export const CHAIN_MODE: ChainMode = "local_diagnostic";
export const M0_POLICY_VERSION = "m0-policy-0a-1";

/** M0 不可变路径（候选进程只读；写入由 OS 身份/capability 拒绝，denylist 为纵深防御）。 */
export const IMMUTABLE_PATHS: readonly string[] = [
	"packages/evaluation-kernel/",
	"manifests/",
	"graders/",
	"preflight/",
	"dlp/",
	"budget/",
	"packages/agent-server/src/evolution/promotion-controller.ts",
	"packages/agent-server/src/evolution/bundle-builder.ts",
	"packages/agent-server/src/evolution/artifact-registry.ts",
	"packages/agent/src/agent-loop.ts",
];

export function denylistSha(): string {
	return sha256Hex(
		canonicalJson({ policyVersion: M0_POLICY_VERSION, immutablePaths: IMMUTABLE_PATHS, chainMode: CHAIN_MODE }),
	);
}

export function m0PolicySnapshot(): M0PolicySnapshot {
	return {
		policyVersion: M0_POLICY_VERSION,
		denylistSha: denylistSha(),
		immutablePaths: [...IMMUTABLE_PATHS],
		chainMode: CHAIN_MODE,
	};
}

/** 目录条目按前缀匹配；文件条目精确匹配。 */
export function isImmutablePathHit(path: string): boolean {
	return IMMUTABLE_PATHS.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** 声明写入意图的字段：scope（白名单）、paths、*_path、*_paths。 */
function isWriteIntentKey(key: string): boolean {
	return key === "scope" || key === "paths" || key.endsWith("_path") || key.endsWith("_paths");
}

function collectPathStrings(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) collectPathStrings(item, out);
	}
}

/**
 * manifest 的 M0 denylist 检查：任何声明写入意图的字段中出现 M0 路径即拒绝。
 * 0a 口径：只检查写意图字段（读引用如 evidence_refs 不触发）；
 * 字段级精确语义与 gen0 scope 取值在 T8 跨实现对账时收敛。
 */
export function manifestHitsM0Denylist(manifest: Record<string, unknown>): boolean {
	for (const [key, value] of Object.entries(manifest)) {
		if (!isWriteIntentKey(key)) continue;
		const candidates: string[] = [];
		collectPathStrings(value, candidates);
		if (candidates.some(isImmutablePathHit)) return true;
	}
	return false;
}
