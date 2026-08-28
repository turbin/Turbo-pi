import type { ReplayMetrics, ReplayResult, SnapshotMetrics } from "./replay-validator.ts";

/**
 * P2-T27: post-D E0/E1 measurement credibility gate.
 *
 * Before a replayed candidate is allowed into shadow promotion, the
 * measurement that produced its replay verdict must itself be credible.
 * This module is the simplified Phase-2 stand-in for the full E0/E1
 * machinery of the post-D adversarial experiment redesign
 * (doc/design/plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md):
 *
 *   E0 (measurement-system / arm-equivalence audit, simplified here):
 *     - workspace tree hash consistency   -> replay result must reference the
 *       exact candidate/baseline artifacts under evaluation (id consistency);
 *     - canonical request hash presence   -> required metrics fields must be
 *       present (a missing profile means the measurement was not recorded);
 *     - trace completeness                -> snapshot metrics for both arms
 *       must be structurally complete (finite counts, distribution present).
 *
 *   E1 (injection-path / dose validity, simplified here):
 *     - measurement environment reproducibility -> timestamp must be a valid
 *       ISO instant within the last 24h (stale or future results are not
 *       reproducible evidence);
 *     - no unexpected drift                 -> candidate and baseline must be
 *       distinct artifacts (comparing an arm to itself is not a measurement);
 *     - budget compliance                   -> no structurally invalid entries
 *       may be present in the measured metrics.
 *
 * Any failed check makes the measurement untrusted; `gateShadowPromotion`
 * additionally requires the replay verdict itself to be "pass".
 */

export interface MeasurementGateInput {
	replayResult: ReplayResult;
	baselineId: string;
	candidateId: string;
}

export interface MeasurementGateResult {
	trusted: boolean;
	reasons: string[];
}

export interface MeasurementGateOptions {
	/** Fixed ISO timestamp for deterministic evaluation. Defaults to current time. */
	now?: string;
}

/** Maximum age of a replay result before its measurement is considered stale. */
export const MAX_MEASUREMENT_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerance for clock skew when a result claims to be from the future. */
const FUTURE_SKEW_MS = 60 * 1000;

function checkSnapshotMetrics(label: string, metrics: SnapshotMetrics | null, reasons: string[]): void {
	if (!metrics) {
		reasons.push(`E0: missing ${label} snapshot metrics (canonical measurement not recorded)`);
		return;
	}
	if (!Number.isInteger(metrics.entryCount) || metrics.entryCount < 0) {
		reasons.push(`E0: ${label} metrics entryCount is missing or invalid`);
	}
	if (metrics.meanQuality !== null && !Number.isFinite(metrics.meanQuality)) {
		reasons.push(`E0: ${label} metrics meanQuality is not finite`);
	}
	if (metrics.minQuality !== null && !Number.isFinite(metrics.minQuality)) {
		reasons.push(`E0: ${label} metrics minQuality is not finite`);
	}
	if (typeof metrics.qualityDistribution !== "object" || metrics.qualityDistribution === null) {
		reasons.push(`E0: ${label} metrics qualityDistribution is missing`);
	} else {
		for (const [bucket, count] of Object.entries(metrics.qualityDistribution)) {
			if (!Number.isInteger(count) || count < 0) {
				reasons.push(`E0: ${label} metrics qualityDistribution bucket "${bucket}" is invalid`);
			}
		}
	}
	if (!Number.isInteger(metrics.distinctContentHashes) || metrics.distinctContentHashes < 0) {
		reasons.push(`E0: ${label} metrics distinctContentHashes is missing or invalid`);
	}
}

/** E0 (simplified): id consistency, required metrics fields, trace completeness. */
function checkE0(input: MeasurementGateInput, reasons: string[]): void {
	const { replayResult, baselineId, candidateId } = input;
	if (replayResult.candidateId !== candidateId) {
		reasons.push("E0: replay result candidateId does not match the candidate under evaluation");
	}
	if (replayResult.baselineId !== baselineId) {
		reasons.push("E0: replay result baselineId does not match the baseline under evaluation");
	}
	if (!replayResult.metrics || typeof replayResult.metrics !== "object") {
		reasons.push("E0: replay result carries no metrics object");
		return;
	}
	checkSnapshotMetrics("candidate", replayResult.metrics.candidate, reasons);
	checkSnapshotMetrics("baseline", replayResult.metrics.baseline, reasons);
}

/** E1 (simplified): environment reproducibility, no self-comparison drift, budget compliance. */
function checkE1(input: MeasurementGateInput, nowMs: number, reasons: string[]): void {
	const { replayResult, baselineId, candidateId } = input;
	if (candidateId === baselineId) {
		reasons.push("E1: candidate and baseline are the same artifact (no measurable contrast)");
	}
	const metrics: ReplayMetrics | null = replayResult.metrics ?? null;
	if (metrics) {
		if (!Number.isInteger(metrics.invalidEntries) || metrics.invalidEntries < 0) {
			reasons.push("E1: metrics invalidEntries counter is missing or invalid");
		} else if (metrics.invalidEntries > 0) {
			reasons.push(`E1: metrics contain ${metrics.invalidEntries} invalid entries (budget compliance failure)`);
		}
	}
	const timestampMs = Date.parse(replayResult.timestamp);
	if (Number.isNaN(timestampMs)) {
		reasons.push("E1: replay result timestamp is not a valid ISO instant");
		return;
	}
	if (timestampMs > nowMs + FUTURE_SKEW_MS) {
		reasons.push("E1: replay result timestamp is in the future (environment not reproducible)");
	} else if (nowMs - timestampMs > MAX_MEASUREMENT_AGE_MS) {
		reasons.push("E1: replay result is older than 24 hours (stale measurement)");
	}
}

/**
 * Evaluate whether the measurement behind a replay result is credible.
 * Pure function of the input; never throws.
 */
export function checkMeasurementCredibility(
	input: MeasurementGateInput,
	options: MeasurementGateOptions = {},
): MeasurementGateResult {
	const reasons: string[] = [];
	const nowMs = Date.parse(options.now ?? new Date().toISOString());
	checkE0(input, reasons);
	checkE1(input, nowMs, reasons);
	return { trusted: reasons.length === 0, reasons };
}

/**
 * Shadow-promotion gate: a candidate may enter shadow only when the replay
 * verdict is "pass" AND the measurement behind it is trusted.
 */
export function gateShadowPromotion(
	replayResult: ReplayResult,
	baselineId: string,
	candidateId: string,
	options: MeasurementGateOptions = {},
): boolean {
	if (replayResult.verdict !== "pass") {
		return false;
	}
	return checkMeasurementCredibility({ replayResult, baselineId, candidateId }, options).trusted;
}
