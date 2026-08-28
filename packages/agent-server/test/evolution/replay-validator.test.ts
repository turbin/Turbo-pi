import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { canonicalJson, sha256Hex } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { replayCandidate, validateCandidate } from "../../src/evolution/replay-validator.ts";

const FIXED_NOW = "2026-08-28T00:00:00.000Z";

type Row = {
	id: string;
	quality: number;
	contentHash: string;
};

function row(id: string, quality: number, contentHash: string): Row {
	return { id, quality, contentHash };
}

/** Store a snapshot artifact in the T24 ({format, entries}) or T22 ({entry_count, ...}) blob format. */
function storeSnapshot(registry: ArtifactRegistry, entries: Record<string, unknown>[], format: "t22" | "t24"): string {
	const payload =
		format === "t24"
			? { format: "experience-snapshot/v1", entries }
			: { entry_count: entries.length, source_db_sha: sha256Hex("test-source-db"), entries };
	const blob = Buffer.from(canonicalJson(payload), "utf8");
	const manifest: ArtifactManifest = {
		kind: "experience_snapshot",
		parent_ids: [],
		operator: "draft",
		scope: ["experience"],
		evidence_refs: ["test"],
		scaffold_hash: sha256Hex("replay-validator-test/scaffold"),
		model_fingerprint: JSON.stringify({ model: "deterministic-mock", temperature: 0 }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [sha256Hex(blob.toString("utf8"))],
	};
	return registry.storeArtifact(manifest, [blob]);
}

describe("replay validator (P2-T25)", () => {
	let base: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-replay-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("passes when the candidate improves quality and keeps all baseline hashes", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.4, "h1"), row("b", 0.6, "h2")], "t24");
		const candidateId = storeSnapshot(
			registry,
			[row("a", 0.7, "h1"), row("b", 0.8, "h2"), row("c", 0.9, "h3")],
			"t24",
		);

		const result = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });

		expect(result.verdict).toBe("pass");
		expect(result.candidateId).toBe(candidateId);
		expect(result.baselineId).toBe(baselineId);
		expect(result.timestamp).toBe(FIXED_NOW);
		expect(result.metrics.candidate?.entryCount).toBe(3);
		expect(result.metrics.baseline?.entryCount).toBe(2);
		expect(result.metrics.contentHashOverlap).toBe(1);
		expect(result.metrics.lostContentHashes).toBe(0);
		expect(result.metrics.meanQualityDelta).toBeCloseTo(0.3, 9);
		expect(result.metrics.minQualityDelta).toBeCloseTo(0.3, 9);
		expect(result.metrics.candidate?.qualityDistribution["0.6-0.8"]).toBe(1);
		expect(result.metrics.candidate?.qualityDistribution["0.8-1.0"]).toBe(2);
	});

	it("rejects when the candidate regresses (lost hash and lower quality)", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.8, "h1"), row("b", 0.9, "h2")], "t24");
		const candidateId = storeSnapshot(registry, [row("a", 0.3, "h1")], "t24");

		const result = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });

		expect(result.verdict).toBe("reject");
		expect(result.metrics.lostContentHashes).toBe(1);
		expect(result.metrics.contentHashOverlap).toBe(0.5);
		expect(result.metrics.meanQualityDelta).toBeLessThan(0);
	});

	it("is inconclusive when the snapshot data is insufficient", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.8, "h1")], "t24");
		const emptyId = storeSnapshot(registry, [], "t24");

		expect((await replayCandidate(emptyId, baselineId, registry, { now: FIXED_NOW })).verdict).toBe("inconclusive");
		expect((await replayCandidate(baselineId, emptyId, registry, { now: FIXED_NOW })).verdict).toBe("inconclusive");

		const missing = "f".repeat(64);
		const result = await replayCandidate(missing, baselineId, registry, { now: FIXED_NOW });
		expect(result.verdict).toBe("inconclusive");
		expect(result.metrics.candidate).toBeNull();
		expect(result.metrics.baseline?.entryCount).toBe(1);
	});

	it("returns deterministic results for the same input", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.5, "h1"), row("b", 0.5, "h2")], "t24");
		const candidateId = storeSnapshot(registry, [row("a", 0.6, "h1"), row("b", 0.6, "h2")], "t24");

		const first = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });
		const second = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });

		expect(first).toEqual(second);
		expect(first.verdict).toBe("pass");
	});

	it("handles mixed T22 baseline and T24 candidate formats", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.4, "h1"), row("b", 0.5, "h2")], "t22");
		const candidateId = storeSnapshot(registry, [row("a", 0.9, "h1"), row("b", 0.9, "h2")], "t24");

		const result = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });

		expect(result.verdict).toBe("pass");
		expect(result.metrics.contentHashOverlap).toBe(1);
		expect(result.metrics.meanQualityDelta).toBeCloseTo(0.45, 9);
	});

	it("rejects a T22 candidate whose quality regresses against a T22 baseline", async () => {
		const baselineId = storeSnapshot(registry, [row("a", 0.8, "h1")], "t22");
		const candidateId = storeSnapshot(registry, [row("a", 0.8, "h1"), row("b", 0.1, "h2")], "t22");

		const result = await replayCandidate(candidateId, baselineId, registry, { now: FIXED_NOW });

		expect(result.verdict).toBe("reject"); // minQuality regressed 0.8 -> 0.1
		expect(result.metrics.lostContentHashes).toBe(0);
		expect(result.metrics.minQualityDelta).toBeCloseTo(-0.7, 9);
	});

	it("validateCandidate passes a well-formed snapshot", async () => {
		const candidateId = storeSnapshot(registry, [row("a", 0.7, "h1"), row("b", 0.8, "h2")], "t22");

		const result = await validateCandidate(candidateId, registry, { now: FIXED_NOW });

		expect(result.verdict).toBe("pass");
		expect(result.baselineId).toBeNull();
		expect(result.metrics.baseline).toBeNull();
		expect(result.metrics.candidate?.distinctContentHashes).toBe(2);
	});

	it("validateCandidate rejects invalid entries and count mismatches", async () => {
		const invalidQuality = storeSnapshot(registry, [row("a", 1.5, "h1")], "t24");
		expect((await validateCandidate(invalidQuality, registry, { now: FIXED_NOW })).verdict).toBe("reject");

		// T22 declared entry_count inconsistent with the actual entries array.
		const blob = Buffer.from(
			canonicalJson({ entry_count: 5, source_db_sha: sha256Hex("db"), entries: [row("a", 0.5, "h1")] }),
			"utf8",
		);
		const mismatchId = registry.storeArtifact(
			{
				kind: "experience_snapshot",
				parent_ids: [],
				operator: "draft",
				scope: ["experience"],
				evidence_refs: ["test"],
				scaffold_hash: sha256Hex("replay-validator-test/scaffold"),
				model_fingerprint: JSON.stringify({ model: "deterministic-mock" }),
				data_class: "diagnostic_ops",
				retention_policy_ref: "pending_0b",
				blob_hashes: [sha256Hex(blob.toString("utf8"))],
			},
			[blob],
		);
		const result = await validateCandidate(mismatchId, registry, { now: FIXED_NOW });
		expect(result.verdict).toBe("reject");
	});

	it("validateCandidate is inconclusive for empty or missing snapshots", async () => {
		const emptyId = storeSnapshot(registry, [], "t24");
		expect((await validateCandidate(emptyId, registry, { now: FIXED_NOW })).verdict).toBe("inconclusive");
		expect((await validateCandidate("e".repeat(64), registry, { now: FIXED_NOW })).verdict).toBe("inconclusive");
	});
});
