import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "evo-promo-"));
}

describe("promotion controller", () => {
	let base: string;
	let controller: PromotionController;
	let auditWriter: DevAuditWriter;
	let artifactId: string;

	beforeEach(() => {
		base = tempDir();
		const db = openEvolutionDb(join(base, "evolution.db"));
		const registry = openArtifactRegistry(db.db, join(base, "blobs"));
		auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(db.db, auditWriter);

		const blob = Buffer.from("promotion-test-blob");
		const manifest: ArtifactManifest = {
			kind: "experience_snapshot",
			parent_ids: [],
			operator: "draft",
			scope: ["test"],
			evidence_refs: [],
			scaffold_hash: createHash("sha256").update("scaffold").digest("hex"),
			model_fingerprint: JSON.stringify({ model: "faux" }),
			data_class: "diagnostic_ops",
			retention_policy_ref: "pending_0b",
			blob_hashes: [createHash("sha256").update(blob).digest("hex")],
		};
		artifactId = registry.storeArtifact(manifest, [blob]);
	});

	afterEach(() => {
		controller.close();
		rmSync(base, { recursive: true, force: true });
	});

	function emit(slot: string, type: string, prevId: string | null, seq: number) {
		return controller.emitDeploymentEvent({
			slot,
			eventType: type as import("../../src/evolution/schema.ts").EventType,
			artifactId,
			previousEventId: prevId,
			seq,
			operator: "test",
			reason: "test",
			occurredAt: Date.now(),
		});
	}

	it("accepts the canonical forward path", () => {
		const id1 = emit("slot-a", "shadow", null, 1);
		const id2 = emit("slot-a", "canary_pending_approval", id1, 2);
		const id3 = emit("slot-a", "canary", id2, 3);
		const id4 = emit("slot-a", "active_pending_approval", id3, 4);
		const id5 = emit("slot-a", "active", id4, 5);
		expect(id5).toBeDefined();
		expect(controller.resolveSlotState("slot-a")).toEqual({
			eventId: id5,
			eventType: "active",
			seq: 5,
			gapDetected: false,
		});
	});

	it("rejects active without shadow", () => {
		expect(() => emit("slot-b", "active", null, 1)).toThrow(/invalid state transition/);
	});

	it("rejects previous_event_id mismatch", () => {
		emit("slot-c", "shadow", null, 1);
		expect(() => emit("slot-c", "canary_pending_approval", "bogus-id", 2)).toThrow(/previous_event_id mismatch/);
	});

	it("rejects duplicate seq", () => {
		const id1 = emit("slot-d", "shadow", null, 1);
		expect(() => emit("slot-d", "canary_pending_approval", id1, 1)).toThrow(/seq already exists/);
	});

	it("requires first event previous_event_id to be null", () => {
		expect(() => emit("slot-e", "shadow", "not-null", 1)).toThrow(/first event must have previous_event_id=null/);
	});

	it("detects seq gap and marks slot fail-closed", () => {
		const id1 = emit("slot-f", "shadow", null, 1);
		emit("slot-f", "canary_pending_approval", id1, 3); // skip seq 2
		const state = controller.resolveSlotState("slot-f");
		expect(state.gapDetected).toBe(true);
		expect(state.eventType).toBe("unknown");
	});

	it("supports rollback event", () => {
		const id1 = emit("slot-g", "shadow", null, 1);
		const id2 = emit("slot-g", "canary_pending_approval", id1, 2);
		const id3 = emit("slot-g", "rollback", id2, 3);
		expect(controller.resolveSlotState("slot-g").eventType).toBe("rollback");
		expect(id3).toBeDefined();
	});

	it("stores signed events with key_id", () => {
		emit("slot-h", "shadow", null, 1);
		const row = controller.db
			.prepare("SELECT key_id, signature FROM deployment_event_stream WHERE slot = ?")
			.get("slot-h") as { key_id: string; signature: string };
		expect(row.key_id).toMatch(/^dev-audit-/);
		expect(row.signature.length).toBeGreaterThan(0);
	});
});
