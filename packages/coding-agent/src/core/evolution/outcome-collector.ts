/**
 * Grader outcome and user correction collector for the Phase 1 evidence plane.
 *
 * Records grader verdicts (with grader identity) and user corrections against
 * tasks so later phases can join them with gateway and trajectory evidence.
 * The collector is dependency-free, in-memory, and validates every record at
 * the field level before accepting it.
 */

/** Outcome enum values accepted from the grader. */
export const GRADER_OUTCOMES = ["success", "partial", "failure", "aborted"] as const;
export type GraderOutcomeKind = (typeof GRADER_OUTCOMES)[number];

/** User correction classification. */
export const CORRECTION_TYPES = ["explicit", "implicit"] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export interface GraderOutcome {
	/** Task identifier the grade applies to. */
	taskId: string;
	/** Grader verdict for the task. */
	outcome: GraderOutcomeKind;
	/** 64-char lowercase sha256 hex identifying the grader revision. */
	graderSha: string;
	/** Optional score in [0, 1]. */
	score?: number;
	/** Optional free-form grader notes. */
	notes?: string;
	/** ISO 8601 timestamp of the grade. */
	timestamp: string;
}

export interface UserCorrection {
	/** Task identifier the correction applies to. */
	taskId: string;
	/** Whether the user stated the correction directly or it was inferred. */
	correctionType: CorrectionType;
	/** Correction content. */
	content: string;
	/** ISO 8601 timestamp of the correction. */
	timestamp: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function requireEnumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function validateGraderOutcome(outcome: GraderOutcome): void {
	requireNonEmptyString(outcome.taskId, "taskId");
	requireEnumValue(outcome.outcome, GRADER_OUTCOMES, "outcome");
	requireNonEmptyString(outcome.graderSha, "graderSha");
	if (outcome.score !== undefined) {
		if (typeof outcome.score !== "number" || Number.isNaN(outcome.score) || outcome.score < 0 || outcome.score > 1) {
			throw new Error("score must be a number in [0, 1]");
		}
	}
	if (outcome.notes !== undefined && typeof outcome.notes !== "string") {
		throw new Error("notes must be a string when provided");
	}
	requireNonEmptyString(outcome.timestamp, "timestamp");
}

function validateUserCorrection(correction: UserCorrection): void {
	requireNonEmptyString(correction.taskId, "taskId");
	requireEnumValue(correction.correctionType, CORRECTION_TYPES, "correctionType");
	requireNonEmptyString(correction.content, "content");
	requireNonEmptyString(correction.timestamp, "timestamp");
}

export class OutcomeCollector {
	private outcomes: GraderOutcome[] = [];
	private corrections: UserCorrection[] = [];

	recordGraderOutcome(outcome: GraderOutcome): void {
		validateGraderOutcome(outcome);
		this.outcomes.push(outcome);
	}

	recordUserCorrection(correction: UserCorrection): void {
		validateUserCorrection(correction);
		this.corrections.push(correction);
	}

	getOutcomes(): GraderOutcome[] {
		return [...this.outcomes];
	}

	getCorrections(): UserCorrection[] {
		return [...this.corrections];
	}
}

/** Creates a fresh, independent OutcomeCollector. */
export function createOutcomeCollector(): OutcomeCollector {
	return new OutcomeCollector();
}
