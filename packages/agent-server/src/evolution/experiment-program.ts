/**
 * P3-T31: autoresearch-style ExperimentProgram and bounded trial loop.
 *
 * A program fixes the baseline, the single mutable scope, the evaluator SHA,
 * the hypothesis, the primary metric, hard guardrails, and a rigid budget.
 * The runner executes one trial at a time, records every outcome (including
 * crashes) to an append-only ledger, and exposes stop rules and a provisional
 * frontier.
 */

import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { ReplayMetrics, ReplayResult, ReplayVerdict } from "./replay-validator.ts";

export interface ExperimentProgramBudget {
	/** Maximum number of trials in this program. */
	maxTrials: number;
	/** Stop after this many consecutive crashes. */
	maxConsecutiveCrashes: number;
	/** Cumulative token budget (sum across trials). */
	tokenCap: number;
	/** Wall-time budget in milliseconds. */
	wallTimeCapMs: number;
}

export interface ExperimentProgramStoppingRules {
	/** Minimum absolute improvement required to reset the plateau timer. */
	plateauThreshold: number;
	/** Number of trials without improvement that trigger a plateau stop. */
	plateauWindow: number;
}

export interface ExperimentProgram {
	programId: string;
	/** Baseline artifact id that every trial is measured against. */
	baselineArtifactId: string;
	/** Mutable scope (file/field whitelist) for this program. */
	scope: string[];
	/** SHA256 of the immutable evaluator contract. */
	evaluatorSha: string;
	/** Human-readable hypothesis under test. */
	hypothesis: string;
	/** Name of the primary metric extracted from ReplayMetrics. */
	primaryMetric: string;
	/** List of hard guardrail names (e.g. "no_regression", "cost_cap"). */
	hardGuardrails: string[];
	budget: ExperimentProgramBudget;
	stoppingRules: ExperimentProgramStoppingRules;
}

export interface TrialCandidate {
	candidateId: string;
	artifactId: string;
}

export interface TrialResult {
	trialId: string;
	candidateId: string;
	artifactId: string;
	/** Verdict from the evaluator, or "crash" if evaluation threw. */
	verdict: ReplayVerdict | "crash";
	metrics: ReplayMetrics;
	/** Tokens consumed by this trial. */
	tokens: number;
	/** Wall time spent in this trial (ms). */
	wallTimeMs: number;
	timestamp: string;
}

export interface TrialEvaluation {
	replay: ReplayResult;
	tokens: number;
}

export interface TrialEvaluator {
	evaluate(candidate: TrialCandidate, program: ExperimentProgram): Promise<TrialEvaluation>;
}

export interface ProgramValidation {
	ok: true;
	program: ExperimentProgram;
}

export interface ProgramValidationFailure {
	ok: false;
	reasons: string[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate a program before it is admitted to the trial loop. */
export function validateExperimentProgram(input: unknown): ProgramValidation | ProgramValidationFailure {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, reasons: ["program must be an object"] };
	}
	const p = input as Partial<ExperimentProgram>;
	const reasons: string[] = [];

	if (!isNonEmptyString(p.programId)) reasons.push("programId is required");
	if (!isNonEmptyString(p.baselineArtifactId)) reasons.push("baselineArtifactId is required");
	if (!Array.isArray(p.scope) || p.scope.length === 0 || !p.scope.every(isNonEmptyString)) {
		reasons.push("scope must be a non-empty array of strings");
	}
	if (!isNonEmptyString(p.evaluatorSha)) reasons.push("evaluatorSha is required");
	if (!isNonEmptyString(p.hypothesis)) reasons.push("hypothesis is required");
	if (!isNonEmptyString(p.primaryMetric)) reasons.push("primaryMetric is required");
	if (!Array.isArray(p.hardGuardrails)) reasons.push("hardGuardrails must be an array");

	if (typeof p.budget !== "object" || p.budget === null) {
		reasons.push("budget must be an object");
	} else {
		if (!isPositiveInteger(p.budget.maxTrials)) reasons.push("budget.maxTrials must be a positive integer");
		if (!isNonNegativeNumber(p.budget.maxConsecutiveCrashes)) {
			reasons.push("budget.maxConsecutiveCrashes must be a non-negative integer");
		}
		if (!isNonNegativeNumber(p.budget.tokenCap)) reasons.push("budget.tokenCap must be non-negative");
		if (!isNonNegativeNumber(p.budget.wallTimeCapMs)) reasons.push("budget.wallTimeCapMs must be non-negative");
	}

	if (typeof p.stoppingRules !== "object" || p.stoppingRules === null) {
		reasons.push("stoppingRules must be an object");
	} else {
		if (!isNonNegativeNumber(p.stoppingRules.plateauThreshold)) {
			reasons.push("stoppingRules.plateauThreshold must be non-negative");
		}
		if (!isPositiveInteger(p.stoppingRules.plateauWindow)) {
			reasons.push("stoppingRules.plateauWindow must be a positive integer");
		}
	}

	if (reasons.length > 0) {
		return { ok: false, reasons };
	}
	return { ok: true, program: p as ExperimentProgram };
}

function computeTrialId(programId: string, candidateId: string, index: number, now: number): string {
	return `trial-${sha256Hex(canonicalJson([programId, candidateId, index, now])).slice(0, 24)}`;
}

function getMetric(metrics: ReplayMetrics, name: string): number {
	switch (name) {
		case "meanQuality":
			return metrics.candidate?.meanQuality ?? Number.NEGATIVE_INFINITY;
		case "minQuality":
			return metrics.candidate?.minQuality ?? Number.NEGATIVE_INFINITY;
		case "meanQualityDelta":
			return metrics.meanQualityDelta ?? Number.NEGATIVE_INFINITY;
		case "minQualityDelta":
			return metrics.minQualityDelta ?? Number.NEGATIVE_INFINITY;
		case "contentHashOverlap":
			return metrics.contentHashOverlap ?? Number.NEGATIVE_INFINITY;
		default:
			return Number.NEGATIVE_INFINITY;
	}
}

function makeCrashMetrics(): ReplayMetrics {
	return {
		candidate: null,
		baseline: null,
		contentHashOverlap: null,
		lostContentHashes: null,
		meanQualityDelta: null,
		minQualityDelta: null,
		invalidEntries: 0,
	};
}

export class ExperimentProgramRunner {
	private readonly ledger: TrialResult[] = [];
	private readonly programStartMs: number;

	constructor() {
		this.programStartMs = Date.now();
	}

	/** Append-only trial ledger; every runTrial result is recorded here. */
	getTrialLedger(): readonly TrialResult[] {
		return this.ledger;
	}

	/**
	 * Run one trial against the fixed evaluator.
	 *
	 * The outcome is always appended to the ledger. A thrown evaluator is
	 * recorded as a "crash" so the stop rules can react to it.
	 */
	async runTrial(
		program: ExperimentProgram,
		candidate: TrialCandidate,
		evaluator: TrialEvaluator,
	): Promise<TrialResult> {
		const startMs = Date.now();
		let evaluation: TrialEvaluation;
		try {
			evaluation = await evaluator.evaluate(candidate, program);
		} catch {
			const result: TrialResult = {
				trialId: computeTrialId(program.programId, candidate.candidateId, this.ledger.length, startMs),
				candidateId: candidate.candidateId,
				artifactId: candidate.artifactId,
				verdict: "crash",
				metrics: makeCrashMetrics(),
				tokens: 0,
				wallTimeMs: Date.now() - startMs,
				timestamp: new Date(startMs).toISOString(),
			};
			this.ledger.push(result);
			return result;
		}

		const result: TrialResult = {
			trialId: computeTrialId(program.programId, candidate.candidateId, this.ledger.length, startMs),
			candidateId: candidate.candidateId,
			artifactId: candidate.artifactId,
			verdict: evaluation.replay.verdict,
			metrics: evaluation.replay.metrics,
			tokens: evaluation.tokens,
			wallTimeMs: Date.now() - startMs,
			timestamp: evaluation.replay.timestamp,
		};
		this.ledger.push(result);
		return result;
	}

	/** Decide whether the program should stop before launching another trial. */
	shouldStop(program: ExperimentProgram, results: readonly TrialResult[]): boolean {
		if (results.length >= program.budget.maxTrials) {
			return true;
		}

		const crashes = results.filter((r) => r.verdict === "crash").length;
		if (crashes >= program.budget.maxConsecutiveCrashes && program.budget.maxConsecutiveCrashes > 0) {
			return true;
		}
		// Only consecutive crashes count for the crash stop rule.
		let consecutiveCrashes = 0;
		for (let i = results.length - 1; i >= 0; i--) {
			if (results[i].verdict === "crash") {
				consecutiveCrashes++;
			} else {
				break;
			}
		}
		if (consecutiveCrashes >= program.budget.maxConsecutiveCrashes && program.budget.maxConsecutiveCrashes > 0) {
			return true;
		}

		const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
		if (totalTokens >= program.budget.tokenCap && program.budget.tokenCap > 0) {
			return true;
		}

		const elapsedMs = Date.now() - this.programStartMs;
		if (elapsedMs >= program.budget.wallTimeCapMs && program.budget.wallTimeCapMs > 0) {
			return true;
		}

		return this.detectPlateau(program, results);
	}

	/**
	 * Return the current provisional frontier: passing trials sorted by primary
	 * metric descending. These are candidates for further selection, not
	 * promoted versions.
	 */
	getProvisionalFrontier(program: ExperimentProgram, results: readonly TrialResult[]): TrialResult[] {
		const passing = results.filter((r) => r.verdict === "pass");
		return passing
			.slice()
			.sort((a, b) => getMetric(b.metrics, program.primaryMetric) - getMetric(a.metrics, program.primaryMetric));
	}

	private detectPlateau(program: ExperimentProgram, results: readonly TrialResult[]): boolean {
		const window = program.stoppingRules.plateauWindow;
		if (results.length < window) {
			return false;
		}
		// Best metric value seen before the trailing window.
		const prior = results.slice(0, results.length - window);
		const bestPrior =
			prior.length > 0
				? Math.max(...prior.map((r) => getMetric(r.metrics, program.primaryMetric)))
				: Number.NEGATIVE_INFINITY;
		// Trailing window must not improve on the prior best by more than the threshold.
		const trailing = results.slice(results.length - window);
		return trailing.every(
			(r) => getMetric(r.metrics, program.primaryMetric) <= bestPrior + program.stoppingRules.plateauThreshold,
		);
	}
}
