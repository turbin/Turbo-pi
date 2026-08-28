import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import {
	type CandidateGenerationResult,
	generateExperienceCandidate,
} from "../../src/evolution/candidate-generator.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { buildExperienceSnapshot, type ExperienceSnapshot } from "../../src/evolution/experience-snapshot-builder.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { checkMeasurementCredibility, gateShadowPromotion } from "../../src/evolution/measurement-gate.ts";
import { PromotionController, type SlotState } from "../../src/evolution/promotion-controller.ts";
import { type ReplayResult, replayCandidate } from "../../src/evolution/replay-validator.ts";
import { promoteToShadow } from "../../src/evolution/shadow-promoter.ts";
import { ExperienceStore } from "../../src/experience-store.ts";
import type { Experience } from "../../src/types.ts";

/**
 * P2-T28: Phase 2 end-to-end integration test.
 *
 * Verifies the full chain `active v1 -> candidate v2 -> rejected/accepted
 * shadow` across the Phase 2 modules:
 *
 *   T22 buildExperienceSnapshot  — baseline snapshot of the active library (v1)
 *   T24 generateExperienceCandidate — candidate snapshot (v2), lineage edge (T23)
 *   T25 replayCandidate          — executable replay verdict vs baseline
 *   T27 measurement gate         — E0/E1 credibility check on the measurement
 *   T26 promoteToShadow          — shadow-only promotion via T5 controller
 *
 * Acceptance criteria (phase2-orchestration-plan S7):
 *   1. happy path: pass verdict + trusted measurement -> shadow event emitted,
 *      the active slot (holding v1) is not rewritten, lineage records the edge;
 *   2. rejection path: worse-quality candidate -> reject verdict -> no shadow
 *      event anywhere;
 *   3. untrusted measurement path: stale replay timestamp -> measurement gate
 *      blocks promotion even though the verdict is "pass";
 *   4. reproducibility: rebuilding the snapshot and regenerating the candidate
 *      over unchanged inputs yields the same content-addressed artifact IDs.
 *
 * Seq plan: the T5 controller enforces global seq uniqueness while slot gap
 * detection assumes slot-local contiguous seqs starting at 1, so the active v1
 * chain takes seq 1..5 on ACTIVE_SLOT and the shadow event takes seq 6 on
 * SHADOW_SLOT. The shadow event is therefore verified via the event stream
 * table (slot-local state resolution would flag the cross-slot seq layout),
 * mirroring the T26 unit test.
 */

const ACTIVE_SLOT = "experience-active";
const SHADOW_SLOT = "experience-shadow";
const REJECT_SLOT = "experience-rejected";
const FIXED_NOW = 1_700_000_000_000;
const STALE_REPLAY_AT = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

const ACTIVE_CHAIN = ["shadow", "canary_pending_approval", "canary", "active_pending_approval", "active"] as const;
const SHADOW_SEQ = ACTIVE_CHAIN.length + 1;

function makeExperience(id: string, type: Experience["type"], quality: number): Experience {
	return {
		id,
		type,
		title: `title-${id}`,
		payload: { text: `payload-${id}` },
		quality,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "session-p2",
		sourceEntryId: `entry-${id}`,
		contentHash: `hash-${id}`,
		createdAt: "2026-08-28T00:00:00.000Z",
	};
}

/** Seed the active experience library (v1): three entries with the given qualities. */
async function seedLibrary(store: ExperienceStore, qualities: [number, number, number]): Promise<void> {
	await store.insert(makeExperience("exp-a", "SKILL", qualities[0]));
	await store.insert(makeExperience("exp-b", "SOP", qualities[1]));
	await store.insert(makeExperience("exp-c", "ABILITY", qualities[2]));
}

interface Env {
	base: string;
	store: ExperienceStore;
	registry: ArtifactRegistry;
	lineage: LineageTracker;
	controller: PromotionController;
}

/** Walk the active slot through the full state machine so it holds v1 as `active`. */
function activateBaseline(controller: PromotionController, artifactId: string): SlotState {
	let previousEventId: string | null = null;
	for (let i = 0; i < ACTIVE_CHAIN.length; i++) {
		previousEventId = controller.emitDeploymentEvent({
			seq: i + 1,
			slot: ACTIVE_SLOT,
			eventType: ACTIVE_CHAIN[i],
			artifactId,
			previousEventId,
			operator: "p2-t28-test",
			reason: "activate baseline v1",
			occurredAt: FIXED_NOW + i,
		});
	}
	return controller.resolveSlotState(ACTIVE_SLOT);
}

function countSlotEvents(controller: PromotionController, slot: string): number {
	const row = controller.db.prepare("SELECT COUNT(*) AS n FROM deployment_event_stream WHERE slot = ?").get(slot) as {
		n: number;
	};
	return row.n;
}

async function generateImproveCandidate(env: Env, parentSnapshotId: string): Promise<CandidateGenerationResult> {
	const result = await generateExperienceCandidate(env.store, env.registry, env.lineage, {
		parentSnapshotId,
		operator: "improve",
		evidenceRefs: ["cluster-p2"],
	});
	expect(result.status).toBe("generated");
	expect(result.candidateId).toMatch(/^cand-[0-9a-f]{32}$/);
	expect(result.snapshotArtifactId).toMatch(/^[0-9a-f]{64}$/);
	expect(result.parentIds).toEqual([parentSnapshotId]);
	return result;
}

describe("phase2 end-to-end integration (P2-T28)", () => {
	let env: Env;

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "evo-phase2-e2e-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		env = {
			base,
			store: new ExperienceStore(join(base, "experience-store.db")),
			registry: openArtifactRegistry(evo.db, join(base, "blobs")),
			lineage: new LineageTracker(evo.db),
			controller: new PromotionController(evo.db, DevAuditWriter.loadOrCreate(join(base, "creds"))),
		};
		await env.store.initSchema();
	});

	afterEach(() => {
		env.controller.close();
		env.store.close();
		rmSync(env.base, { recursive: true, force: true });
	});

	it("happy path: active v1 -> candidate v2 -> pass + trusted -> shadow, active untouched, reproducible", async () => {
		// Step 1: baseline snapshot of the active experience library (v1).
		await seedLibrary(env.store, [0.9, 0.7, 0.5]);
		const baseline: ExperienceSnapshot = await buildExperienceSnapshot(env.store, env.registry);
		expect(baseline.entryCount).toBe(3);
		expect(baseline.artifactId).toMatch(/^[0-9a-f]{64}$/);

		// v1 is the active artifact on its slot.
		const activeBefore = activateBaseline(env.controller, baseline.artifactId);
		expect(activeBefore.eventType).toBe("active");

		// Step 2: generate candidate v2 (improve over the v1 snapshot).
		const candidate = await generateImproveCandidate(env, baseline.artifactId);
		expect(candidate.snapshotArtifactId).not.toBe(baseline.artifactId);

		// Step 3: replay/validate the candidate against the baseline.
		const replayNow = new Date().toISOString();
		const replay: ReplayResult = await replayCandidate(
			candidate.snapshotArtifactId,
			baseline.artifactId,
			env.registry,
			{
				now: replayNow,
			},
		);
		expect(replay.verdict).toBe("pass");
		expect(replay.candidateId).toBe(candidate.snapshotArtifactId);
		expect(replay.baselineId).toBe(baseline.artifactId);
		expect(replay.metrics.lostContentHashes).toBe(0);
		expect(replay.metrics.contentHashOverlap).toBe(1);
		expect(replay.metrics.meanQualityDelta).toBeCloseTo(0, 9);
		expect(replay.metrics.minQualityDelta).toBeCloseTo(0, 9);
		expect(replay.metrics.invalidEntries).toBe(0);

		// Step 4: the measurement behind the verdict must be credible.
		const credibility = checkMeasurementCredibility({
			replayResult: replay,
			baselineId: baseline.artifactId,
			candidateId: candidate.snapshotArtifactId,
		});
		expect(credibility.trusted).toBe(true);
		expect(credibility.reasons).toEqual([]);
		expect(gateShadowPromotion(replay, baseline.artifactId, candidate.snapshotArtifactId)).toBe(true);

		// Step 5: promote to shadow (shadow-only; never touches active).
		const promotion = await promoteToShadow(env.controller, {
			candidateId: candidate.snapshotArtifactId,
			slot: SHADOW_SLOT,
			replayResult: replay,
			seq: SHADOW_SEQ,
			occurredAt: FIXED_NOW + ACTIVE_CHAIN.length,
		});
		expect(promotion.promoted).toBe(true);
		expect(promotion.eventId).toMatch(/^[0-9a-f]{64}$/);

		const shadowRow = env.controller.db
			.prepare(
				"SELECT seq, slot, event_type, artifact_id, previous_event_id FROM deployment_event_stream WHERE slot = ?",
			)
			.get(SHADOW_SLOT) as {
			seq: number;
			slot: string;
			event_type: string;
			artifact_id: string;
			previous_event_id: string | null;
		};
		expect(shadowRow.seq).toBe(SHADOW_SEQ);
		expect(shadowRow.event_type).toBe("shadow");
		expect(shadowRow.artifact_id).toBe(candidate.snapshotArtifactId);
		expect(shadowRow.previous_event_id).toBeNull();

		// The active slot still holds v1, byte-identical state.
		expect(env.controller.resolveSlotState(ACTIVE_SLOT)).toEqual(activeBefore);
		const activeRow = env.controller.db
			.prepare(
				"SELECT artifact_id, event_type FROM deployment_event_stream WHERE slot = ? ORDER BY seq DESC LIMIT 1",
			)
			.get(ACTIVE_SLOT) as { artifact_id: string; event_type: string };
		expect(activeRow.event_type).toBe("active");
		expect(activeRow.artifact_id).toBe(baseline.artifactId);

		// Lineage: v2 -> v1 edge recorded and traversable both directions.
		const parents = env.lineage.getParents(candidate.snapshotArtifactId);
		expect(parents.some((e) => e.parentId === baseline.artifactId && e.operator === "improve")).toBe(true);
		const children = env.lineage.getChildren(baseline.artifactId);
		expect(children.some((e) => e.childId === candidate.snapshotArtifactId)).toBe(true);
		expect(env.lineage.getAncestors(candidate.snapshotArtifactId).length).toBeGreaterThanOrEqual(1);

		// Reproducibility: unchanged inputs reproduce the same artifact IDs.
		const baselineRerun = await buildExperienceSnapshot(env.store, env.registry);
		expect(baselineRerun.artifactId).toBe(baseline.artifactId);
		const candidateRerun = await generateImproveCandidate(env, baseline.artifactId);
		expect(candidateRerun.snapshotArtifactId).toBe(candidate.snapshotArtifactId);
		expect(candidateRerun.candidateId).toBe(candidate.candidateId);
		const replayRerun = await replayCandidate(candidate.snapshotArtifactId, baseline.artifactId, env.registry, {
			now: replayNow,
		});
		expect(replayRerun).toEqual(replay);
	});

	it("rejection path: worse-quality candidate -> reject verdict -> no shadow event", async () => {
		await seedLibrary(env.store, [0.9, 0.7, 0.5]);
		const baseline = await buildExperienceSnapshot(env.store, env.registry);
		const activeBefore = activateBaseline(env.controller, baseline.artifactId);

		// A regressed library (same ids/contentHashes, lower qualities) yields v2.
		const worseStore = new ExperienceStore(":memory:");
		await worseStore.initSchema();
		await seedLibrary(worseStore, [0.2, 0.1, 0.05]);
		const candidate = await generateExperienceCandidate(worseStore, env.registry, env.lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-regression"],
		});
		expect(candidate.status).toBe("generated");

		const replay = await replayCandidate(candidate.snapshotArtifactId, baseline.artifactId, env.registry);
		expect(replay.verdict).toBe("reject");
		expect(replay.metrics.lostContentHashes).toBe(0);
		expect(replay.metrics.meanQualityDelta as number).toBeLessThan(0);
		expect(replay.metrics.minQualityDelta as number).toBeLessThan(0);

		// The gate refuses a reject verdict regardless of measurement freshness.
		expect(gateShadowPromotion(replay, baseline.artifactId, candidate.snapshotArtifactId)).toBe(false);

		const promotion = await promoteToShadow(env.controller, {
			candidateId: candidate.snapshotArtifactId,
			slot: REJECT_SLOT,
			replayResult: replay,
		});
		expect(promotion.promoted).toBe(false);
		expect(promotion.eventId).toBeNull();

		// Rejection leaves no trace in the event stream; active v1 untouched.
		expect(countSlotEvents(env.controller, REJECT_SLOT)).toBe(0);
		expect(countSlotEvents(env.controller, SHADOW_SLOT)).toBe(0);
		expect(env.controller.resolveSlotState(ACTIVE_SLOT)).toEqual(activeBefore);
	});

	it("untrusted measurement path: stale replay timestamp blocks promotion despite pass verdict", async () => {
		await seedLibrary(env.store, [0.9, 0.7, 0.5]);
		const baseline = await buildExperienceSnapshot(env.store, env.registry);
		const activeBefore = activateBaseline(env.controller, baseline.artifactId);
		const candidate = await generateImproveCandidate(env, baseline.artifactId);

		// Same replay, but the measurement is 48h old: not reproducible evidence.
		const staleReplay = await replayCandidate(candidate.snapshotArtifactId, baseline.artifactId, env.registry, {
			now: STALE_REPLAY_AT,
		});
		expect(staleReplay.verdict).toBe("pass");

		const credibility = checkMeasurementCredibility({
			replayResult: staleReplay,
			baselineId: baseline.artifactId,
			candidateId: candidate.snapshotArtifactId,
		});
		expect(credibility.trusted).toBe(false);
		expect(credibility.reasons.some((r) => r.includes("stale"))).toBe(true);
		expect(gateShadowPromotion(staleReplay, baseline.artifactId, candidate.snapshotArtifactId)).toBe(false);

		// The gate's blocking power holds at the real promotion entry point: a
		// direct promoteToShadow attempt with the stale replay is refused and
		// emits no event (gate-to-promotion contract).
		const blockedPromotion = await promoteToShadow(env.controller, {
			candidateId: candidate.snapshotArtifactId,
			slot: SHADOW_SLOT,
			replayResult: staleReplay,
		});
		expect(blockedPromotion.promoted).toBe(false);
		expect(blockedPromotion.eventId).toBeNull();

		// Gate blocked: no shadow event is ever emitted for this candidate.
		expect(countSlotEvents(env.controller, SHADOW_SLOT)).toBe(0);
		expect(env.controller.resolveSlotState(ACTIVE_SLOT)).toEqual(activeBefore);

		// Contrast: the identical replay with a fresh timestamp passes the gate.
		const freshReplay = await replayCandidate(candidate.snapshotArtifactId, baseline.artifactId, env.registry, {
			now: new Date().toISOString(),
		});
		expect(gateShadowPromotion(freshReplay, baseline.artifactId, candidate.snapshotArtifactId)).toBe(true);
	});
});
