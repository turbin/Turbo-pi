import { describe, expect, it } from "vitest";
import { buildEvidenceArtifact, type EvidenceArtifactInput } from "../../src/evolution/evidence-artifact-builder.ts";
import {
	alignTeacherCorrection,
	type TeacherCorrectionAlignerInput,
} from "../../src/evolution/teacher-correction-aligner.ts";

function baseInput(): TeacherCorrectionAlignerInput {
	return {
		taskId: "task-001",
		localRun: { finishReason: "length" },
		cloudRun: { finishReason: "stop", content: "use tabs for indentation" },
		gatewayMarker: {
			gatewaySequence: 7,
			qualitySignalsSha: "a".repeat(64),
		},
	};
}

function baseEvidenceInput(): EvidenceArtifactInput {
	return {
		taskId: "task-001",
		versionContract: {
			artifactId: "b".repeat(64),
			scaffoldHash: "c".repeat(64),
			snapshotSha: "d".repeat(64),
		},
		toolEvents: [],
		productManifest: [],
		graderOutcomes: [],
		userCorrections: [],
		escalationJoinKeys: [],
	};
}

describe("teacher correction aligner", () => {
	it("generates a ref when grader outcome improves and DLP is clean", () => {
		const result = alignTeacherCorrection({
			...baseInput(),
			localOutcome: { outcome: "failure" },
			cloudOutcome: { outcome: "success" },
		});

		expect(result.rejected).toBe(false);
		expect(result.ref).toBeDefined();
		expect(result.ref?.improvement_basis).toBe("grader");
		expect(result.ref?.data_class).toBe("pending_0b");
		expect(result.ref?.retention_policy_ref).toBe("pending_0b");
		expect(result.ref?.dlp_findings).toEqual([]);
	});

	it("blocks and records a rejection reason on a DLP hit", () => {
		const result = alignTeacherCorrection({
			...baseInput(),
			cloudRun: {
				finishReason: "stop",
				content: "my aws key is AKIAIOSFODNN7EXAMPLE",
			},
		});

		expect(result.rejected).toBe(true);
		expect(result.ref).toBeUndefined();
		expect(result.reason).toMatch(/DLP/);
		expect(result.findings?.length).toBeGreaterThan(0);
		expect(result.findings?.some((finding) => finding.pattern === "aws_access_key_id")).toBe(true);
	});

	it("blocks when the outcome is not improved", () => {
		const result = alignTeacherCorrection({
			...baseInput(),
			localRun: { finishReason: "stop" },
			cloudRun: { finishReason: "stop" },
			localOutcome: { outcome: "success" },
			cloudOutcome: { outcome: "failure" },
		});

		expect(result.rejected).toBe(true);
		expect(result.ref).toBeUndefined();
		expect(result.reason).toMatch(/not improved/);
	});

	it("generates a ref when a user correction indicates the escalation was helpful", () => {
		const result = alignTeacherCorrection({
			...baseInput(),
			localRun: { finishReason: "stop" },
			cloudRun: { finishReason: "stop" },
			userCorrection: {
				correctionType: "explicit",
				content: "That was helpful, thanks!",
			},
		});

		expect(result.rejected).toBe(false);
		expect(result.ref).toBeDefined();
		expect(result.ref?.improvement_basis).toBe("user_correction");
		expect(result.ref?.user_correction?.helpful).toBe(true);
	});

	it("uses the finish_reason fallback when grader outcomes are unavailable", () => {
		const result = alignTeacherCorrection({
			...baseInput(),
			localRun: { finishReason: "error" },
			cloudRun: { finishReason: "stop", content: "install the missing dependency" },
		});

		expect(result.rejected).toBe(false);
		expect(result.ref?.improvement_basis).toBe("finish_reason");
	});

	it("embeds the aligned teacher correction ref into the composite evidence artifact", () => {
		const aligned = alignTeacherCorrection({
			...baseInput(),
			localOutcome: { outcome: "failure" },
			cloudOutcome: { outcome: "partial" },
		});
		expect(aligned.ref).toBeDefined();

		const { manifest, blobs } = buildEvidenceArtifact({
			...baseEvidenceInput(),
			teacherCorrectionRef: aligned.ref,
		});

		expect(manifest.evidence_refs).toContain("teacher_correction_refs:1");

		const payload = JSON.parse(blobs[0].toString("utf8")) as Record<string, unknown>;
		expect(payload.teacher_correction_ref).toEqual(aligned.ref);
	});
});
