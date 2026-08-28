import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import type { ReplayResult, ReplayVerdict, SnapshotMetrics } from "../../src/evolution/replay-validator.ts";
import type { EventType } from "../../src/evolution/schema.ts";
import { promoteToShadow } from "../../src/evolution/shadow-promoter.ts";

const FIXED_NOW = 1_700_000_000_000;

function storeCandidate(registry: ArtifactRegistry, content: string): string {
	const blob = Buffer.from(content, "utf8");
	const manifest: ArtifactManifest = {
		kind: "experience_snapshot",
		parent_ids: [],
		operator: "draft",
		scope: ["experience"],
		evidence_refs: [],
		scaffold_hash: createHash("sha256").update("shadow-promoter-test/scaffold").digest("hex"),
		model_fingerprint: JSON.stringify({ model: "deterministic-mock" }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [createHash("sha256").update(blob).digest("hex")],
	};
	return registry.storeArtifact(manifest, [blob]);
}

function snapshotMetrics(): SnapshotMetrics {
	return {
		entryCount: 1,
		meanQuality: 0.8,
		minQuality: 0.8,
		qualityDistribution: { "0.8-1.0": 1 },
		distinctContentHashes: 1,
	};
}

// A fully credible measurement (T27 gate: complete metrics, fresh timestamp,
// distinct candidate/baseline) so the verdict alone decides the outcome.
function replayResult(verdict: ReplayVerdict, candidateId: string): ReplayResult {
	return {
		candidateId,
		baselineId: "b".repeat(64),
		metrics: {
			candidate: snapshotMetrics(),
			baseline: snapshotMetrics(),
			contentHashOverlap: 1,
			lostContentHashes: 0,
			meanQualityDelta: 0,
			minQualityDelta: 0,
			invalidEntries: 0,
		},
		verdict,
		timestamp: new Date().toISOString(),
	};
}

describe("shadow promoter (P2-T26)", () => {
	let base: string;
	let controller: PromotionController;
	let registry: ArtifactRegistry;
	let candidateId: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-shadow-promo-"));
		const db = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(base, "blobs"));
		const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(db.db, auditWriter);
		candidateId = storeCandidate(registry, "shadow-promoter-candidate");
	});

	afterEach(() => {
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("promotes a pass verdict to shadow", async () => {
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-pass",
			replayResult: replayResult("pass", candidateId),
			occurredAt: FIXED_NOW,
		});

		expect(result.promoted).toBe(true);
		expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);
		expect(result.slotState.eventType).toBe("shadow");
		expect(result.slotState.eventId).toBe(result.eventId);
		expect(result.slotState.seq).toBe(1);
		expect(result.slotState.gapDetected).toBe(false);
	});

	it("does not promote a reject verdict", async () => {
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-reject",
			replayResult: replayResult("reject", candidateId),
		});

		expect(result.promoted).toBe(false);
		expect(result.eventId).toBeNull();
		expect(result.slotState).toEqual({ eventId: null, eventType: "unknown", seq: null, gapDetected: false });

		const rows = controller.db
			.prepare("SELECT COUNT(*) AS n FROM deployment_event_stream WHERE slot = ?")
			.get("slot-reject") as { n: number };
		expect(rows.n).toBe(0);
	});

	it("does not promote an inconclusive verdict", async () => {
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-inconclusive",
			replayResult: replayResult("inconclusive", candidateId),
		});

		expect(result.promoted).toBe(false);
		expect(result.eventId).toBeNull();
		expect(controller.resolveSlotState("slot-inconclusive").eventType).toBe("unknown");

		const rows = controller.db
			.prepare("SELECT COUNT(*) AS n FROM deployment_event_stream WHERE slot = ?")
			.get("slot-inconclusive") as { n: number };
		expect(rows.n).toBe(0);
	});

	it("blocks promotion when the replay verdict belongs to a different candidate", async () => {
		const otherCandidateId = storeCandidate(registry, "shadow-promoter-other-candidate");
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-mismatch",
			replayResult: replayResult("pass", otherCandidateId),
			occurredAt: FIXED_NOW,
		});

		expect(result.promoted).toBe(false);
		expect(result.eventId).toBeNull();
		expect(result.slotState).toEqual({ eventId: null, eventType: "unknown", seq: null, gapDetected: false });

		const rows = controller.db
			.prepare("SELECT COUNT(*) AS n FROM deployment_event_stream WHERE slot = ?")
			.get("slot-mismatch") as { n: number };
		expect(rows.n).toBe(0);
	});

	it("blocks promotion when the measurement is untrusted despite a pass verdict", async () => {
		// A pass verdict whose measurement is stale (2023 timestamp) fails the
		// T27 E1 freshness check; the promoter enforces the gate fail-closed.
		const stale = replayResult("pass", candidateId);
		stale.timestamp = new Date(FIXED_NOW).toISOString();
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-untrusted",
			replayResult: stale,
			occurredAt: FIXED_NOW,
		});

		expect(result.promoted).toBe(false);
		expect(result.eventId).toBeNull();
		expect(result.slotState).toEqual({ eventId: null, eventType: "unknown", seq: null, gapDetected: false });

		const rows = controller.db
			.prepare("SELECT COUNT(*) AS n FROM deployment_event_stream WHERE slot = ?")
			.get("slot-untrusted") as { n: number };
		expect(rows.n).toBe(0);
	});

	it("records the shadow event with the correct slot and candidate", async () => {
		const result = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-recorded",
			replayResult: replayResult("pass", candidateId),
			occurredAt: FIXED_NOW,
		});

		const row = controller.db
			.prepare(
				`SELECT event_id, seq, slot, event_type, artifact_id, previous_event_id, key_id, signature
				 FROM deployment_event_stream WHERE slot = ?`,
			)
			.get("slot-recorded") as {
			event_id: string;
			seq: number;
			slot: string;
			event_type: EventType;
			artifact_id: string;
			previous_event_id: string | null;
			key_id: string;
			signature: string;
		};

		expect(row.event_id).toBe(result.eventId);
		expect(row.seq).toBe(1);
		expect(row.slot).toBe("slot-recorded");
		expect(row.event_type).toBe("shadow");
		expect(row.artifact_id).toBe(candidateId);
		expect(row.previous_event_id).toBeNull();
		expect(row.key_id).toMatch(/^dev-audit-/);
		expect(row.signature.length).toBeGreaterThan(0);
	});

	it("does not modify an already-active slot", async () => {
		// Walk an active slot through the full chain first.
		const activeArtifactId = storeCandidate(registry, "shadow-promoter-active-baseline");
		const chain = ["shadow", "canary_pending_approval", "canary", "active_pending_approval", "active"] as const;
		let prev: string | null = null;
		for (let i = 0; i < chain.length; i++) {
			prev = controller.emitDeploymentEvent({
				seq: i + 1,
				slot: "slot-active",
				eventType: chain[i],
				artifactId: activeArtifactId,
				previousEventId: prev,
				operator: "test",
				reason: "setup",
				occurredAt: FIXED_NOW + i,
			});
		}
		const activeBefore = controller.resolveSlotState("slot-active");
		expect(activeBefore.eventType).toBe("active");

		// Reject verdict: no event anywhere, active slot untouched.
		const rejected = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-candidate",
			replayResult: replayResult("reject", candidateId),
		});
		expect(rejected.promoted).toBe(false);
		expect(controller.resolveSlotState("slot-active")).toEqual(activeBefore);

		// Pass verdict on a different slot: shadow event uses an explicit seq
		// (global uniqueness), the active slot stays untouched.
		const promoted = await promoteToShadow(controller, {
			candidateId: candidateId,
			slot: "slot-candidate",
			replayResult: replayResult("pass", candidateId),
			seq: 6,
			occurredAt: FIXED_NOW + 5,
		});
		expect(promoted.promoted).toBe(true);
		expect(controller.resolveSlotState("slot-active")).toEqual(activeBefore);

		// Shadow promotion alone never reaches active on the candidate slot.
		const candidateState = controller.db
			.prepare("SELECT event_type FROM deployment_event_stream WHERE slot = ?")
			.all("slot-candidate") as Array<{ event_type: string }>;
		expect(candidateState.map((r) => r.event_type)).toEqual(["shadow"]);
	});
});
