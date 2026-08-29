import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskLevelDetectorSnapshot } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { CanaryManager } from "../../src/evolution/canary-manager.ts";
import {
	type CandidateEvaluationReport,
	evaluateCandidate,
	LocalSubprocessRunner,
} from "../../src/evolution/candidate-isolation-runner.ts";
import { CandidatePromoter } from "../../src/evolution/candidate-promoter.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { buildEvidenceArtifact } from "../../src/evolution/evidence-artifact-builder.ts";
import type { EscalationJoinKey } from "../../src/evolution/evidence-schema.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import { generateSourceCandidate } from "../../src/evolution/source-candidate-generator.ts";

function makeSnapshot(signal: string): TaskLevelDetectorSnapshot {
	return {
		version: "v1-rule",
		signals: [
			{
				name: signal as TaskLevelDetectorSnapshot["signals"][0]["name"],
				confidence: 1,
				evidenceRefs: ["tool_event:0"],
			},
		],
		recommended: signal === "escalationRecommended",
		originalTask: "test",
		computedAt: 1_700_000_000_000,
	};
}

function seedEvidenceArtifact(
	registry: ReturnType<typeof openArtifactRegistry>,
	options: {
		taskId: string;
		signal: string;
		toolName?: string;
		error?: string;
		escalationJoinKeys?: EscalationJoinKey[];
	},
): string {
	const built = buildEvidenceArtifact({
		taskId: options.taskId,
		versionContract: {
			artifactId: `contract-${options.taskId}`,
			scaffoldHash: "a".repeat(64),
			snapshotSha: `snapshot-${options.taskId}`,
		},
		toolEvents: options.toolName
			? [
					{
						toolName: options.toolName,
						argsHash: "hash1",
						resultHash: "hash2",
						durationMs: 10,
						error: options.error,
						timestamp: 1,
					},
				]
			: [],
		productManifest: [],
		graderOutcomes: [
			{ taskId: options.taskId, outcome: "failure", graderSha: "g1", timestamp: new Date().toISOString() },
		],
		userCorrections: [],
		escalationJoinKeys: options.escalationJoinKeys ?? [],
		detectorSnapshot: makeSnapshot(options.signal),
	});
	return registry.storeArtifact(built.manifest, built.blobs);
}

describe("Phase 5 end-to-end integration", () => {
	let base: string;
	let registry: ReturnType<typeof openArtifactRegistry>;
	let lineage: LineageTracker;
	let promoter: CandidatePromoter;
	let controller: PromotionController;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "phase5-e2e-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
		const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(evo.db, auditWriter);
		promoter = new CandidatePromoter({ controller, canaryManager: new CanaryManager() });
	});

	afterEach(() => {
		registry.close();
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("goes from failure cluster -> candidate -> evaluation -> canary -> active", async () => {
		seedEvidenceArtifact(registry, {
			taskId: "t1",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});
		seedEvidenceArtifact(registry, {
			taskId: "t2",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});

		const generated = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "phase5-e2e" }),
		});
		expect(generated.status).toBe("generated");

		const worktree = mkdtempSync(join(tmpdir(), "phase5-wt-"));
		let report: CandidateEvaluationReport;
		try {
			report = await evaluateCandidate({
				sourcePatchArtifactId: generated.artifactId!,
				registry,
				worktreeRoot: worktree,
				validationCommand: ["node", "-e", "console.log('candidate ok')"],
				execRunner: new LocalSubprocessRunner(),
			});
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
		expect(report.passed).toBe(true);
		expect(report.appliedFiles.length).toBeGreaterThan(0);

		const slot = "phase5-slot";
		promoter.shadow({
			artifactId: generated.artifactId!,
			slot,
			seq: 1,
			operator: "generator",
			reason: "initial shadow",
		});
		promoter.requestCanary(
			{ artifactId: generated.artifactId!, slot, seq: 2, operator: "reviewer", reason: "request canary" },
			report,
		);
		promoter.approveCanary({
			artifactId: generated.artifactId!,
			slot,
			seq: 3,
			operator: "human",
			reason: "approve canary",
		});
		promoter.requestActive({
			artifactId: generated.artifactId!,
			slot,
			seq: 4,
			operator: "reviewer",
			reason: "request active",
		});
		promoter.approveActive({
			artifactId: generated.artifactId!,
			slot,
			seq: 5,
			operator: "human",
			reason: "approve active",
		});

		expect(controller.resolveSlotState(slot).eventType).toBe("active");

		const reviewBundle = promoter.buildReviewBundle(generated.artifactId!, registry, report);
		expect(reviewBundle.passed).toBe(true);
		expect(reviewBundle.appliedFiles).toEqual(report.appliedFiles);
	});

	it("rolls back an active candidate to the original artifact", async () => {
		seedEvidenceArtifact(registry, { taskId: "t3", signal: "deliveryMissing" });
		seedEvidenceArtifact(registry, { taskId: "t4", signal: "deliveryMissing" });

		const generated = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "phase5-e2e" }),
		});
		expect(generated.status).toBe("generated");

		const worktree = mkdtempSync(join(tmpdir(), "phase5-wt-"));
		let report: CandidateEvaluationReport;
		try {
			report = await evaluateCandidate({
				sourcePatchArtifactId: generated.artifactId!,
				registry,
				worktreeRoot: worktree,
				validationCommand: ["node", "-e", "console.log('candidate ok')"],
				execRunner: new LocalSubprocessRunner(),
			});
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}

		const slot = "phase5-rollback-slot";
		promoter.shadow({ artifactId: generated.artifactId!, slot, seq: 1, operator: "generator", reason: "shadow" });
		promoter.requestCanary(
			{ artifactId: generated.artifactId!, slot, seq: 2, operator: "reviewer", reason: "request canary" },
			report,
		);
		promoter.approveCanary({
			artifactId: generated.artifactId!,
			slot,
			seq: 3,
			operator: "human",
			reason: "approve canary",
		});
		promoter.requestActive({
			artifactId: generated.artifactId!,
			slot,
			seq: 4,
			operator: "reviewer",
			reason: "request active",
		});
		promoter.approveActive({
			artifactId: generated.artifactId!,
			slot,
			seq: 5,
			operator: "human",
			reason: "approve active",
		});

		// Roll back to the candidate artifact itself as the "known-good" baseline.
		promoter.rollback({
			artifactId: generated.artifactId!,
			targetArtifactId: generated.artifactId!,
			slot,
			seq: 6,
			operator: "human",
			reason: "rollback drill",
		});

		expect(controller.resolveSlotState(slot).eventType).toBe("rollback");
	});
});
