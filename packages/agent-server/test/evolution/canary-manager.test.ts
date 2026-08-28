import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { CanaryManager } from "../../src/evolution/canary-manager.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import { applyScaffoldOperator } from "../../src/evolution/scaffold-operators.ts";

describe("P3-T33 canary manager and rollback", () => {
	let base: string;
	let registry: ArtifactRegistry;
	let controller: PromotionController;
	let manager: CanaryManager;
	let gen0ArtifactId: string;
	let candidateArtifactId: string;
	let seq: number;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-canary-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		new LineageTracker(evo.db);
		const lineage = new LineageTracker(evo.db);
		controller = new PromotionController(evo.db, DevAuditWriter.loadOrCreate(join(base, "creds")));
		manager = new CanaryManager();
		seq = 0;

		const gen0 = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["gen0"],
		});
		if (gen0.status !== "generated") throw new Error("gen0 draft failed");
		gen0ArtifactId = gen0.artifactId;

		const candidate = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["candidate"],
		});
		if (candidate.status !== "generated") throw new Error("candidate draft failed");
		candidateArtifactId = candidate.artifactId;
	});

	afterEach(() => {
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	function nextSeq(): number {
		return ++seq;
	}

	it("walks shadow -> canary_pending_approval -> canary -> active_pending_approval -> active", () => {
		const slot = "scaffold";

		// Pre-seed shadow so the slot has a starting state.
		controller.emitDeploymentEvent({
			seq: nextSeq(),
			slot,
			eventType: "shadow",
			artifactId: candidateArtifactId,
			operator: "system",
			reason: "candidate passed gate",
			occurredAt: Date.now(),
		});

		const pending = manager.requestCanary(controller, {
			seq: nextSeq(),
			slot,
			artifactId: candidateArtifactId,
			approver: "human-a",
			reason: "request canary",
		});
		expect(pending.slotState.eventType).toBe("canary_pending_approval");

		const canary = manager.approveCanary(controller, {
			seq: nextSeq(),
			slot,
			artifactId: candidateArtifactId,
			approver: "human-a",
			reason: "approve canary",
		});
		expect(canary.slotState.eventType).toBe("canary");

		const activePending = manager.requestActive(controller, {
			seq: nextSeq(),
			slot,
			artifactId: candidateArtifactId,
			approver: "human-b",
			reason: "request active",
		});
		expect(activePending.slotState.eventType).toBe("active_pending_approval");

		const active = manager.approveActive(controller, {
			seq: nextSeq(),
			slot,
			artifactId: candidateArtifactId,
			approver: "human-b",
			reason: "approve active",
		});
		expect(active.slotState.eventType).toBe("active");
	});

	it("rolls back to a previous artifact", () => {
		const slot = "scaffold";
		const chain: Array<{
			type: "shadow" | "canary_pending_approval" | "canary" | "active_pending_approval" | "active";
			reason: string;
		}> = [
			{ type: "shadow", reason: "candidate passed gate" },
			{ type: "canary_pending_approval", reason: "request canary" },
			{ type: "canary", reason: "approve canary" },
			{ type: "active_pending_approval", reason: "request active" },
			{ type: "active", reason: "approve active" },
		];
		for (const step of chain) {
			const state = controller.resolveSlotState(slot);
			controller.emitDeploymentEvent({
				seq: nextSeq(),
				slot,
				eventType: step.type,
				artifactId: candidateArtifactId,
				previousEventId: state.eventId,
				operator: "system",
				reason: step.reason,
				occurredAt: Date.now(),
			});
		}
		expect(controller.resolveSlotState(slot).eventType).toBe("active");

		const rollback = manager.rollback(controller, {
			seq: nextSeq(),
			slot,
			targetArtifactId: gen0ArtifactId,
			approver: "human-c",
			reason: "rollback to gen0",
		});
		expect(rollback.slotState.eventType).toBe("rollback");
		expect(rollback.slotState.eventId).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses canary approval from the wrong state", () => {
		expect(() =>
			manager.approveCanary(controller, {
				seq: nextSeq(),
				slot: "empty-slot",
				artifactId: candidateArtifactId,
				approver: "human-a",
				reason: "wrong state",
			}),
		).toThrow("cannot approve canary");
	});
});
