import { describe, expect, it } from "vitest";
import { validateEscalationJoinKey, validateRecordEvidence } from "../../src/evolution/evidence-schema.ts";
import { FAILURE_TAXONOMY } from "../../src/evolution/taxonomy.ts";

function validInput() {
	return {
		taskId: "task-1",
		traceId: "trace-1",
		artifactRefs: ["artifact-1"],
		toolEvents: [
			{
				toolName: "read_file",
				canonicalRequestHash: "0".repeat(64),
				outcome: "ok" as const,
			},
		],
		tokens: 100,
		costMicros: 50,
		outcome: "success" as const,
		productManifest: {
			blobHashes: ["1".repeat(64)],
			description: "a product",
		},
		escalationJoinKey: {
			gatewaySequence: 42,
			qualitySignalsSha: "2".repeat(64),
		},
		failureClassification: "unknown" as const,
	};
}

describe("evidence schema", () => {
	it("accepts a valid recordEvidence input", () => {
		const result = validateRecordEvidence(validInput());
		expect(result.ok).toBe(true);
	});

	it("rejects missing required fields with field-level errors", () => {
		for (const key of [
			"taskId",
			"traceId",
			"artifactRefs",
			"toolEvents",
			"tokens",
			"costMicros",
			"outcome",
		] as const) {
			const bad = { ...validInput() } as Record<string, unknown>;
			delete bad[key];
			const result = validateRecordEvidence(bad);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errors.some((e) => e.includes(key))).toBe(true);
		}
	});

	it("rejects non-hex canonicalRequestHash in toolEvents", () => {
		const bad = validInput();
		bad.toolEvents = [{ toolName: "x", canonicalRequestHash: "not-hex", outcome: "ok" }];
		const result = validateRecordEvidence(bad);
		expect(result.ok).toBe(false);
	});

	it("rejects negative tokens or cost", () => {
		let bad = { ...validInput(), tokens: -1 };
		expect(validateRecordEvidence(bad).ok).toBe(false);
		bad = { ...validInput(), costMicros: -1 };
		expect(validateRecordEvidence(bad).ok).toBe(false);
	});

	it("rejects invalid outcome enum", () => {
		const bad = { ...validInput(), outcome: "weird" };
		const result = validateRecordEvidence(bad);
		expect(result.ok).toBe(false);
	});

	it("taxonomy includes the V3 §8.1 classes plus unknown", () => {
		expect(FAILURE_TAXONOMY).toEqual([
			"environment",
			"model",
			"scaffold",
			"retrieval",
			"experience_content",
			"delivery",
			"judge",
			"unknown",
		]);
	});

	it("rejects invalid failure classification", () => {
		const bad = { ...validInput(), failureClassification: "not-a-class" };
		const result = validateRecordEvidence(bad);
		expect(result.ok).toBe(false);
	});

	it("productManifest blobHashes must be sha256 hex", () => {
		const bad = { ...validInput(), productManifest: { blobHashes: ["short"], description: "x" } };
		const result = validateRecordEvidence(bad);
		expect(result.ok).toBe(false);
	});

	it("escalationJoinKey requires integer gatewaySequence and sha256 qualitySignalsSha", () => {
		expect(validateEscalationJoinKey({ gatewaySequence: 1, qualitySignalsSha: "0".repeat(64) }).ok).toBe(true);
		expect(validateEscalationJoinKey({ gatewaySequence: -1, qualitySignalsSha: "0".repeat(64) }).ok).toBe(false);
		expect(validateEscalationJoinKey({ gatewaySequence: 1, qualitySignalsSha: "short" }).ok).toBe(false);
	});

	it("allows optional productManifest and escalationJoinKey to be omitted", () => {
		const input = validInput();
		delete (input as Record<string, unknown>).productManifest;
		delete (input as Record<string, unknown>).escalationJoinKey;
		const result = validateRecordEvidence(input);
		expect(result.ok).toBe(true);
	});
});
