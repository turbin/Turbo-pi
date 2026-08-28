/**
 * P4-4 shadow evaluation metrics for the frozen task-level detector.
 *
 * Computes recall, false-positive rate, miss rate, escalation cost, and
 * minimal-external-content metrics from a batch of detector snapshots paired
 * with ground-truth task outcomes and teacher-correction alignment results.
 */

import type { TaskLevelDetectorSnapshot } from "@earendil-works/pi-agent-core";
import type { TeacherCorrectionAlignerResult } from "./teacher-correction-aligner.ts";

export interface DetectorMetricsSample {
	snapshot: TaskLevelDetectorSnapshot;
	/** Ground-truth outcome: true when the task ultimately failed. */
	taskFailed: boolean;
	/** Optional teacher-correction alignment result for external-content metrics. */
	teacherResult?: TeacherCorrectionAlignerResult;
}

export interface DetectorMetricsReport {
	/** Fraction of failed tasks where the detector recommended escalation. */
	recall: number;
	/** Fraction of successful tasks where the detector recommended escalation. */
	falsePositiveRate: number;
	/** Fraction of failed tasks where the detector did NOT recommend escalation. */
	missRate: number;
	/** Number of tasks for which escalation was recommended (cost proxy). */
	escalationCostCount: number;
	/** Number of teacher corrections blocked by DLP before backflow. */
	dlpBlockedCount: number;
	/** Total samples in the batch. */
	totalTasks: number;
	/** Number of ground-truth failed tasks. */
	failedTasks: number;
	/** Number of ground-truth successful tasks. */
	successfulTasks: number;
}

function countRecommended(samples: DetectorMetricsSample[]): number {
	return samples.filter((sample) => sample.snapshot.recommended).length;
}

function countDlpBlocked(samples: DetectorMetricsSample[]): number {
	return samples.filter(
		(sample) =>
			sample.teacherResult?.rejected === true &&
			Array.isArray(sample.teacherResult.findings) &&
			sample.teacherResult.findings.length > 0,
	).length;
}

/**
 * Computes shadow evaluation metrics for a frozen detector.
 *
 * The detector is treated as a binary classifier that recommends escalation.
 * Ground-truth failure is provided by the caller (e.g. grader outcome or
 * replay verdict), not by the detector itself.
 */
export function computeDetectorMetrics(samples: DetectorMetricsSample[]): DetectorMetricsReport {
	const totalTasks = samples.length;
	const failed = samples.filter((sample) => sample.taskFailed);
	const successful = samples.filter((sample) => !sample.taskFailed);
	const failedTasks = failed.length;
	const successfulTasks = successful.length;

	const failedWithEscalation = countRecommended(failed);
	const successfulWithEscalation = countRecommended(successful);

	const recall = failedTasks > 0 ? failedWithEscalation / failedTasks : 0;
	const falsePositiveRate = successfulTasks > 0 ? successfulWithEscalation / successfulTasks : 0;
	const missRate = failedTasks > 0 ? (failedTasks - failedWithEscalation) / failedTasks : 0;

	return {
		recall,
		falsePositiveRate,
		missRate,
		escalationCostCount: countRecommended(samples),
		dlpBlockedCount: countDlpBlocked(samples),
		totalTasks,
		failedTasks,
		successfulTasks,
	};
}
