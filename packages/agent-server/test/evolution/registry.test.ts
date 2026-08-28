import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ArtifactRegistry,
	CasConflictError,
	openArtifactRegistry,
} from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { buildGenerationZeroBundle, type FrozenFingerprints } from "../../src/evolution/bundle-builder.ts";
import { computeArtifactId } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";

function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function makeManifest(blobHashes: string[]): ArtifactManifest {
	return {
		kind: "experience_snapshot",
		parent_ids: [],
		operator: "draft",
		scope: ["frozen-path-list"],
		evidence_refs: ["doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md"],
		scaffold_hash: "0".repeat(64),
		model_fingerprint: JSON.stringify({ model: "faux", temperature: 0 }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: blobHashes,
	};
}

describe("artifact registry", () => {
	let dbPath: string;
	let blobsDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		const base = mkdtempSync(join(tmpdir(), "evo-registry-"));
		dbPath = join(base, "evolution.db");
		blobsDir = join(base, "blobs");
		const db = openEvolutionDb(dbPath);
		registry = openArtifactRegistry(db.db, blobsDir);
	});

	afterEach(() => {
		const base = dbPath.replace(/\/evolution\.db$/, "");
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("stores manifest and blobs and returns the content-addressed artifact_id", () => {
		const blob = Buffer.from("hello-gen0");
		const manifest = makeManifest([sha256Hex(blob)]);
		const artifactId = registry.storeArtifact(manifest, [blob]);
		expect(artifactId).toBe(computeArtifactId(manifest));
		expect(artifactId).toMatch(/^[0-9a-f]{64}$/);
	});

	it("fetchBundle returns blobs and verifies every blob SHA256", () => {
		const blobA = Buffer.from("blob-a");
		const blobB = Buffer.from("blob-b");
		const manifest = makeManifest([sha256Hex(blobA), sha256Hex(blobB)]);
		const artifactId = registry.storeArtifact(manifest, [blobA, blobB]);
		const bundle = registry.fetchBundle(artifactId);
		expect(bundle.manifest).toEqual(manifest);
		expect(bundle.blobs.map((b) => b.toString())).toEqual(["blob-a", "blob-b"]);
	});

	it("fetchBundle rejects activation when a blob SHA256 does not match", () => {
		const blob = Buffer.from("real-blob");
		const manifest = makeManifest([sha256Hex(blob)]);
		const artifactId = registry.storeArtifact(manifest, [blob]);
		// corrupt the on-disk blob
		writeFileSync(join(blobsDir, sha256Hex(blob)), Buffer.from("corrupted"));
		expect(() => registry.fetchBundle(artifactId)).toThrow(/blob sha256 mismatch/);
	});

	it("refuses CAS conflict: same artifact_id with different content", () => {
		const blobA = Buffer.from("content-a");
		const manifestA = makeManifest([sha256Hex(blobA)]);
		const artifactId = "0000000000000000000000000000000000000000000000000000000000000000";
		registry.storeArtifactWithId(artifactId, manifestA, [blobA]);

		const blobB = Buffer.from("content-b");
		const manifestB = { ...manifestA, scaffold_hash: "9".repeat(64), blob_hashes: [sha256Hex(blobB)] };

		expect(() => registry.storeArtifactWithId(artifactId, manifestB, [blobB])).toThrow(CasConflictError);
	});

	it("records a committed conflict event in the journal on CAS conflict", () => {
		const blobA = Buffer.from("content-a");
		const manifestA = makeManifest([sha256Hex(blobA)]);
		const artifactId = "0000000000000000000000000000000000000000000000000000000000000001";
		registry.storeArtifactWithId(artifactId, manifestA, [blobA]);

		const blobB = Buffer.from("content-b");
		const manifestB = { ...manifestA, scaffold_hash: "9".repeat(64), blob_hashes: [sha256Hex(blobB)] };

		try {
			registry.storeArtifactWithId(artifactId, manifestB, [blobB]);
		} catch {
			/* expected */
		}
		const rows = registry.db
			.prepare("SELECT operation, state FROM evolution_journal WHERE operation = ?")
			.all("store_artifact_conflict") as Array<{ operation: string; state: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe("committed");
	});

	it("readManifest returns the parsed manifest for an existing artifact", () => {
		const blob = Buffer.from("blob");
		const manifest = makeManifest([sha256Hex(blob)]);
		const artifactId = registry.storeArtifact(manifest, [blob]);
		expect(registry.readManifest(artifactId)).toEqual(manifest);
	});
});

describe("generation-0 bundle builder", () => {
	let dbPath: string;
	let blobsDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		const base = mkdtempSync(join(tmpdir(), "evo-gen0-"));
		dbPath = join(base, "evolution.db");
		blobsDir = join(base, "blobs");
		const db = openEvolutionDb(dbPath);
		registry = openArtifactRegistry(db.db, blobsDir);
	});

	afterEach(() => {
		const base = dbPath.replace(/\/evolution\.db$/, "");
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	function validFingerprints(): FrozenFingerprints {
		return {
			scaffold_hash: "0".repeat(64),
			experience_snapshot_sha: "1".repeat(64),
			model_fingerprint: JSON.stringify({ provider: "faux", model: "faux" }),
			config_fingerprint: "2".repeat(64),
			denylist_version: "m0-initial",
		};
	}

	it("builds a gen0 bundle with operator=draft, empty parents, pending_0b retention", () => {
		const result = buildGenerationZeroBundle(registry, validFingerprints(), "contract-0");
		expect(result.manifest.operator).toBe("draft");
		expect(result.manifest.parent_ids).toEqual([]);
		expect(result.manifest.retention_policy_ref).toBe("pending_0b");
		expect(result.manifest.evidence_refs).toContain(
			"doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md",
		);
		expect(result.artifactId).toBe(computeArtifactId(result.manifest));
	});

	it("rejects gen0 build when any fingerprint is missing", () => {
		for (const key of Object.keys(validFingerprints()) as Array<keyof FrozenFingerprints>) {
			const bad = { ...validFingerprints(), [key]: "" };
			expect(() => buildGenerationZeroBundle(registry, bad, "contract-0")).toThrow(/missing fingerprint/);
		}
	});

	it("gen0 bundle blobs are deterministic and loadable", () => {
		const result = buildGenerationZeroBundle(registry, validFingerprints(), "contract-0");
		const loaded = registry.fetchBundle(result.artifactId);
		expect(loaded.manifest).toEqual(result.manifest);
		expect(loaded.blobs.length).toBe(result.blobs.length);
	});
});
