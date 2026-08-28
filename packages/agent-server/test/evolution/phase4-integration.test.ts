import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	computeTaskLevelDetectorSnapshot,
	type TaskLevelDetectorSnapshot,
	type TaskLevelDetectorToolEvent,
} from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { computeArtifactId } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import {
	buildEvidenceArtifact,
	type EvidenceArtifactInput,
	storeEvidenceArtifact,
} from "../../src/evolution/evidence-artifact-builder.ts";
import { alignTeacherCorrection } from "../../src/evolution/teacher-correction-aligner.ts";

const FIXED_NOW = 1_700_000_000_000;
const SHA_A = "a".repeat(64);

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeFailedToolEvents(): TaskLevelDetectorToolEvent[] {
	return [
		{ toolName: "read_file", argsHash: sha256Hex("args-1"), resultHash: sha256Hex("err-1"), error: "ENOENT" },
		{ toolName: "read_file", argsHash: sha256Hex("args-1"), resultHash: sha256Hex("err-2"), error: "EACCES" },
	];
}

function makeDetectorSnapshot(): TaskLevelDetectorSnapshot {
	const turn = {
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: "I cannot read the file." }],
		} as unknown as AgentMessage,
	};
	return computeTaskLevelDetectorSnapshot({
		originalTask: "read the config file",
		turns: [turn],
		toolEvents: makeFailedToolEvents(),
		scaffold: {
			taskLevelDetectorVersion: "v1-rule",
			repeatedFailureThreshold: 2,
			escalationConfidenceThreshold: 0.5,
		},
	});
}

function makeEvidenceArtifactInput(detectorSnapshot: TaskLevelDetectorSnapshot): EvidenceArtifactInput {
	const gatewayMarker = { gatewaySequence: 3, qualitySignalsSha: SHA_A };
	const aligned = alignTeacherCorrection({
		taskId: "p4-task-001",
		localRun: { finishReason: "error" },
		cloudRun: { finishReason: "stop", content: "Use a relative path and retry." },
		gatewayMarker,
		localOutcome: { outcome: "failure" },
		cloudOutcome: { outcome: "success" },
	});
	if (aligned.rejected || aligned.ref === undefined) {
		throw new Error("expected aligned teacher correction ref");
	}

	return {
		taskId: "p4-task-001",
		versionContract: {
			artifactId: SHA_A,
			scaffoldHash: "b".repeat(64),
			snapshotSha: "c".repeat(64),
		},
		toolEvents: [
			{
				toolName: "read_file",
				argsHash: sha256Hex("args-1"),
				resultHash: sha256Hex("err-1"),
				durationMs: 12,
				error: "ENOENT",
				timestamp: FIXED_NOW,
			},
			{
				toolName: "read_file",
				argsHash: sha256Hex("args-1"),
				resultHash: sha256Hex("err-2"),
				durationMs: 15,
				error: "EACCES",
				timestamp: FIXED_NOW + 1,
			},
		],
		productManifest: [],
		graderOutcomes: [
			{
				taskId: "p4-task-001",
				outcome: "failure",
				graderSha: "d".repeat(64),
				timestamp: new Date(FIXED_NOW).toISOString(),
			},
		],
		userCorrections: [],
		escalationJoinKeys: [gatewayMarker],
		detectorSnapshot,
		teacherCorrectionRef: aligned.ref,
	};
}

describe("P4-T40 Phase 4 end-to-end integration", () => {
	let baseDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "evo-phase4-e2e-"));
		const db = openEvolutionDb(join(baseDir, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(baseDir, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("full pipeline: detector -> gateway escalation -> teacher correction -> evidence artifact", () => {
		// 1. Local run with repeated tool failure; detector signals repeatedToolFailure and escalationRecommended.
		const detectorSnapshot = makeDetectorSnapshot();
		expect(detectorSnapshot.recommended).toBe(true);
		expect(detectorSnapshot.signals.some((signal) => signal.name === "repeatedToolFailure")).toBe(true);
		expect(detectorSnapshot.signals.some((signal) => signal.name === "escalationRecommended")).toBe(true);

		// 2. Gateway escalation produces a cloud-teacher corrected response.
		// 3. Teacher correction aligner decides outcome improved and DLP clean -> teacher_correction ref.
		const input = makeEvidenceArtifactInput(detectorSnapshot);
		expect(input.teacherCorrectionRef).toBeDefined();
		expect(input.teacherCorrectionRef?.dlp_findings).toEqual([]);
		expect(input.teacherCorrectionRef?.improvement_basis).toBe("grader");

		// 4. Composite evidence artifact contains detector snapshot, tool events, escalation join key, and teacher correction ref.
		const { manifest, blobs } = buildEvidenceArtifact(input);

		expect(manifest.kind).toBe("composite");
		expect(manifest.evidence_refs).toContain("task:p4-task-001");
		expect(manifest.evidence_refs).toContain("tool_events:2");
		expect(manifest.evidence_refs).toContain("escalation_join_keys:1");
		expect(manifest.evidence_refs).toContain("teacher_correction_refs:1");
		expect(manifest.evidence_refs.some((ref) => ref.startsWith("detector_signals:"))).toBe(true);
		expect(manifest.blob_hashes).toHaveLength(2);

		const evidence = JSON.parse(blobs[0].toString("utf8")) as Record<string, unknown>;
		expect(evidence.task_id).toBe("p4-task-001");
		expect(evidence.tool_events).toHaveLength(2);
		expect(evidence.escalation_join_keys).toEqual(input.escalationJoinKeys);
		expect(evidence.detector_snapshot).toEqual(detectorSnapshot);
		expect(evidence.teacher_correction_ref).toEqual(input.teacherCorrectionRef);

		// 5. Artifact is content-addressed and can be rebuilt deterministically.
		const rebuilt = buildEvidenceArtifact(input);
		expect(rebuilt.manifest).toEqual(manifest);
		expect(rebuilt.blobs).toHaveLength(blobs.length);
		for (let i = 0; i < blobs.length; i++) {
			expect(rebuilt.blobs[i].equals(blobs[i])).toBe(true);
		}
		expect(computeArtifactId(rebuilt.manifest)).toBe(computeArtifactId(manifest));

		// 6. Artifact can be stored and fetched from the registry intact.
		const stored = storeEvidenceArtifact(registry, input);
		expect(stored.artifactId).toBe(computeArtifactId(stored.manifest));
		const loaded = registry.fetchBundle(stored.artifactId);
		expect(loaded.manifest).toEqual(stored.manifest);
		expect(loaded.blobs).toHaveLength(stored.blobs.length);
		for (let i = 0; i < stored.blobs.length; i++) {
			expect(loaded.blobs[i].equals(stored.blobs[i])).toBe(true);
		}
	});

	it("teacher correction is rejected when DLP finds sensitive content", () => {
		const gatewayMarker = { gatewaySequence: 4, qualitySignalsSha: SHA_A };

		const aligned = alignTeacherCorrection({
			taskId: "p4-task-002",
			localRun: { finishReason: "error" },
			cloudRun: { finishReason: "stop", content: "my aws key is AKIAIOSFODNN7EXAMPLE" },
			gatewayMarker,
			localOutcome: { outcome: "failure" },
			cloudOutcome: { outcome: "success" },
		});

		expect(aligned.rejected).toBe(true);
		expect(aligned.ref).toBeUndefined();
		expect(aligned.reason).toMatch(/DLP/);
		expect(aligned.findings?.length).toBeGreaterThan(0);
	});
});
