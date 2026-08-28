import { createHash } from "node:crypto";
import type { ExperienceStore } from "../experience-store.ts";
import type { Experience } from "../types.ts";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { canonicalJson } from "./canonical.ts";

/**
 * P2-T22: versioned experience snapshot builder.
 *
 * Captures the current active experience library (all types, status='active')
 * as an immutable, content-addressed `experience_snapshot` artifact in the T3
 * artifact registry. The snapshot blob is canonical JSON of
 * { entry_count, source_db_sha, entries } with entries sorted by id, so a
 * rebuild over unchanged content reproduces the exact same artifact_id (A3
 * stability) and any library change yields a new version.
 *
 * Blob layout (order frozen, mirrored in manifest.blob_hashes):
 *   blob[0]: canonical JSON of the snapshot payload
 */

export const EXPERIENCE_SNAPSHOT_KIND = "experience_snapshot" as const;

/** All experience types, in the frozen iteration order used when collecting. */
const EXPERIENCE_TYPES = ["SKILL", "SOP", "ABILITY", "EVIDENCE"] as const;

/**
 * Snapshots are scaffold-independent (they capture experience rows, not prompt
 * or tool configuration), so the manifest's scaffold_hash slot carries this
 * fixed sentinel digest instead of a real scaffold fingerprint.
 */
const NO_SCAFFOLD_SENTINEL = createHash("sha256").update("experience-snapshot:no-scaffold").digest("hex");

export interface ExperienceSnapshot {
	kind: typeof EXPERIENCE_SNAPSHOT_KIND;
	/** Content-addressed snapshot identity; identical to artifactId. */
	snapshotId: string;
	artifactId: string;
	createdAt: string;
	entryCount: number;
	sourceDbSha: string;
}

interface SnapshotPayload {
	entry_count: number;
	source_db_sha: string;
	entries: Record<string, unknown>[];
}

interface SnapshotRow {
	artifact_id: string;
	created_at: number;
}

function sha256Hex(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Collect every active experience across all types, sorted by id for determinism. */
async function collectActiveEntries(store: ExperienceStore): Promise<Record<string, unknown>[]> {
	const all: Experience[] = [];
	for (const type of EXPERIENCE_TYPES) {
		all.push(...(await store.listActive(type, Number.MAX_SAFE_INTEGER)));
	}
	all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	// JSON round-trip drops undefined fields, which canonicalJson rejects.
	return all.map((entry) => JSON.parse(JSON.stringify(entry)) as Record<string, unknown>);
}

/**
 * Build an immutable snapshot of the store's active experience library and
 * store it in the registry. Returns the snapshot metadata. Rebuilding over
 * unchanged content returns the same artifactId (CAS no-op).
 */
export async function buildExperienceSnapshot(
	store: ExperienceStore,
	registry: ArtifactRegistry,
): Promise<ExperienceSnapshot> {
	const entries = await collectActiveEntries(store);
	const sourceDbSha = sha256Hex(canonicalJson(entries));

	const payload: SnapshotPayload = {
		entry_count: entries.length,
		source_db_sha: sourceDbSha,
		entries,
	};
	const blob = Buffer.from(canonicalJson(payload), "utf8");

	const manifest: ArtifactManifest = {
		kind: EXPERIENCE_SNAPSHOT_KIND,
		parent_ids: [],
		operator: "draft",
		scope: ["experience"],
		evidence_refs: ["experience-store"],
		scaffold_hash: NO_SCAFFOLD_SENTINEL,
		// Snapshots are not model-generated; the fingerprint slot records the
		// builder provenance instead of a sampling contract.
		model_fingerprint: JSON.stringify({ source: "experience_snapshot_builder" }),
		// Experience payloads carry user/session content, so the bundle cannot be
		// classified as diagnostic_ops.
		data_class: "user_content",
		retention_policy_ref: "pending_0b",
		blob_hashes: [sha256Hex(blob)],
	};

	const artifactId = registry.storeArtifact(manifest, [blob]);
	return {
		kind: EXPERIENCE_SNAPSHOT_KIND,
		snapshotId: artifactId,
		artifactId,
		createdAt: new Date().toISOString(),
		entryCount: entries.length,
		sourceDbSha,
	};
}

/**
 * Fetch the most recent experience snapshot artifact from the registry, or
 * null when none exists. entryCount/sourceDbSha are read back from the
 * verified blob (fetchBundle re-hashes blobs, fail closed on mismatch).
 */
export function getLatestSnapshot(registry: ArtifactRegistry): Promise<ExperienceSnapshot | null> {
	const row = registry.db
		.prepare(
			`SELECT artifact_id, created_at FROM artifact_immutable_manifests
			WHERE kind = 'experience_snapshot'
			ORDER BY created_at DESC, artifact_id DESC LIMIT 1`,
		)
		.get() as SnapshotRow | undefined;
	if (!row) {
		return Promise.resolve(null);
	}
	const { blobs } = registry.fetchBundle(row.artifact_id);
	const payload = JSON.parse(blobs[0].toString("utf8")) as SnapshotPayload;
	return Promise.resolve({
		kind: EXPERIENCE_SNAPSHOT_KIND,
		snapshotId: row.artifact_id,
		artifactId: row.artifact_id,
		createdAt: new Date(row.created_at).toISOString(),
		entryCount: payload.entry_count,
		sourceDbSha: payload.source_db_sha,
	});
}
