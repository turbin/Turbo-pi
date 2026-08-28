import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { canonicalJson, computeArtifactId } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import {
	buildExperienceSnapshot,
	EXPERIENCE_SNAPSHOT_KIND,
	getLatestSnapshot,
} from "../../src/evolution/experience-snapshot-builder.ts";
import { ExperienceStore } from "../../src/experience-store.ts";
import type { Experience } from "../../src/types.ts";

function makeExperience(id: string, overrides: Partial<Experience> = {}): Experience {
	return {
		id,
		type: "SKILL",
		title: `title-${id}`,
		payload: { text: `payload-${id}` },
		quality: 0.8,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: `entry-${id}`,
		contentHash: `hash-${id}`,
		createdAt: "2026-08-28T00:00:00.000Z",
		...overrides,
	};
}

describe("experience snapshot builder", () => {
	let baseDir: string;
	let store: ExperienceStore;
	let registry: ArtifactRegistry;

	beforeEach(async () => {
		baseDir = mkdtempSync(join(tmpdir(), "exp-snapshot-"));
		store = new ExperienceStore(join(baseDir, "experience-store.db"));
		await store.initSchema();
		const evo = openEvolutionDb(join(baseDir, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(baseDir, "blobs"));
	});

	afterEach(() => {
		registry.close();
		store.close();
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("creates a snapshot from a populated store", async () => {
		await store.insert(makeExperience("b-2", { type: "SOP" }));
		await store.insert(makeExperience("a-1"));
		await store.insert(makeExperience("x-3", { status: "dormant" }));

		const snapshot = await buildExperienceSnapshot(store, registry);

		expect(snapshot.kind).toBe(EXPERIENCE_SNAPSHOT_KIND);
		expect(snapshot.artifactId).toMatch(/^[0-9a-f]{64}$/);
		expect(snapshot.snapshotId).toBe(snapshot.artifactId);
		expect(snapshot.sourceDbSha).toMatch(/^[0-9a-f]{64}$/);
		// Only active entries are captured, across all types.
		expect(snapshot.entryCount).toBe(2);

		const manifest = registry.readManifest(snapshot.artifactId);
		expect(manifest.kind).toBe("experience_snapshot");
		expect(manifest.parent_ids).toEqual([]);
		expect(manifest.operator).toBe("draft");
		expect(manifest.scope).toEqual(["experience"]);
		expect(manifest.evidence_refs).toEqual(["experience-store"]);
		expect(manifest.retention_policy_ref).toBe("pending_0b");
		expect(snapshot.artifactId).toBe(computeArtifactId(manifest));

		const { blobs } = registry.fetchBundle(snapshot.artifactId);
		expect(blobs).toHaveLength(1);
		const payload = JSON.parse(blobs[0].toString("utf8")) as {
			entry_count: number;
			source_db_sha: string;
			entries: { id: string }[];
		};
		expect(payload.entry_count).toBe(2);
		expect(payload.source_db_sha).toBe(snapshot.sourceDbSha);
		// Entries are sorted by id for deterministic serialization.
		expect(payload.entries.map((e) => e.id)).toEqual(["a-1", "b-2"]);
		// The blob is canonical JSON (parse -> canonicalJson round-trips byte-exact).
		expect(canonicalJson(JSON.parse(blobs[0].toString("utf8")))).toBe(blobs[0].toString("utf8"));
	});

	it("produces a valid snapshot with entryCount 0 from an empty store", async () => {
		const snapshot = await buildExperienceSnapshot(store, registry);

		expect(snapshot.entryCount).toBe(0);
		expect(snapshot.artifactId).toMatch(/^[0-9a-f]{64}$/);

		const { blobs } = registry.fetchBundle(snapshot.artifactId);
		const payload = JSON.parse(blobs[0].toString("utf8")) as { entry_count: number; entries: unknown[] };
		expect(payload.entry_count).toBe(0);
		expect(payload.entries).toEqual([]);
	});

	it("is immutable: rebuilding unchanged content reproduces the same artifact_id", async () => {
		await store.insert(makeExperience("a-1"));

		const first = await buildExperienceSnapshot(store, registry);
		const second = await buildExperienceSnapshot(store, registry);
		expect(second.artifactId).toBe(first.artifactId);
		expect(second.sourceDbSha).toBe(first.sourceDbSha);

		// Any library change produces a new version.
		await store.insert(makeExperience("b-2"));
		const third = await buildExperienceSnapshot(store, registry);
		expect(third.artifactId).not.toBe(first.artifactId);
		expect(third.entryCount).toBe(2);
	});

	it("getLatestSnapshot returns null when no snapshot exists", async () => {
		expect(await getLatestSnapshot(registry)).toBeNull();
	});

	it("getLatestSnapshot returns the most recent snapshot", async () => {
		await store.insert(makeExperience("a-1"));
		const first = await buildExperienceSnapshot(store, registry);
		// Force distinct created_at so "latest" ordering is unambiguous.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await store.insert(makeExperience("b-2"));
		const second = await buildExperienceSnapshot(store, registry);

		const latest = await getLatestSnapshot(registry);
		expect(latest).not.toBeNull();
		expect(latest?.artifactId).toBe(second.artifactId);
		expect(latest?.artifactId).not.toBe(first.artifactId);
		expect(latest?.entryCount).toBe(2);
		expect(latest?.sourceDbSha).toBe(second.sourceDbSha);
	});
});
