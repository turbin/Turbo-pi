import { describe, expect, it } from "vitest";
import {
	CANDIDATE_ABI_VERSION,
	CANDIDATE_CAPABILITIES,
	type CandidateExtensionManifest,
	validateCandidateManifest,
} from "../../../src/evolution/candidate-abi/manifest.ts";

function makeManifest(overrides: Partial<CandidateExtensionManifest> = {}): CandidateExtensionManifest {
	return {
		abiVersion: CANDIDATE_ABI_VERSION,
		name: "test-candidate",
		description: "test candidate extension",
		generatedFrom: {
			taskId: "task-1",
			clusterId: "cluster-1",
			evidenceArtifactId: "ev-1",
		},
		capabilities: ["declarative/system-guideline"],
		...overrides,
	};
}

describe("validateCandidateManifest", () => {
	it("accepts a minimal valid declarative manifest", () => {
		const result = validateCandidateManifest(makeManifest());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest.name).toBe("test-candidate");
			expect(result.manifest.capabilities).toEqual(["declarative/system-guideline"]);
		}
	});

	it("accepts all supported capabilities", () => {
		const result = validateCandidateManifest(
			makeManifest({ capabilities: [...CANDIDATE_CAPABILITIES], entry: "transform.js" }),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects an unsupported abi version", () => {
		const result = validateCandidateManifest(makeManifest({ abiVersion: "v0" as typeof CANDIDATE_ABI_VERSION }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain('candidate manifest.abiVersion: must be "candidate-extension-v1"');
		}
	});

	it("rejects missing name", () => {
		const result = validateCandidateManifest(makeManifest({ name: "" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("candidate manifest.name: expected non-empty string");
		}
	});

	it("rejects missing description", () => {
		const result = validateCandidateManifest(makeManifest({ description: undefined as unknown as string }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("candidate manifest.description: expected string");
		}
	});

	it("rejects missing provenance fields", () => {
		const result = validateCandidateManifest(
			makeManifest({ generatedFrom: {} as CandidateExtensionManifest["generatedFrom"] }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("candidate manifest.generatedFrom.taskId: expected non-empty string");
			expect(result.errors).toContain("candidate manifest.generatedFrom.clusterId: expected non-empty string");
			expect(result.errors).toContain(
				"candidate manifest.generatedFrom.evidenceArtifactId: expected non-empty string",
			);
		}
	});

	it("rejects empty capabilities", () => {
		const result = validateCandidateManifest(makeManifest({ capabilities: [] }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("candidate manifest.capabilities: expected non-empty array");
		}
	});

	it("rejects unsupported capabilities", () => {
		const result = validateCandidateManifest(
			makeManifest({ capabilities: ["exec/shell"] } as unknown as CandidateExtensionManifest),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toMatch(/unsupported capability/);
		}
	});

	it("requires entry when a transform capability is declared", () => {
		const result = validateCandidateManifest(makeManifest({ capabilities: ["transform/text"] }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toContain("entry: required non-empty string");
		}
	});

	it("accepts transform capability with an entry", () => {
		const result = validateCandidateManifest(
			makeManifest({ capabilities: ["transform/text"], entry: "transform.js" }),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects unknown top-level fields", () => {
		const result = validateCandidateManifest({
			...makeManifest(),
			extra: true,
		} as unknown as CandidateExtensionManifest);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("candidate manifest.extra: unknown field");
		}
	});

	it("rejects unknown fields in declarations", () => {
		const result = validateCandidateManifest(
			makeManifest({
				declarations: {
					toolPrompts: [
						{ toolName: "read", promptSnippet: "be careful", unknown: true } as unknown as {
							toolName: string;
							promptSnippet: string;
						},
					],
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toContain("unknown field");
		}
	});
});
