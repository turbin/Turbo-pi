import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Archive } from "../../src/evolution/archive.ts";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { CanaryManager } from "../../src/evolution/canary-manager.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import {
	type ExperimentProgram,
	ExperimentProgramRunner,
	type TrialCandidate,
	type TrialEvaluation,
	type TrialEvaluator,
	validateExperimentProgram,
} from "../../src/evolution/experiment-program.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { checkMeasurementCredibility, gateShadowPromotion } from "../../src/evolution/measurement-gate.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import type { ReplayResult, SnapshotMetrics } from "../../src/evolution/replay-validator.ts";
import type { ScaffoldConfig } from "../../src/evolution/scaffold-config.ts";
import { applyScaffoldOperator } from "../../src/evolution/scaffold-operators.ts";

const SLOT = "scaffold-active";
const FIXED_NOW = 1_700_000_000_000;

function makeSnapshotMetrics(score: number): SnapshotMetrics {
	return {
		entryCount: 3,
		meanQuality: score,
		minQuality: score,
		qualityDistribution: { "0.0-0.2": 0, "0.2-0.4": 0, "0.4-0.6": 0, "0.6-0.8": 0, "0.8-1.0": 3 },
		distinctContentHashes: 3,
	};
}

function makeReplay(
	candidateId: string,
	baselineId: string,
	candidateScore: number,
	baselineScore: number,
): ReplayResult {
	return {
		candidateId,
		baselineId,
		verdict: candidateScore >= baselineScore ? "pass" : "reject",
		timestamp: new Date().toISOString(),
		metrics: {
			candidate: makeSnapshotMetrics(candidateScore),
			baseline: makeSnapshotMetrics(baselineScore),
			contentHashOverlap: 1,
			lostContentHashes: 0,
			meanQualityDelta: candidateScore - baselineScore,
			minQualityDelta: candidateScore - baselineScore,
			invalidEntries: 0,
		},
	};
}

function loadScaffoldConfig(registry: ArtifactRegistry, artifactId: string): ScaffoldConfig {
	const bundle = registry.fetchBundle(artifactId);
	return JSON.parse(bundle.blobs[0].toString("utf8")) as ScaffoldConfig;
}

function buildEvaluator(registry: ArtifactRegistry, baselineId: string): TrialEvaluator {
	return {
		async evaluate(candidate: TrialCandidate): Promise<TrialEvaluation> {
			const baseline = loadScaffoldConfig(registry, baselineId);
			const cfg = loadScaffoldConfig(registry, candidate.artifactId);
			// Simple scaffold scoring: higher retrievalFinalLimit is better.
			const baselineScore = baseline.retrievalFinalLimit / 10;
			const candidateScore = cfg.retrievalFinalLimit / 10;
			return {
				replay: makeReplay(candidate.artifactId, baselineId, candidateScore, baselineScore),
				tokens: 10,
			};
		},
	};
}

describe("P3-T34 Phase 3 end-to-end integration", () => {
	let base: string;
	let registry: ArtifactRegistry;
	let lineage: LineageTracker;
	let controller: PromotionController;
	let manager: CanaryManager;
	let archive: Archive;
	let gen0Id: string;
	let seq: number;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-phase3-e2e-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
		controller = new PromotionController(evo.db, DevAuditWriter.loadOrCreate(join(base, "creds")));
		manager = new CanaryManager();
		archive = new Archive(registry, { champions: 2, steppingStones: 2, specialists: 2 });
		seq = 0;

		const gen0 = applyScaffoldOperator(registry, lineage, { operator: "draft", evidenceRefs: ["gen0"] });
		if (gen0.status !== "generated") throw new Error("gen0 draft failed");
		gen0Id = gen0.artifactId;
	});

	afterEach(() => {
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	function nextSeq(): number {
		return ++seq;
	}

	it("full chain: candidate -> experiment -> gate -> archive -> canary -> active -> rollback to gen0", async () => {
		// 1. Generate a candidate scaffold that improves over gen0.
		const candidate = applyScaffoldOperator(registry, lineage, {
			operator: "improve",
			parentArtifactIds: [gen0Id],
			evidenceRefs: ["cluster-p3"],
		});
		expect(candidate.status).toBe("generated");
		const candidateCfg = loadScaffoldConfig(registry, candidate.artifactId);
		const gen0Cfg = loadScaffoldConfig(registry, gen0Id);
		expect(candidateCfg.retrievalFinalLimit).toBeGreaterThan(gen0Cfg.retrievalFinalLimit);

		// 2. Run a bounded ExperimentProgram that evaluates the candidate.
		const programInput: ExperimentProgram = {
			programId: "p3-scaffold-search",
			baselineArtifactId: gen0Id,
			scope: ["scaffold/config"],
			evaluatorSha: "eval-p3-deterministic",
			hypothesis: "increasing retrievalFinalLimit improves outcomes",
			primaryMetric: "meanQualityDelta",
			hardGuardrails: ["no_regression"],
			budget: { maxTrials: 5, maxConsecutiveCrashes: 1, tokenCap: 100, wallTimeCapMs: 60_000 },
			stoppingRules: { plateauThreshold: 0, plateauWindow: 3 },
		};
		const validation = validateExperimentProgram(programInput);
		expect(validation.ok).toBe(true);
		if (!validation.ok) return;

		const runner = new ExperimentProgramRunner();
		const evaluator = buildEvaluator(registry, gen0Id);
		const trial = await runner.runTrial(
			validation.program,
			{ candidateId: candidate.candidateId, artifactId: candidate.artifactId },
			evaluator,
		);

		expect(trial.verdict).toBe("pass");
		expect(trial.metrics.meanQualityDelta).toBeGreaterThan(0);

		// 3. Measurement credibility gate (post-D E0/E1 simplified stand-in).
		const replayResult: ReplayResult = {
			candidateId: candidate.artifactId,
			baselineId: gen0Id,
			verdict: trial.verdict as "pass" | "reject" | "inconclusive",
			timestamp: new Date().toISOString(),
			metrics: trial.metrics,
		};
		const credibility = checkMeasurementCredibility({
			replayResult,
			baselineId: gen0Id,
			candidateId: candidate.artifactId,
		});
		expect(credibility.trusted).toBe(true);
		expect(gateShadowPromotion(replayResult, gen0Id, candidate.artifactId)).toBe(true);

		// 4. Archive the evaluated candidate.
		archive.add(candidate.artifactId, { score: trial.metrics.meanQualityDelta ?? 0, domain: "retrieval" });
		expect(archive.getChampions().some((e) => e.artifactId === candidate.artifactId)).toBe(true);
		expect(archive.getSteppingStones().length).toBeGreaterThanOrEqual(0);

		// 5. Promote through shadow -> canary_pending_approval -> canary -> active_pending_approval -> active.
		controller.emitDeploymentEvent({
			seq: nextSeq(),
			slot: SLOT,
			eventType: "shadow",
			artifactId: candidate.artifactId,
			operator: "experiment-runner",
			reason: "candidate passed gate",
			occurredAt: FIXED_NOW,
		});

		const pending = manager.requestCanary(controller, {
			seq: nextSeq(),
			slot: SLOT,
			artifactId: candidate.artifactId,
			approver: "human-a",
			reason: "request canary",
			occurredAt: FIXED_NOW + 1,
		});
		expect(pending.slotState.eventType).toBe("canary_pending_approval");

		const canary = manager.approveCanary(controller, {
			seq: nextSeq(),
			slot: SLOT,
			artifactId: candidate.artifactId,
			approver: "human-a",
			reason: "approve canary",
			occurredAt: FIXED_NOW + 2,
		});
		expect(canary.slotState.eventType).toBe("canary");

		const activePending = manager.requestActive(controller, {
			seq: nextSeq(),
			slot: SLOT,
			artifactId: candidate.artifactId,
			approver: "human-b",
			reason: "request active",
			occurredAt: FIXED_NOW + 3,
		});
		expect(activePending.slotState.eventType).toBe("active_pending_approval");

		const active = manager.approveActive(controller, {
			seq: nextSeq(),
			slot: SLOT,
			artifactId: candidate.artifactId,
			approver: "human-b",
			reason: "approve active",
			occurredAt: FIXED_NOW + 4,
		});
		expect(active.slotState.eventType).toBe("active");

		// 6. Rollback drill: one-click return to generation 0.
		const rollback = manager.rollback(controller, {
			seq: nextSeq(),
			slot: SLOT,
			targetArtifactId: gen0Id,
			approver: "human-c",
			reason: "rollback drill to gen0",
			occurredAt: FIXED_NOW + 5,
		});
		expect(rollback.slotState.eventType).toBe("rollback");

		const finalRow = controller.db
			.prepare("SELECT artifact_id FROM deployment_event_stream WHERE slot = ? ORDER BY seq DESC LIMIT 1")
			.get(SLOT) as { artifact_id: string };
		expect(finalRow.artifact_id).toBe(gen0Id);

		// 7. Lineage records the candidate -> gen0 derivation.
		const parents = lineage.getParents(candidate.artifactId);
		expect(parents.some((e) => e.parentId === gen0Id && e.operator === "improve")).toBe(true);
	});
});
