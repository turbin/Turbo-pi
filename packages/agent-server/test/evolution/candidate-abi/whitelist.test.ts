import { describe, expect, it } from "vitest";
import {
	DEFAULT_CANDIDATE_PATH_WHITELIST,
	validateCandidatePath,
	validateCandidatePaths,
} from "../../../src/evolution/candidate-abi/whitelist.ts";

describe("validateCandidatePath", () => {
	it("accepts a path inside a whitelisted directory", () => {
		const result = validateCandidatePath(
			".pi/candidate-extensions/foo/policy.json",
			DEFAULT_CANDIDATE_PATH_WHITELIST,
		);
		expect(result.ok).toBe(true);
	});

	it("accepts a path inside the second whitelisted directory", () => {
		const result = validateCandidatePath(
			"packages/coding-agent/src/core/extensions/candidate-policies/bar.ts",
			DEFAULT_CANDIDATE_PATH_WHITELIST,
		);
		expect(result.ok).toBe(true);
	});

	it("rejects paths outside the whitelist", () => {
		const result = validateCandidatePath(
			"packages/agent-server/src/evolution/schema.ts",
			DEFAULT_CANDIDATE_PATH_WHITELIST,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("not in any whitelisted directory");
		}
	});

	it("rejects absolute paths", () => {
		const result = validateCandidatePath("/etc/passwd", DEFAULT_CANDIDATE_PATH_WHITELIST);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("absolute paths are not allowed");
		}
	});

	it("rejects parent-directory references", () => {
		const result = validateCandidatePath(".pi/candidate-extensions/../../foo", DEFAULT_CANDIDATE_PATH_WHITELIST);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("parent-directory references are not allowed");
		}
	});

	it("rejects backslash separators", () => {
		const result = validateCandidatePath(".pi\\candidate-extensions\\foo", DEFAULT_CANDIDATE_PATH_WHITELIST);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("backslash separators are not allowed");
		}
	});

	it("does not allow a prefix match to masquerade as a sibling directory", () => {
		const result = validateCandidatePath(".pi/candidate-extensions-extra/evil.ts", DEFAULT_CANDIDATE_PATH_WHITELIST);
		expect(result.ok).toBe(false);
	});
});

describe("validateCandidatePaths", () => {
	it("accepts a list of valid paths", () => {
		const result = validateCandidatePaths(
			[".pi/candidate-extensions/a.json", ".pi/candidate-extensions/b.json"],
			DEFAULT_CANDIDATE_PATH_WHITELIST,
		);
		expect(result.ok).toBe(true);
	});

	it("returns the first failure", () => {
		const result = validateCandidatePaths(
			[".pi/candidate-extensions/a.json", "packages/agent-server/src/evolution/schema.ts"],
			DEFAULT_CANDIDATE_PATH_WHITELIST,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("not in any whitelisted directory");
		}
	});
});
