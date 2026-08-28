/**
 * P4-3: cloud teacher correction backflow alignment.
 *
 * Decides whether a gateway escalation (cloud teacher) produced a genuine
 * improvement over the local student run, applies DLP/de-identification to the
 * correction text, and emits a `teacher_correction` evidence ref when the
 * correction is safe and aligned.
 */

import type { DlpFinding } from "./dlp-scan.ts";
import { scanText } from "./dlp-scan.ts";
import type { EscalationJoinKey } from "./evidence-schema.ts";

export type GraderOutcomeKind = "success" | "partial" | "failure" | "aborted";

const OUTCOME_RANK: Record<GraderOutcomeKind, number> = {
	success: 3,
	partial: 2,
	failure: 1,
	aborted: 0,
};

const POSITIVE_CORRECTION_MARKERS = ["helpful", "better", "fixed", "correct", "good", "thanks", "works", "resolved"];
const NEGATIVE_CORRECTION_MARKERS = [
	"not helpful",
	"not useful",
	"worse",
	"bad",
	"still wrong",
	"did not help",
	"didn't help",
	"useless",
];

export interface ModelRun {
	/** Provider finish_reason for the run (e.g. "stop", "length", "error"). */
	finishReason: string;
	/** Final assistant content, when available. */
	content?: string;
}

export interface TeacherCorrectionAlignerInput {
	taskId: string;
	localRun: ModelRun;
	cloudRun: ModelRun;
	gatewayMarker: EscalationJoinKey;
	/** Optional grader outcome for the local run. */
	localOutcome?: { outcome: GraderOutcomeKind };
	/** Optional grader outcome for the cloud teacher run. */
	cloudOutcome?: { outcome: GraderOutcomeKind };
	/** Optional user correction that may indicate escalation helpfulness. */
	userCorrection?: { correctionType: string; content: string };
}

export interface TeacherCorrectionRef {
	kind: "teacher_correction";
	data_class: "pending_0b";
	retention_policy_ref: "pending_0b";
	task_id: string;
	gateway_marker: EscalationJoinKey;
	local_finish_reason: string;
	cloud_finish_reason: string;
	local_outcome?: GraderOutcomeKind;
	cloud_outcome?: GraderOutcomeKind;
	user_correction?: { correction_type: string; content: string; helpful: boolean };
	/** Correction text that was DLP-scanned before backflow. */
	correction_text: string;
	improvement_basis: "grader" | "finish_reason" | "user_correction";
	/** Empty when the scan is clean; used for audit. */
	dlp_findings: DlpFinding[];
	aligned_at: number;
}

export interface TeacherCorrectionAlignerResult {
	ref?: TeacherCorrectionRef;
	rejected: boolean;
	reason?: string;
	findings?: DlpFinding[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidOutcomeKind(value: unknown): value is GraderOutcomeKind {
	return isNonEmptyString(value) && Object.keys(OUTCOME_RANK).includes(value);
}

function isValidGatewayMarker(value: unknown): value is EscalationJoinKey {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Partial<EscalationJoinKey>;
	return (
		typeof record.gatewaySequence === "number" &&
		Number.isInteger(record.gatewaySequence) &&
		record.gatewaySequence >= 0 &&
		isNonEmptyString(record.qualitySignalsSha) &&
		/^[0-9a-f]{64}$/.test(record.qualitySignalsSha)
	);
}

function isValidModelRun(value: unknown): value is ModelRun {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const run = value as Partial<ModelRun>;
	return isNonEmptyString(run.finishReason) && (run.content === undefined || typeof run.content === "string");
}

function validateInput(input: TeacherCorrectionAlignerInput): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return "expected an object";
	}
	if (!isNonEmptyString(input.taskId)) {
		return "taskId: expected non-empty string";
	}
	if (!isValidModelRun(input.localRun)) {
		return "localRun: expected object with non-empty finishReason";
	}
	if (!isValidModelRun(input.cloudRun)) {
		return "cloudRun: expected object with non-empty finishReason";
	}
	if (!isValidGatewayMarker(input.gatewayMarker)) {
		return "gatewayMarker: expected EscalationJoinKey with non-negative integer gatewaySequence and 64-char hex qualitySignalsSha";
	}
	if (input.localOutcome !== undefined && !isValidOutcomeKind(input.localOutcome.outcome)) {
		return "localOutcome.outcome: expected one of success, partial, failure, aborted";
	}
	if (input.cloudOutcome !== undefined && !isValidOutcomeKind(input.cloudOutcome.outcome)) {
		return "cloudOutcome.outcome: expected one of success, partial, failure, aborted";
	}
	if (input.userCorrection !== undefined) {
		if (!isNonEmptyString(input.userCorrection.correctionType)) {
			return "userCorrection.correctionType: expected non-empty string";
		}
		if (!isNonEmptyString(input.userCorrection.content)) {
			return "userCorrection.content: expected non-empty string";
		}
	}
	return undefined;
}

function outcomeRank(outcome: GraderOutcomeKind | undefined): number | undefined {
	return outcome === undefined ? undefined : OUTCOME_RANK[outcome];
}

function isHelpfulCorrection(content: string): boolean {
	const lower = content.toLowerCase();
	if (NEGATIVE_CORRECTION_MARKERS.some((marker) => lower.includes(marker))) {
		return false;
	}
	return POSITIVE_CORRECTION_MARKERS.some((marker) => lower.includes(marker));
}

function determineImprovementBasis(
	input: TeacherCorrectionAlignerInput,
): { basis: "grader" | "finish_reason" | "user_correction" } | { reason: string } {
	const localRank = outcomeRank(input.localOutcome?.outcome);
	const cloudRank = outcomeRank(input.cloudOutcome?.outcome);

	if (localRank !== undefined && cloudRank !== undefined) {
		if (cloudRank > localRank) {
			return { basis: "grader" };
		}
		return {
			reason: `grader outcome not improved (${input.localOutcome?.outcome} -> ${input.cloudOutcome?.outcome})`,
		};
	}

	const localReason = input.localRun.finishReason;
	const cloudReason = input.cloudRun.finishReason;
	if ((localReason === "length" || localReason === "error") && cloudReason === "stop") {
		return { basis: "finish_reason" };
	}

	if (input.userCorrection !== undefined && isHelpfulCorrection(input.userCorrection.content)) {
		return { basis: "user_correction" };
	}

	return { reason: "outcome not improved" };
}

/**
 * Aligns a cloud teacher correction against the local run.
 *
 * Returns a `teacher_correction` evidence ref when:
 *   - the input is valid,
 *   - the correction text passes the DLP scan,
 *   - the cloud result is an improvement by grader, finish_reason, or user
 *     correction signal.
 *
 * Otherwise returns a rejection reason (DLP hit, outcome not improved, etc.).
 */
export function alignTeacherCorrection(input: TeacherCorrectionAlignerInput): TeacherCorrectionAlignerResult {
	const validationError = validateInput(input);
	if (validationError !== undefined) {
		return { rejected: true, reason: `invalid input: ${validationError}` };
	}

	const correctionText = input.cloudRun.content ?? input.userCorrection?.content ?? "";
	const findings: DlpFinding[] = [];
	findings.push(...scanText(correctionText, "correction_text"));
	if (input.userCorrection !== undefined) {
		findings.push(...scanText(input.userCorrection.content, "user_correction.content"));
	}

	if (findings.length > 0) {
		const patternNames = findings.map((finding) => finding.pattern).join(", ");
		return {
			rejected: true,
			reason: `DLP finding(s): ${patternNames}`,
			findings,
		};
	}

	const improvement = determineImprovementBasis(input);
	if ("reason" in improvement) {
		return { rejected: true, reason: improvement.reason, findings: [] };
	}

	const userHelpful =
		input.userCorrection !== undefined ? isHelpfulCorrection(input.userCorrection.content) : undefined;

	const ref: TeacherCorrectionRef = {
		kind: "teacher_correction",
		data_class: "pending_0b",
		retention_policy_ref: "pending_0b",
		task_id: input.taskId,
		gateway_marker: input.gatewayMarker,
		local_finish_reason: input.localRun.finishReason,
		cloud_finish_reason: input.cloudRun.finishReason,
		local_outcome: input.localOutcome?.outcome,
		cloud_outcome: input.cloudOutcome?.outcome,
		user_correction:
			input.userCorrection !== undefined
				? {
						correction_type: input.userCorrection.correctionType,
						content: input.userCorrection.content,
						helpful: userHelpful ?? false,
					}
				: undefined,
		correction_text: correctionText,
		improvement_basis: improvement.basis,
		dlp_findings: [],
		aligned_at: Date.now(),
	};

	return { ref, rejected: false };
}
