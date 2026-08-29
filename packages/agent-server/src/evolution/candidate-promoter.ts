/**
 * P5-4: candidate promotion + human review gate.
 *
 * Wraps the existing promotion state machine (`promotion-controller.ts` +
 * `canary-manager.ts`) with a candidate-specific review gate. A candidate may
 * only advance to `canary_pending_approval` after its isolation-runner
 * evaluation report shows `passed: true`. All transitions are signed and
 * append-only; this module does not auto-approve or auto-merge.
 */

import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { CanaryManager } from "./canary-manager.ts";
import type { CandidateEvaluationReport } from "./candidate-isolation-runner.ts";
import type { PromotionController } from "./promotion-controller.ts";
import type { EventType } from "./schema.ts";

export interface CandidatePromoterDeps {
	controller: PromotionController;
	canaryManager: CanaryManager;
}

export interface PromotionStepInput {
	artifactId: string;
	slot: string;
	seq: number;
	/** Human operator/approver identity. */
	operator: string;
	reason: string;
	occurredAt?: number;
}

export interface CandidateReviewBundle {
	artifactId: string;
	diff: string;
	candidateName: string;
	candidateDescription: string;
	appliedFiles: string[];
	validationCommand: string[];
	passed: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class CandidateReviewGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidateReviewGateError";
	}
}

export interface ReviewGateInput {
	sourcePatchArtifactId: string;
	evaluationReport: CandidateEvaluationReport;
}

/**
 * Fail-closed review gate: only passing evaluations with applied files may be
 * presented for human canary approval.
 */
export function assertCandidateReviewable(input: ReviewGateInput): void {
	if (input.evaluationReport.sourcePatchArtifactId !== input.sourcePatchArtifactId) {
		throw new CandidateReviewGateError("evaluation report does not match source patch artifact");
	}
	if (!input.evaluationReport.passed) {
		throw new CandidateReviewGateError("candidate evaluation did not pass");
	}
	if (input.evaluationReport.appliedFiles.length === 0) {
		throw new CandidateReviewGateError("candidate did not apply any files");
	}
}

function toCanaryInput(input: PromotionStepInput) {
	return {
		seq: input.seq,
		slot: input.slot,
		artifactId: input.artifactId,
		approver: input.operator,
		reason: input.reason,
		occurredAt: input.occurredAt,
	};
}

/**
 * Candidate promotion orchestrator.
 *
 * All methods return the emitted deployment event id. The caller (human or
 * higher-level automation) is responsible for presenting the review bundle and
 * obtaining approval before `approveCanary` / `approveActive`.
 */
export class CandidatePromoter {
	private readonly controller: PromotionController;
	private readonly canaryManager: CanaryManager;

	constructor(deps: CandidatePromoterDeps) {
		this.controller = deps.controller;
		this.canaryManager = deps.canaryManager;
	}

	/** Emit `shadow` for a freshly generated/evaluated candidate. */
	shadow(input: PromotionStepInput): string {
		const current = this.controller.resolveSlotState(input.slot);
		return this.controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "shadow",
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.operator,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
	}

	/**
	 * Request canary review. Requires a passing evaluation report; otherwise the
	 * review gate throws before any deployment event is emitted.
	 */
	requestCanary(input: PromotionStepInput, report: CandidateEvaluationReport): string {
		assertCandidateReviewable({ sourcePatchArtifactId: input.artifactId, evaluationReport: report });
		const result = this.canaryManager.requestCanary(this.controller, toCanaryInput(input));
		return result.eventId;
	}

	approveCanary(input: PromotionStepInput): string {
		const result = this.canaryManager.approveCanary(this.controller, toCanaryInput(input));
		return result.eventId;
	}

	requestActive(input: PromotionStepInput): string {
		const result = this.canaryManager.requestActive(this.controller, toCanaryInput(input));
		return result.eventId;
	}

	approveActive(input: PromotionStepInput): string {
		const result = this.canaryManager.approveActive(this.controller, toCanaryInput(input));
		return result.eventId;
	}

	private emitTerminal(input: PromotionStepInput, eventType: EventType): string {
		const current = this.controller.resolveSlotState(input.slot);
		return this.controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType,
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.operator,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
	}

	reject(input: PromotionStepInput): string {
		return this.emitTerminal(input, "reject");
	}

	quarantine(input: PromotionStepInput): string {
		return this.emitTerminal(input, "quarantine");
	}

	rollback(input: PromotionStepInput & { targetArtifactId: string }): string {
		return this.canaryManager.rollback(this.controller, {
			seq: input.seq,
			slot: input.slot,
			targetArtifactId: input.targetArtifactId,
			approver: input.operator,
			reason: input.reason,
			occurredAt: input.occurredAt,
		}).eventId;
	}

	/**
	 * Builds a human-readable review bundle from the stored source_patch artifact
	 * and the isolation-runner evaluation report.
	 */
	buildReviewBundle(
		artifactId: string,
		registry: ArtifactRegistry,
		report: CandidateEvaluationReport,
	): CandidateReviewBundle {
		const bundle = registry.fetchBundle(artifactId);
		return {
			artifactId,
			diff: bundle.blobs[0].toString("utf8"),
			candidateName: report.candidateManifest.name,
			candidateDescription: report.candidateManifest.description,
			appliedFiles: report.appliedFiles,
			validationCommand: report.validationCommand,
			passed: report.passed,
			stdout: report.validationResult.stdout,
			stderr: report.validationResult.stderr,
			exitCode: report.validationResult.exitCode,
		};
	}
}
