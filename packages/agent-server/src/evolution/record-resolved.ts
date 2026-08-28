import type Database from "better-sqlite3";
import { AppendOnlyDao } from "./append-only-dao.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { DRIFT_FLAGS, type DriftFlag } from "./schema.ts";

/**
 * T6a: runtime resolved manifest recorder + reconciliation.
 *
 * Records what the runtime actually loaded for a task/slot. Every required
 * field is validated before the DAO write; missing fields fail closed (C8).
 *
 * Reconciliation: compare the artifact_id claimed by the latest deployment
 * event for the slot with the artifact_id actually recorded in the latest
 * resolved manifest. Mismatch -> drift_flag=slot_mismatch.
 */

export interface RecordResolvedInput {
	taskId: string;
	slot: string;
	artifactId: string;
	deploymentEventId: string;
	resolvedBlobShas: string[];
	resolvedScaffoldHash: string;
	actualProviderModel: string;
	actualApiIdentifier: string;
	envSnapshotHash: string;
	driftFlag: DriftFlag;
	resolvedAt: number;
}

export interface ReconciliationResult {
	taskId: string;
	slot: string;
	resolvedArtifactId: string | null;
	eventArtifactId: string | null;
	driftFlag: DriftFlag;
}

export class ResolvedRecorder {
	readonly db: Database.Database;
	private readonly dao: AppendOnlyDao;

	constructor(db: Database.Database) {
		this.db = db;
		this.dao = new AppendOnlyDao(db);
	}

	recordResolvedManifest(input: Record<string, unknown>): string {
		const normalized = this.normalizeAndValidate(input);
		const resolvedId = sha256Hex(canonicalJson([normalized.taskId, normalized.slot, normalized.resolvedAt]));
		const existing = this.db
			.prepare("SELECT resolved_id FROM runtime_resolved_manifests WHERE resolved_id = ?")
			.get(resolvedId) as { resolved_id: string } | undefined;
		if (existing) {
			return existing.resolved_id;
		}
		this.dao.appendResolved({
			resolvedId,
			taskId: normalized.taskId,
			slot: normalized.slot,
			artifactId: normalized.artifactId,
			deploymentEventId: normalized.deploymentEventId,
			resolvedBlobShas: normalized.resolvedBlobShas,
			resolvedScaffoldHash: normalized.resolvedScaffoldHash,
			actualProviderModel: normalized.actualProviderModel,
			actualApiIdentifier: normalized.actualApiIdentifier,
			envSnapshotHash: normalized.envSnapshotHash,
			driftFlag: normalized.driftFlag,
			resolvedAt: normalized.resolvedAt,
		});
		return resolvedId;
	}

	reconcileSlot(taskId: string, slot: string): ReconciliationResult {
		const resolved = this.db
			.prepare(
				"SELECT artifact_id, drift_flag FROM runtime_resolved_manifests WHERE task_id = ? AND slot = ? ORDER BY resolved_at DESC LIMIT 1",
			)
			.get(taskId, slot) as { artifact_id: string; drift_flag: DriftFlag } | undefined;

		const event = this.db
			.prepare("SELECT artifact_id FROM deployment_event_stream WHERE slot = ? ORDER BY seq DESC LIMIT 1")
			.get(slot) as { artifact_id: string } | undefined;

		const resolvedArtifactId = resolved?.artifact_id ?? null;
		const eventArtifactId = event?.artifact_id ?? null;
		let driftFlag: DriftFlag = resolved?.drift_flag ?? "none";

		if (resolvedArtifactId && eventArtifactId && resolvedArtifactId !== eventArtifactId) {
			driftFlag = "slot_mismatch";
		}

		return { taskId, slot, resolvedArtifactId, eventArtifactId, driftFlag };
	}

	close(): void {
		this.db.close();
	}

	private normalizeAndValidate(input: Record<string, unknown>): RecordResolvedInput {
		const requiredFields = [
			"taskId",
			"slot",
			"artifactId",
			"deploymentEventId",
			"resolvedBlobShas",
			"resolvedScaffoldHash",
			"actualProviderModel",
			"actualApiIdentifier",
			"envSnapshotHash",
			"driftFlag",
			"resolvedAt",
		] as const;

		const missing: string[] = [];
		for (const field of requiredFields) {
			if (input[field] === undefined || input[field] === null || input[field] === "") {
				missing.push(field);
			}
		}
		if (missing.length > 0) {
			throw new Error(`missing required field: ${missing.join(", ")}`);
		}

		const driftFlag = input.driftFlag as string;
		if (!DRIFT_FLAGS.includes(driftFlag as DriftFlag)) {
			throw new Error(`invalid driftFlag: ${driftFlag}`);
		}

		return input as unknown as RecordResolvedInput;
	}
}
