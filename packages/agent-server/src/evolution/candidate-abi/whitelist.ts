/**
 * P5-1: capability-limited candidate-extension path whitelist.
 *
 * A candidate source patch may only create or modify files under designated
 * directories. The default whitelist is intentionally narrow: candidates must
 * not touch the host runtime, evaluator, held-out manifest, preflight gates,
 * budget controller, rollback controller, or user data.
 */

export const DEFAULT_CANDIDATE_PATH_WHITELIST = [
	".pi/candidate-extensions/",
	"packages/coding-agent/src/core/extensions/candidate-policies/",
] as const;

export interface PathValidationResult {
	ok: true;
}

export interface PathValidationFailure {
	ok: false;
	reason: string;
}

export type PathValidation = PathValidationResult | PathValidationFailure;

function isPathInside(child: string, parent: string): boolean {
	// Normalize to forward slashes and ensure both end with a separator so
	// "foo/bar" does not match "foo/barbaz".
	const normalizedChild = child.replace(/\\/g, "/").replace(/\/+/g, "/");
	const normalizedParent = parent.replace(/\\/g, "/").replace(/\/+/g, "/");
	if (!normalizedParent.endsWith("/")) {
		return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
	}
	return normalizedChild === normalizedParent.slice(0, -1) || normalizedChild.startsWith(normalizedParent);
}

/**
 * Validates that a candidate target path is within one of the whitelisted
 * directory prefixes.
 *
 * Rejects absolute paths, paths containing "..", and paths outside the
 * whitelist. The comparison is case-sensitive and uses forward-slash
 * normalization.
 */
export function validateCandidatePath(path: string, whitelist: readonly string[]): PathValidation {
	if (typeof path !== "string" || path.length === 0) {
		return { ok: false, reason: "path must be a non-empty string" };
	}
	if (path.startsWith("/")) {
		return { ok: false, reason: "absolute paths are not allowed" };
	}
	if (path.includes("\\")) {
		return { ok: false, reason: "backslash separators are not allowed" };
	}
	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "..") {
			return { ok: false, reason: "parent-directory references are not allowed" };
		}
	}
	for (const prefix of whitelist) {
		if (isPathInside(path, prefix)) {
			return { ok: true };
		}
	}
	return { ok: false, reason: `path "${path}" is not in any whitelisted directory` };
}

/**
 * Validates every path in a list against the whitelist.
 */
export function validateCandidatePaths(paths: string[], whitelist: readonly string[]): PathValidation {
	for (const path of paths) {
		const result = validateCandidatePath(path, whitelist);
		if (!result.ok) {
			return result;
		}
	}
	return { ok: true };
}
