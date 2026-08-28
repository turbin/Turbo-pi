import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { AppendOnlyDao } from "./append-only-dao.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { validateManifest } from "./artifact-schema.ts";
import { canonicalJson, computeArtifactId } from "./canonical.ts";

/**
 * T3: artifact registry — content-addressed bundle storage.
 *
 * Responsibilities:
 * - validate every manifest before storage (fail closed);
 * - compute artifact_id per the frozen canonical contract (T2);
 * - store blobs in a content-addressed file pool;
 * - enforce CAS: an existing artifact_id must map to the exact same canonical
 *   manifest and blob_hashes; any mismatch is a conflict, rejected, and logged
 *   as a committed journal event (architecture §3.3 / A6).
 * - fetchBundle verifies every blob SHA256 before returning it; mismatch -> fail closed.
 */

export class CasConflictError extends Error {
	readonly artifactId: string;

	constructor(artifactId: string) {
		super(`CAS conflict: artifact_id ${artifactId} already exists with different content`);
		this.name = "CasConflictError";
		this.artifactId = artifactId;
	}
}

export class BlobMismatchError extends Error {
	readonly blobHash: string;

	constructor(blobHash: string) {
		super(`blob sha256 mismatch: expected ${blobHash}`);
		this.name = "BlobMismatchError";
		this.blobHash = blobHash;
	}
}

export interface StoredBundle {
	manifest: ArtifactManifest;
	blobs: Buffer[];
}

export interface ArtifactRegistry {
	readonly db: Database.Database;
	readonly blobsDir: string;
	storeArtifact(manifest: ArtifactManifest, blobs: Buffer[]): string;
	/**
	 * Test/internal entry point: store under an explicit artifact_id instead of
	 * computing it from the manifest. Used by CAS-conflict tests (two different
	 * contents forced to the same id). Production callers must use storeArtifact.
	 */
	storeArtifactWithId(artifactId: string, manifest: ArtifactManifest, blobs: Buffer[]): string;
	fetchBundle(artifactId: string): StoredBundle;
	readManifest(artifactId: string): ArtifactManifest;
	close(): void;
}

interface ArtifactRow {
	artifact_id: string;
	canonical_manifest: string;
	blob_hashes: string;
}

export function openArtifactRegistry(db: Database.Database, blobsDir: string): ArtifactRegistry {
	mkdirSync(blobsDir, { recursive: true });
	const dao = new AppendOnlyDao(db);

	const readRow = (artifactId: string): ArtifactRow | undefined => {
		return db
			.prepare(
				"SELECT artifact_id, canonical_manifest, blob_hashes FROM artifact_immutable_manifests WHERE artifact_id = ?",
			)
			.get(artifactId) as ArtifactRow | undefined;
	};

	const blobSha256 = (data: Buffer): string => {
		return createHash("sha256").update(data).digest("hex");
	};

	const writeBlob = (data: Buffer): string => {
		const hash = blobSha256(data);
		const path = `${blobsDir}/${hash}`;
		if (!existsSync(path)) {
			writeFileSync(path, data);
		}
		return hash;
	};

	const readBlob = (hash: string): Buffer => {
		return readFileSync(`${blobsDir}/${hash}`);
	};

	const storeWithId = (artifactId: string, manifest: ArtifactManifest, blobs: Buffer[]): string => {
		if (manifest.blob_hashes.length !== blobs.length) {
			throw new Error(
				`blob count mismatch: manifest declares ${manifest.blob_hashes.length} blobs, received ${blobs.length}`,
			);
		}
		for (let i = 0; i < blobs.length; i++) {
			const declared = manifest.blob_hashes[i];
			const actual = blobSha256(blobs[i]);
			if (actual !== declared) {
				throw new BlobMismatchError(declared);
			}
		}

		const canonicalManifestText = canonicalJson(manifest);
		const blobHashesText = canonicalJson(manifest.blob_hashes);

		const existing = readRow(artifactId);
		if (existing) {
			if (existing.canonical_manifest !== canonicalManifestText || existing.blob_hashes !== blobHashesText) {
				dao.appendJournal({
					operation: "store_artifact_conflict",
					payloadHash: createHash("sha256").update(canonicalManifestText, "utf8").digest("hex"),
					state: "committed",
					createdAt: Date.now(),
				});
				throw new CasConflictError(artifactId);
			}
			return artifactId;
		}

		for (const blob of blobs) {
			writeBlob(blob);
		}

		dao.appendArtifact({
			artifactId,
			kind: manifest.kind,
			parentIds: manifest.parent_ids,
			operator: manifest.operator,
			scope: JSON.stringify(manifest.scope),
			evidenceRefs: manifest.evidence_refs,
			scaffoldHash: manifest.scaffold_hash,
			modelFingerprint: manifest.model_fingerprint,
			dataClass: manifest.data_class,
			retentionPolicyRef: manifest.retention_policy_ref,
			blobHashes: manifest.blob_hashes,
			canonicalManifest: canonicalManifestText,
			createdAt: Date.now(),
		});
		return artifactId;
	};

	return {
		db,
		blobsDir,

		storeArtifact(manifest: ArtifactManifest, blobs: Buffer[]): string {
			const validation = validateManifest(manifest);
			if (!validation.ok) {
				throw new Error(`manifest validation failed: ${validation.errors.join("; ")}`);
			}
			return storeWithId(computeArtifactId(manifest), manifest, blobs);
		},

		storeArtifactWithId(artifactId: string, manifest: ArtifactManifest, blobs: Buffer[]): string {
			const validation = validateManifest(manifest);
			if (!validation.ok) {
				throw new Error(`manifest validation failed: ${validation.errors.join("; ")}`);
			}
			return storeWithId(artifactId, manifest, blobs);
		},

		fetchBundle(artifactId: string): StoredBundle {
			const row = readRow(artifactId);
			if (!row) {
				throw new Error(`artifact not found: ${artifactId}`);
			}
			const manifest = JSON.parse(row.canonical_manifest) as ArtifactManifest;
			const blobs: Buffer[] = [];
			for (const hash of JSON.parse(row.blob_hashes) as string[]) {
				const data = readBlob(hash);
				const actual = blobSha256(data);
				if (actual !== hash) {
					throw new BlobMismatchError(hash);
				}
				blobs.push(data);
			}
			return { manifest, blobs };
		},

		readManifest(artifactId: string): ArtifactManifest {
			const row = readRow(artifactId);
			if (!row) {
				throw new Error(`artifact not found: ${artifactId}`);
			}
			return JSON.parse(row.canonical_manifest) as ArtifactManifest;
		},

		close(): void {
			db.close();
		},
	};
}
