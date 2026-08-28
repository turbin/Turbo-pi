import type { TaskLevelDetectorSnapshot } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { computeDetectorMetrics } from "../../src/evolution/detector-metrics.ts";
import type { TeacherCorrectionAlignerResult } from "../../src/evolution/teacher-correction-aligner.ts";

function makeSnapshot(recommended: boolean): TaskLevelDetectorSnapshot {
	return {
		version: "v1-rule",
		signals: recommended ? [{ name: "escalationRecommended", confidence: 1, evidenceRefs: ["tool_event:0"] }] : [],
		recommended,
		originalTask: "test task",
		computedAt: 1_700_000_000_000,
	};
}

function makeDlpRejection(): TeacherCorrectionAlignerResult {
	return {
		rejected: true,
		reason: "DLP finding(s): aws_access_key_id",
		findings: [{ pattern: "aws_access_key_id", location: "correction_text" }],
	};
}

function makeOutcomeRejection(): TeacherCorrectionAlignerResult {
	return {
		rejected: true,
		reason: "outcome not improved",
		findings: [],
	};
}

describe("computeDetectorMetrics", () => {
	it("reports perfect recall and zero false positives on a clean separation", () => {
		const samples = [
			{ snapshot: makeSnapshot(true), taskFailed: true },
			{ snapshot: makeSnapshot(true), taskFailed: true },
			{ snapshot: makeSnapshot(false), taskFailed: false },
			{ snapshot: makeSnapshot(false), taskFailed: false },
		];
		const report = computeDetectorMetrics(samples);
		expect(report.recall).toBe(1);
		expect(report.missRate).toBe(0);
		expect(report.falsePositiveRate).toBe(0);
		expect(report.escalationCostCount).toBe(2);
		expect(report.totalTasks).toBe(4);
		expect(report.failedTasks).toBe(2);
		expect(report.successfulTasks).toBe(2);
	});

	it("reports a miss when a failed task is not flagged", () => {
		const samples = [{ snapshot: makeSnapshot(false), taskFailed: true }];
		const report = computeDetectorMetrics(samples);
		expect(report.recall).toBe(0);
		expect(report.missRate).toBe(1);
		expect(report.falsePositiveRate).toBe(0);
	});

	it("reports a false positive when a successful task is flagged", () => {
		const samples = [{ snapshot: makeSnapshot(true), taskFailed: false }];
		const report = computeDetectorMetrics(samples);
		expect(report.recall).toBe(0);
		expect(report.missRate).toBe(0);
		expect(report.falsePositiveRate).toBe(1);
	});

	it("returns zero rates for an empty batch", () => {
		const report = computeDetectorMetrics([]);
		expect(report.recall).toBe(0);
		expect(report.falsePositiveRate).toBe(0);
		expect(report.missRate).toBe(0);
		expect(report.escalationCostCount).toBe(0);
		expect(report.totalTasks).toBe(0);
	});

	it("counts DLP-blocked teacher corrections", () => {
		const samples = [
			{ snapshot: makeSnapshot(true), taskFailed: true, teacherResult: makeDlpRejection() },
			{ snapshot: makeSnapshot(true), taskFailed: true, teacherResult: makeOutcomeRejection() },
			{ snapshot: makeSnapshot(false), taskFailed: false },
		];
		const report = computeDetectorMetrics(samples);
		expect(report.dlpBlockedCount).toBe(1);
		expect(report.escalationCostCount).toBe(2);
	});

	it("treats rejected results without findings as non-DLP blocks", () => {
		const samples = [
			{ snapshot: makeSnapshot(true), taskFailed: true, teacherResult: makeOutcomeRejection() },
			{ snapshot: makeSnapshot(true), taskFailed: true, teacherResult: { rejected: true } },
		];
		const report = computeDetectorMetrics(samples);
		expect(report.dlpBlockedCount).toBe(0);
	});
});
