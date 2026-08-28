import { describe, expect, it } from "vitest";
import {
	createOutcomeCollector,
	type GraderOutcome,
	OutcomeCollector,
	type UserCorrection,
} from "../../../src/core/evolution/outcome-collector.ts";

function validOutcome(overrides: Partial<GraderOutcome> = {}): GraderOutcome {
	return {
		taskId: "task-1",
		outcome: "success",
		graderSha: "a".repeat(64),
		timestamp: "2026-08-28T10:00:00.000Z",
		...overrides,
	};
}

function validCorrection(overrides: Partial<UserCorrection> = {}): UserCorrection {
	return {
		taskId: "task-1",
		correctionType: "explicit",
		content: "use tabs, not spaces",
		timestamp: "2026-08-28T10:01:00.000Z",
		...overrides,
	};
}

describe("OutcomeCollector grader outcomes", () => {
	it("records and retrieves grader outcomes in order", () => {
		const collector = new OutcomeCollector();
		const first = validOutcome();
		const second = validOutcome({ taskId: "task-2", outcome: "partial", score: 0.5 });
		collector.recordGraderOutcome(first);
		collector.recordGraderOutcome(second);
		expect(collector.getOutcomes()).toEqual([first, second]);
	});

	it("accepts all valid outcome enum values", () => {
		const collector = new OutcomeCollector();
		for (const outcome of ["success", "partial", "failure", "aborted"] as const) {
			collector.recordGraderOutcome(validOutcome({ outcome }));
		}
		expect(collector.getOutcomes().map((o) => o.outcome)).toEqual(["success", "partial", "failure", "aborted"]);
	});

	it("rejects a missing taskId", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordGraderOutcome(validOutcome({ taskId: "" }))).toThrow(/taskId/);
		expect(() => collector.recordGraderOutcome(validOutcome({ taskId: undefined as unknown as string }))).toThrow(
			/taskId/,
		);
		expect(collector.getOutcomes()).toHaveLength(0);
	});

	it("rejects an invalid outcome enum value", () => {
		const collector = new OutcomeCollector();
		expect(() =>
			collector.recordGraderOutcome(validOutcome({ outcome: "ok" as unknown as GraderOutcome["outcome"] })),
		).toThrow(/outcome/);
		expect(collector.getOutcomes()).toHaveLength(0);
	});

	it("rejects a missing graderSha", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordGraderOutcome(validOutcome({ graderSha: "" }))).toThrow(/graderSha/);
	});

	it("rejects a missing timestamp", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordGraderOutcome(validOutcome({ timestamp: "" }))).toThrow(/timestamp/);
	});

	it("rejects an out-of-range score", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordGraderOutcome(validOutcome({ score: -0.1 }))).toThrow(/score/);
		expect(() => collector.recordGraderOutcome(validOutcome({ score: 1.1 }))).toThrow(/score/);
		expect(() => collector.recordGraderOutcome(validOutcome({ score: Number.NaN }))).toThrow(/score/);
	});
});

describe("OutcomeCollector user corrections", () => {
	it("records and retrieves user corrections in order", () => {
		const collector = new OutcomeCollector();
		const first = validCorrection();
		const second = validCorrection({ correctionType: "implicit", content: "user re-ran the command" });
		collector.recordUserCorrection(first);
		collector.recordUserCorrection(second);
		expect(collector.getCorrections()).toEqual([first, second]);
	});

	it("rejects a missing taskId", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordUserCorrection(validCorrection({ taskId: "" }))).toThrow(/taskId/);
		expect(collector.getCorrections()).toHaveLength(0);
	});

	it("rejects an invalid correctionType enum value", () => {
		const collector = new OutcomeCollector();
		expect(() =>
			collector.recordUserCorrection(
				validCorrection({ correctionType: "subtle" as unknown as UserCorrection["correctionType"] }),
			),
		).toThrow(/correctionType/);
	});

	it("rejects empty content and missing timestamp", () => {
		const collector = new OutcomeCollector();
		expect(() => collector.recordUserCorrection(validCorrection({ content: "" }))).toThrow(/content/);
		expect(() => collector.recordUserCorrection(validCorrection({ timestamp: "" }))).toThrow(/timestamp/);
	});
});

describe("createOutcomeCollector", () => {
	it("returns an independent OutcomeCollector instance", () => {
		const a = createOutcomeCollector();
		const b = createOutcomeCollector();
		expect(a).toBeInstanceOf(OutcomeCollector);
		a.recordGraderOutcome(validOutcome());
		expect(a.getOutcomes()).toHaveLength(1);
		expect(b.getOutcomes()).toHaveLength(0);
		expect(b.getCorrections()).toHaveLength(0);
	});
});
