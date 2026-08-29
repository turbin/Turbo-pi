import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { CanaryManager } from "../../src/evolution/canary-manager.ts";
import { CANDIDATE_ABI_VERSION } from "../../src/evolution/candidate-abi/manifest.ts";
import {
	type buildSourcePatchArtifact,
	storeSourcePatchArtifact,
} from "../../src/evolution/candidate-abi/source-patch-builder.ts";
import type { CandidateEvaluationReport } from "../../src/evolution/candidate-isolation-runner.ts";
import { CandidatePromoter, CandidateReviewGateError } from "../../src/evolution/candidate-promoter.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";

function makeReport(overrides: Partial<CandidateEvaluationReport> = {}): CandidateEvaluationReport {
	return {
		sourcePatchArtifactId: overrides.sourcePatchArtifactId ?? "art-1",
		worktreeRoot: "/tmp/wt",
		candidateManifest: {
			abiVersion: CANDIDATE_ABI_VERSION,
			name: "test-candidate",
			description: "test",
			generatedFrom: { taskId: "t1", clusterId: "c1", evidenceArtifactId: "ev-1" },
			capabilities: ["declarative/system-guideline"],
			declarations: { systemGuidelines: ["g1"] },
		},
		appliedFiles: [".pi/candidate-extensions/c1/policy.json"],
		validationCommand: ["true"],
		validationResult: { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 },
		passed: true,
		...overrides,
	};
}

function makePatchInput(): Parameters<typeof buildSourcePatchArtifact>[0] {
	return {
		candidateManifest: {
			abiVersion: CANDIDATE_ABI_VERSION,
			name: "test-candidate",
			description: "test",
			generatedFrom: { taskId: "t1", clusterId: "c1", evidenceArtifactId: "ev-1" },
			capabilities: ["declarative/system-guideline"],
			declarations: { systemGuidelines: ["g1"] },
		},
		diff: `--- /dev/null\n+++ .pi/candidate-extensions/c1/policy.json\n@@ -0,0 +1 @@\n+{"systemGuidelines":["g1"]}\n`,
		parentIds: [],
		evidenceRefs: [],
		scaffoldHash: createHash("sha256").update("scaffold").digest("hex"),
		modelFingerprint: JSON.stringify({ model: "test" }),
	};
}

describe("CandidatePromoter", () => {
	let base: string;
	let promoter: CandidatePromoter;
	let controller: PromotionController;
	let registry: ReturnType<typeof openArtifactRegistry>;
	let artifactId: string;
	let report: CandidateEvaluationReport;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "candidate-promo-"));
		const db = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(base, "blobs"));
		const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(db.db, auditWriter);
		promoter = new CandidatePromoter({ controller, canaryManager: new CanaryManager() });

		artifactId = storeSourcePatchArtifact(registry, makePatchInput()).artifactId;
		report = makeReport({ sourcePatchArtifactId: artifactId });
	});

	afterEach(() => {
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("moves a candidate through shadow -> canary_pending -> canary -> active", () => {
		promoter.shadow({ artifactId, slot: "slot-a", seq: 1, operator: "generator", reason: "initial shadow" });
		promoter.requestCanary(
			{ artifactId, slot: "slot-a", seq: 2, operator: "reviewer", reason: "request canary" },
			report,
		);
		promoter.approveCanary({ artifactId, slot: "slot-a", seq: 3, operator: "human", reason: "approve canary" });
		promoter.requestActive({ artifactId, slot: "slot-a", seq: 4, operator: "reviewer", reason: "request active" });
		promoter.approveActive({ artifactId, slot: "slot-a", seq: 5, operator: "human", reason: "approve active" });

		expect(controller.resolveSlotState("slot-a").eventType).toBe("active");
	});

	it("rejects canary request when evaluation did not pass", () => {
		promoter.shadow({ artifactId, slot: "slot-b", seq: 1, operator: "generator", reason: "shadow" });
		const failingReport = makeReport({ sourcePatchArtifactId: artifactId, passed: false });
		expect(() =>
			promoter.requestCanary(
				{ artifactId, slot: "slot-b", seq: 2, operator: "reviewer", reason: "request canary" },
				failingReport,
			),
		).toThrow(CandidateReviewGateError);
	});

	it("supports reject and quarantine", () => {
		promoter.shadow({ artifactId, slot: "slot-c", seq: 1, operator: "generator", reason: "shadow" });
		promoter.reject({ artifactId, slot: "slot-c", seq: 2, operator: "human", reason: "unsafe" });
		expect(controller.resolveSlotState("slot-c").eventType).toBe("reject");
	});

	it("supports rollback to a previous artifact", () => {
		promoter.shadow({ artifactId, slot: "slot-d", seq: 1, operator: "generator", reason: "shadow" });
		promoter.requestCanary(
			{ artifactId, slot: "slot-d", seq: 2, operator: "reviewer", reason: "request canary" },
			report,
		);
		promoter.approveCanary({ artifactId, slot: "slot-d", seq: 3, operator: "human", reason: "approve canary" });
		promoter.rollback({
			artifactId,
			targetArtifactId: artifactId,
			slot: "slot-d",
			seq: 4,
			operator: "human",
			reason: "rollback",
		});
		expect(controller.resolveSlotState("slot-d").eventType).toBe("rollback");
	});

	it("builds a review bundle from the artifact and report", () => {
		const bundle = promoter.buildReviewBundle(artifactId, registry, report);
		expect(bundle.artifactId).toBe(artifactId);
		expect(bundle.passed).toBe(true);
		expect(bundle.diff).toContain(".pi/candidate-extensions/c1/policy.json");
	});
});
