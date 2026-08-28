import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import {
	type CandidateGenerationInput,
	generateExperienceCandidate,
	SNAPSHOT_BLOB_FORMAT,
	type SnapshotEntry,
} from "../../src/evolution/candidate-generator.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { buildExperienceSnapshot } from "../../src/evolution/experience-snapshot-builder.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { ExperienceStore } from "../../src/experience-store.ts";
import type { Experience } from "../../src/types.ts";

function makeExperience(overrides: Partial<Experience>): Experience {
	return {
		id: overrides.id ?? "exp-1",
		type: overrides.type ?? "EVIDENCE",
		title: overrides.title ?? "title-1",
		payload: overrides.payload ?? { text: `text-${overrides.id ?? "exp-1"}` },
		quality: overrides.quality ?? 0.5,
		confidence: overrides.confidence ?? 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: "entry-1",
		contentHash: overrides.contentHash ?? `hash-${overrides.id ?? "exp-1"}`,
		createdAt: new Date().toISOString(),
	};
}

function readSnapshotEntries(registry: ArtifactRegistry, artifactId: string): SnapshotEntry[] {
	const bundle = registry.fetchBundle(artifactId);
	const blob = JSON.parse(bundle.blobs[0].toString("utf8")) as { format: string; entries: SnapshotEntry[] };
	expect(blob.format).toBe(SNAPSHOT_BLOB_FORMAT);
	return blob.entries;
}

describe("candidate generator (P2-T24)", () => {
	let base: string;
	let store: ExperienceStore;
	let registry: ArtifactRegistry;
	let lineage: LineageTracker;

	beforeEach(async () => {
		base = mkdtempSync(join(tmpdir(), "evo-candidate-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
		store = new ExperienceStore(":memory:");
		await store.initSchema();
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	async function seedDraft(input: Partial<CandidateGenerationInput> = {}) {
		const result = await generateExperienceCandidate(store, registry, lineage, {
			operator: "draft",
			evidenceRefs: ["trace-1"],
			...input,
		});
		expect(result.status).toBe("generated");
		return result;
	}

	it("draft candidate generation produces a valid artifact", async () => {
		await store.insert(makeExperience({ id: "a", quality: 0.9, contentHash: "h1" }));
		await store.insert(makeExperience({ id: "b", quality: 0.4, contentHash: "h2" }));
		// duplicate content hash must be deduped, keeping the higher quality
		await store.insert(makeExperience({ id: "c", quality: 0.7, contentHash: "h1" }));
		await store.insert(makeExperience({ id: "d", type: "SKILL", quality: 0.6, contentHash: "h3" }));

		const result = await generateExperienceCandidate(store, registry, lineage, {
			operator: "draft",
			evidenceRefs: ["trace-1", "issue-2"],
		});

		expect(result.status).toBe("generated");
		expect(result.candidateId).toMatch(/^cand-[0-9a-f]{32}$/);
		expect(result.parentIds).toEqual([]);
		expect(result.error).toBeUndefined();

		const manifest = registry.readManifest(result.snapshotArtifactId);
		expect(manifest.kind).toBe("experience_snapshot");
		expect(manifest.operator).toBe("draft");
		expect(manifest.parent_ids).toEqual([]);
		expect(manifest.evidence_refs).toEqual(["trace-1", "issue-2"]);
		expect(manifest.retention_policy_ref).toBe("pending_0b");

		const entries = readSnapshotEntries(registry, result.snapshotArtifactId);
		expect(entries.map((e) => e.id)).toEqual(["a", "d", "b"]); // quality desc, h1 deduped keeps "a" (0.9)
	});

	it("draft respects the entry budget", async () => {
		for (let i = 0; i < 5; i++) {
			await store.insert(makeExperience({ id: `e${i}`, quality: 0.1 * (i + 1), contentHash: `h${i}` }));
		}
		const result = await seedDraft({ budget: 2 });
		const entries = readSnapshotEntries(registry, result.snapshotArtifactId);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.quality)).toEqual([0.5, 0.4]);
	});

	it("improve candidate references its parent in lineage", async () => {
		await store.insert(makeExperience({ id: "a", quality: 0.9, contentHash: "h1" }));
		await store.insert(makeExperience({ id: "b", quality: 0.4, contentHash: "h2" }));
		const parent = await seedDraft();

		const result = await generateExperienceCandidate(store, registry, lineage, {
			parentSnapshotId: parent.snapshotArtifactId,
			operator: "improve",
			evidenceRefs: ["cluster-9"],
		});

		expect(result.status).toBe("generated");
		expect(result.parentIds).toEqual([parent.snapshotArtifactId]);
		expect(registry.readManifest(result.snapshotArtifactId).parent_ids).toEqual([parent.snapshotArtifactId]);

		const edges = lineage.getParents(result.snapshotArtifactId);
		expect(edges).toHaveLength(1);
		expect(edges[0].parentId).toBe(parent.snapshotArtifactId);
		expect(edges[0].childId).toBe(result.snapshotArtifactId);
		expect(edges[0].operator).toBe("improve");
	});

	it("consolidate merges same-title entries and references its parent in lineage", async () => {
		await store.insert(makeExperience({ id: "a", title: "same", quality: 0.9, contentHash: "h1" }));
		await store.insert(makeExperience({ id: "b", title: "same", quality: 0.3, contentHash: "h2" }));
		await store.insert(makeExperience({ id: "c", title: "other", quality: 0.5, contentHash: "h3" }));
		const parent = await seedDraft();

		const result = await generateExperienceCandidate(store, registry, lineage, {
			parentSnapshotId: parent.snapshotArtifactId,
			operator: "consolidate",
			evidenceRefs: ["cluster-1"],
		});

		expect(result.status).toBe("generated");
		const entries = readSnapshotEntries(registry, result.snapshotArtifactId);
		expect(entries.map((e) => e.id)).toEqual(["a", "c"]); // "same" merged to best-quality entry

		const edges = lineage.getParents(result.snapshotArtifactId);
		expect(edges).toHaveLength(1);
		expect(edges[0].parentId).toBe(parent.snapshotArtifactId);
		expect(edges[0].operator).toBe("consolidate");
		// children view agrees with the parents view
		const children = lineage.getChildren(parent.snapshotArtifactId);
		expect(children.map((e) => e.childId)).toEqual([result.snapshotArtifactId]);
	});

	it("improve/consolidate without a parent fail with status failed", async () => {
		for (const operator of ["improve", "consolidate"] as const) {
			const result = await generateExperienceCandidate(store, registry, lineage, {
				operator,
				evidenceRefs: ["trace-1"],
			});
			expect(result.status).toBe("failed");
			expect(result.snapshotArtifactId).toBe("");
			expect(result.error).toContain("requires parentSnapshotId");
		}
	});

	it("failed generation returns status failed with error and records nothing", async () => {
		const missing = "f".repeat(64);
		const result = await generateExperienceCandidate(store, registry, lineage, {
			parentSnapshotId: missing,
			operator: "improve",
			evidenceRefs: ["trace-1"],
		});

		expect(result.status).toBe("failed");
		expect(result.snapshotArtifactId).toBe("");
		expect(result.error).toContain(missing);
		expect(result.parentIds).toEqual([missing]);
		// no artifact stored, no lineage edge recorded
		expect(() => registry.readManifest(missing)).toThrow(/not found/);
		expect(lineage.getChildren(missing)).toEqual([]);
	});

	it("rejects a parent artifact of the wrong kind", async () => {
		const parent = await seedDraft();
		const parentManifest = registry.readManifest(parent.snapshotArtifactId);
		const wrongKind = { ...parentManifest, kind: "composite" as const };
		const bundle = registry.fetchBundle(parent.snapshotArtifactId);
		const wrongId = registry.storeArtifact(wrongKind, bundle.blobs);

		const result = await generateExperienceCandidate(store, registry, lineage, {
			parentSnapshotId: wrongId,
			operator: "improve",
			evidenceRefs: ["trace-1"],
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("expected experience_snapshot");
	});

	it("improve accepts a T22 builder snapshot as parent", async () => {
		await store.insert(makeExperience({ id: "a", quality: 0.9, contentHash: "h1" }));
		await store.insert(makeExperience({ id: "b", quality: 0.4, contentHash: "h2" }));
		const parent = await buildExperienceSnapshot(store, registry);

		const result = await generateExperienceCandidate(store, registry, lineage, {
			parentSnapshotId: parent.artifactId,
			operator: "improve",
			evidenceRefs: ["cluster-7"],
		});

		expect(result.status).toBe("generated");
		const entries = readSnapshotEntries(registry, result.snapshotArtifactId);
		expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
		const edges = lineage.getParents(result.snapshotArtifactId);
		expect(edges).toHaveLength(1);
		expect(edges[0].parentId).toBe(parent.artifactId);
		expect(edges[0].operator).toBe("improve");
	});

	it("rejects an invalid budget", async () => {
		const result = await generateExperienceCandidate(store, registry, lineage, {
			operator: "draft",
			evidenceRefs: [],
			budget: 0,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("budget");
	});
});
