import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * P1-T20: evidence reconciliation query.
 *
 * Joins the three Phase 1 record families for one task:
 *   1. session sidecar files written by coding-agent (`version-contract.json`,
 *      `resolved-manifest-<slot>-<ts>.json`);
 *   2. evidence artifacts in evolution.db whose evidence_refs carry
 *      `task:<taskId>` (written by the T18 evidence artifact builder);
 * and cross-checks that the artifact_id the runtime actually resolved matches
 * the gen0 version contract artifactId.
 *
 * Orphan records: a resolved manifest without a version contract (or vice
 * versa), an artifact_id mismatch between the two, or unreadable sidecar
 * files. `complete` is true only when contract + manifest exist, agree on the
 * artifact_id, and at least one evidence artifact references the task.
 */

export interface ReconciliationReport {
	taskId: string;
	sessionDir?: string;
	versionContract?: { artifactId: string; scaffoldHash: string; snapshotSha: string };
	resolvedManifest?: {
		resolvedId: string;
		artifactId: string;
		actualProviderModel: string;
		envSnapshot: Record<string, unknown>;
	};
	evidenceArtifactIds: string[];
	orphanRecords: string[];
	complete: boolean;
}

export interface ReconcileOptions {
	sessionDir?: string;
	registry?: ArtifactRegistry;
	evolutionDb?: Database.Database;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	return isRecord(parsed) ? parsed : undefined;
}

function readVersionContract(sessionDir: string): ReconciliationReport["versionContract"] | undefined {
	const data = readJson(join(sessionDir, "version-contract.json"));
	if (!data) {
		return undefined;
	}
	if (
		typeof data.artifactId !== "string" ||
		typeof data.scaffoldHash !== "string" ||
		typeof data.snapshotSha !== "string"
	) {
		return undefined;
	}
	return { artifactId: data.artifactId, scaffoldHash: data.scaffoldHash, snapshotSha: data.snapshotSha };
}

function readResolvedManifest(sessionDir: string): ReconciliationReport["resolvedManifest"] | undefined {
	const names = readdirSync(sessionDir)
		.filter((name) => /^resolved-manifest-.+-\d+\.json$/.test(name))
		.sort();
	const name = names[names.length - 1];
	if (!name) {
		return undefined;
	}
	const data = readJson(join(sessionDir, name));
	if (!data) {
		return undefined;
	}
	const taskId = data.task_id;
	const slot = data.slot;
	const resolvedAt = data.resolved_at;
	const artifactId = data.artifact_id;
	const actualProviderModel = data.actual_provider_model;
	const envSnapshot = data.env_snapshot;
	if (
		typeof taskId !== "string" ||
		typeof slot !== "string" ||
		typeof resolvedAt !== "number" ||
		typeof artifactId !== "string" ||
		typeof actualProviderModel !== "string" ||
		!isRecord(envSnapshot)
	) {
		return undefined;
	}
	// resolved_id identity mirrors T6a record-resolved: sha256 of canonical [taskId, slot, resolvedAt].
	const resolvedId = sha256Hex(canonicalJson([taskId, slot, resolvedAt]));
	return { resolvedId, artifactId, actualProviderModel, envSnapshot };
}

function queryEvidenceArtifactIds(db: Database.Database, taskId: string): string[] {
	const rows = db
		.prepare("SELECT artifact_id, evidence_refs FROM artifact_immutable_manifests WHERE kind = 'composite'")
		.all() as { artifact_id: string; evidence_refs: string }[];
	const needle = `task:${taskId}`;
	const ids: string[] = [];
	for (const row of rows) {
		let refs: unknown;
		try {
			refs = JSON.parse(row.evidence_refs);
		} catch {
			continue;
		}
		if (Array.isArray(refs) && refs.includes(needle)) {
			ids.push(row.artifact_id);
		}
	}
	return ids.sort();
}

/** Reconcile one task: session sidecar files + evolution.db evidence artifacts. */
export function reconcileTask(taskId: string, options: ReconcileOptions = {}): ReconciliationReport {
	const report: ReconciliationReport = {
		taskId,
		evidenceArtifactIds: [],
		orphanRecords: [],
		complete: false,
	};

	if (options.sessionDir) {
		report.sessionDir = options.sessionDir;
		try {
			report.versionContract = readVersionContract(options.sessionDir);
		} catch (error) {
			report.orphanRecords.push(
				`invalid_version_contract: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			report.resolvedManifest = readResolvedManifest(options.sessionDir);
		} catch (error) {
			report.orphanRecords.push(
				`invalid_resolved_manifest: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const db = options.evolutionDb ?? options.registry?.db;
	if (db) {
		report.evidenceArtifactIds = queryEvidenceArtifactIds(db, taskId);
	}

	if (report.resolvedManifest && !report.versionContract) {
		report.orphanRecords.push("orphan_resolved_manifest: resolved manifest exists but version contract is missing");
	}
	if (report.versionContract && !report.resolvedManifest) {
		report.orphanRecords.push("orphan_version_contract: version contract exists but resolved manifest is missing");
	}
	if (
		report.versionContract &&
		report.resolvedManifest &&
		report.versionContract.artifactId !== report.resolvedManifest.artifactId
	) {
		report.orphanRecords.push(
			`artifact_id_mismatch: version contract ${report.versionContract.artifactId} != resolved manifest ${report.resolvedManifest.artifactId}`,
		);
	}

	report.complete =
		report.versionContract !== undefined &&
		report.resolvedManifest !== undefined &&
		report.evidenceArtifactIds.length > 0 &&
		report.orphanRecords.length === 0;
	return report;
}

/** Scan a directory of session dirs; taskId is the session dir name. */
export function reconcileAll(options: {
	sessionsDir: string;
	registry?: ArtifactRegistry;
	evolutionDb?: Database.Database;
}): ReconciliationReport[] {
	const reports: ReconciliationReport[] = [];
	for (const name of readdirSync(options.sessionsDir).sort()) {
		const sessionDir = join(options.sessionsDir, name);
		if (!statSync(sessionDir).isDirectory()) {
			continue;
		}
		reports.push(reconcileTask(name, { sessionDir, registry: options.registry, evolutionDb: options.evolutionDb }));
	}
	return reports;
}
