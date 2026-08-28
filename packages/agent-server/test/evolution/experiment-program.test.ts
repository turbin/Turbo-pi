import { describe, expect, it } from "vitest";
import {
	type ExperimentProgram,
	ExperimentProgramRunner,
	type TrialCandidate,
	type TrialEvaluation,
	type TrialEvaluator,
	validateExperimentProgram,
} from "../../src/evolution/experiment-program.ts";
import type { ReplayResult } from "../../src/evolution/replay-validator.ts";

function makeProgram(overrides: Partial<ExperimentProgram> = {}): ExperimentProgram {
	return {
		programId: "prog-1",
		baselineArtifactId: "base-1",
		scope: ["scaffold/config"],
		evaluatorSha: "eval-1",
		hypothesis: "improve retrievalFinalLimit helps",
		primaryMetric: "meanQualityDelta",
		hardGuardrails: ["no_regression"],
		budget: {
			maxTrials: 10,
			maxConsecutiveCrashes: 2,
			tokenCap: 1000,
			wallTimeCapMs: 60_000,
		},
		stoppingRules: {
			plateauThreshold: 0,
			plateauWindow: 3,
		},
		...overrides,
	};
}

function makeReplay(verdict: ReplayResult["verdict"], delta: number): ReplayResult {
	return {
		candidateId: "cand-1",
		baselineId: "base-1",
		verdict,
		timestamp: new Date().toISOString(),
		metrics: {
			candidate: {
				entryCount: 3,
				meanQuality: 0.5 + delta,
				minQuality: 0.4,
				qualityDistribution: {},
				distinctContentHashes: 3,
			},
			baseline: {
				entryCount: 3,
				meanQuality: 0.5,
				minQuality: 0.4,
				qualityDistribution: {},
				distinctContentHashes: 3,
			},
			contentHashOverlap: 1,
			lostContentHashes: 0,
			meanQualityDelta: delta,
			minQualityDelta: 0,
			invalidEntries: 0,
		},
	};
}

function makeEvaluator(replies: TrialEvaluation[]): TrialEvaluator {
	let index = 0;
	return {
		async evaluate(): Promise<TrialEvaluation> {
			const reply = replies[index % replies.length];
			index++;
			return reply;
		},
	};
}

function makeCandidate(id = "cand-1", artifactId = "art-1"): TrialCandidate {
	return { candidateId: id, artifactId };
}

describe("P3-T31 ExperimentProgram and trial loop", () => {
	it("validates a well-formed program", () => {
		const result = validateExperimentProgram(makeProgram());
		expect(result.ok).toBe(true);
	});

	it("rejects invalid programs", () => {
		const result = validateExperimentProgram({
			...makeProgram(),
			budget: { maxTrials: 0, maxConsecutiveCrashes: -1, tokenCap: -1, wallTimeCapMs: -1 },
			stoppingRules: { plateauThreshold: -1, plateauWindow: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reasons.length).toBeGreaterThan(0);
			expect(result.reasons.some((r) => r.includes("maxTrials"))).toBe(true);
			expect(result.reasons.some((r) => r.includes("plateauWindow"))).toBe(true);
		}
	});

	it("runs a trial and records it in the ledger", async () => {
		const program = makeProgram();
		const evaluator = makeEvaluator([{ replay: makeReplay("pass", 0.1), tokens: 10 }]);
		const runner = new ExperimentProgramRunner();

		const result = await runner.runTrial(program, makeCandidate(), evaluator);
		expect(result.verdict).toBe("pass");
		expect(result.tokens).toBe(10);
		expect(result.trialId).toMatch(/^trial-[0-9a-f]{24}$/);
		expect(runner.getTrialLedger()).toHaveLength(1);
	});

	it("stops after maxTrials", async () => {
		const program = makeProgram({ budget: { ...makeProgram().budget, maxTrials: 2 } });
		const evaluator = makeEvaluator([{ replay: makeReplay("pass", 0.1), tokens: 1 }]);
		const runner = new ExperimentProgramRunner();

		await runner.runTrial(program, makeCandidate(), evaluator);
		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(true);
	});

	it("stops after consecutive crashes", async () => {
		const program = makeProgram({ budget: { ...makeProgram().budget, maxConsecutiveCrashes: 2 } });
		const evaluator: TrialEvaluator = {
			async evaluate(): Promise<TrialEvaluation> {
				throw new Error("boom");
			},
		};
		const runner = new ExperimentProgramRunner();

		await runner.runTrial(program, makeCandidate(), evaluator);
		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(true);
	});

	it("stops on plateau", async () => {
		const program = makeProgram({
			stoppingRules: { plateauThreshold: 0, plateauWindow: 3 },
		});
		const evaluator = makeEvaluator([
			{ replay: makeReplay("pass", 0.1), tokens: 1 },
			{ replay: makeReplay("pass", 0.1), tokens: 1 },
			{ replay: makeReplay("pass", 0.1), tokens: 1 },
			{ replay: makeReplay("pass", 0.1), tokens: 1 },
		]);
		const runner = new ExperimentProgramRunner();

		await runner.runTrial(program, makeCandidate(), evaluator);
		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(false);
		await runner.runTrial(program, makeCandidate(), evaluator);
		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(true);
	});

	it("stops when token budget is exceeded", async () => {
		const program = makeProgram({ budget: { ...makeProgram().budget, tokenCap: 5 } });
		const evaluator = makeEvaluator([{ replay: makeReplay("pass", 0.1), tokens: 3 }]);
		const runner = new ExperimentProgramRunner();

		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(false);
		await runner.runTrial(program, makeCandidate(), evaluator);
		expect(runner.shouldStop(program, runner.getTrialLedger())).toBe(true);
	});

	it("frontier contains only passing trials sorted by primary metric", () => {
		const program = makeProgram();
		const runner = new ExperimentProgramRunner();

		// Seed ledger directly to avoid timing coupling.
		const ledger = [
			{ verdict: "pass", metrics: makeReplay("pass", 0.2).metrics },
			{ verdict: "reject", metrics: makeReplay("reject", 0.5).metrics },
			{ verdict: "pass", metrics: makeReplay("pass", 0.4).metrics },
			{ verdict: "inconclusive", metrics: makeReplay("inconclusive", 0).metrics },
		].map((r, i) => ({
			trialId: `trial-${i}`,
			candidateId: "cand",
			artifactId: "art",
			verdict: r.verdict as "pass" | "reject" | "inconclusive" | "crash",
			metrics: r.metrics,
			tokens: 0,
			wallTimeMs: 0,
			timestamp: new Date().toISOString(),
		}));

		const frontier = runner.getProvisionalFrontier(program, ledger);
		expect(frontier).toHaveLength(2);
		expect(frontier[0].metrics.meanQualityDelta).toBe(0.4);
		expect(frontier[1].metrics.meanQualityDelta).toBe(0.2);
	});
});
