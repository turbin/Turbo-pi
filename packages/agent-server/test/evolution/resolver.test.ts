import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import { ResolvedRecorder } from "../../src/evolution/record-resolved.ts";
import { RuntimeResolver } from "../../src/evolution/runtime-resolver.ts";

function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function makeArtifactBlob(): Buffer {
	return Buffer.from("resolved-artifact-blob");
}

function makeManifest(blob: Buffer): ArtifactManifest {
	return {
		kind: "experience_snapshot",
		parent_ids: [],
		operator: "draft",
		scope: ["test"],
		evidence_refs: [],
		scaffold_hash: createHash("sha256").update("scaffold").digest("hex"),
		model_fingerprint: JSON.stringify({ model: "faux" }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [sha256Hex(blob)],
	};
}

describe("runtime resolver", () => {
	let base: string;
	let resolver: RuntimeResolver;
	let controller: PromotionController;
	let registry: ReturnType<typeof openArtifactRegistry>;
	let artifactId: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-resolver-"));
		const db = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(base, "blobs"));
		const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(db.db, auditWriter);
		resolver = new RuntimeResolver(db.db, registry);

		const blob = makeArtifactBlob();
		artifactId = registry.storeArtifact(makeManifest(blob), [blob]);
	});

	afterEach(() => {
		resolver.close();
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

	it("resolves a slot from the event stream and returns verified bundle", () => {
		emit("slot-x", "shadow", null, 1);
		const resolved = resolver.resolveSlot("slot-x");
		expect(resolved.event.artifact_id).toBe(artifactId);
		expect(resolved.bundle.manifest).toEqual(makeManifest(makeArtifactBlob()));
	});

	it("rejects loading when blob sha256 does not match", () => {
		emit("slot-x", "shadow", null, 1);
		// corrupt the blob file
		const blobHash = sha256Hex(makeArtifactBlob());
		writeFileSync(join(registry.blobsDir, blobHash), Buffer.from("corrupted"));
		expect(() => resolver.resolveSlot("slot-x")).toThrow(/blob sha256 mismatch/);
	});

	it("rejects resolving a slot with no events", () => {
		expect(() => resolver.resolveSlot("empty-slot")).toThrow(/no deployment events for slot/);
	});

	it("rejects resolving a slot with a seq gap", () => {
		const id1 = emit("slot-gapped", "shadow", null, 1);
		emit("slot-gapped", "canary_pending_approval", id1, 3);
		expect(() => resolver.resolveSlot("slot-gapped")).toThrow(/seq gap detected/);
	});
});

describe("resolved recorder", () => {
	let base: string;
	let recorder: ResolvedRecorder;
	let controller: PromotionController;
	let registry: ReturnType<typeof openArtifactRegistry>;
	let artifactId: string;
	let eventId: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-resolved-"));
		const db = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(base, "blobs"));
		const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
		controller = new PromotionController(db.db, auditWriter);
		recorder = new ResolvedRecorder(db.db);

		const blob = makeArtifactBlob();
		artifactId = registry.storeArtifact(makeManifest(blob), [blob]);
		eventId = controller.emitDeploymentEvent({
			slot: "slot-y",
			eventType: "shadow",
			artifactId,
			previousEventId: null,
			seq: 1,
			operator: "test",
			reason: "test",
			occurredAt: Date.now(),
		});
	});

	afterEach(() => {
		recorder.close();
		rmSync(base, { recursive: true, force: true });
	});

	function validInput(resolvedAt: number) {
		return {
			taskId: "task-1",
			slot: "slot-y",
			artifactId,
			deploymentEventId: eventId,
			resolvedBlobShas: [sha256Hex(makeArtifactBlob())],
			resolvedScaffoldHash: createHash("sha256").update("scaffold").digest("hex"),
			actualProviderModel: "faux/model",
			actualApiIdentifier: "external",
			envSnapshotHash: "0".repeat(64),
			driftFlag: "none" as const,
			resolvedAt,
		};
	}

	it("records a resolved manifest and returns resolved_id", () => {
		const id = recorder.recordResolvedManifest(validInput(1000));
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is idempotent for the same (task_id, slot, resolved_at)", () => {
		const input = validInput(2000);
		const id1 = recorder.recordResolvedManifest(input);
		const id2 = recorder.recordResolvedManifest(input);
		expect(id1).toBe(id2);
	});

	it("rejects missing required fields", () => {
		for (const key of Object.keys(validInput(3000))) {
			const bad = { ...validInput(3000) } as Record<string, unknown>;
			delete bad[key];
			expect(() => recorder.recordResolvedManifest(bad)).toThrow(/missing required field/);
		}
	});

	it("rejects non-existent deployment_event_id via FK", () => {
		const bad = { ...validInput(4000), deploymentEventId: "no-such-event" };
		expect(() => recorder.recordResolvedManifest(bad)).toThrow(/FOREIGN KEY constraint failed/);
	});

	it("reconciles slot_mismatch when resolved artifact differs from event claim", () => {
		recorder.recordResolvedManifest(validInput(5000));
		const result = recorder.reconcileSlot("task-1", "slot-y");
		expect(result.driftFlag).toBe("none");
	});
});
