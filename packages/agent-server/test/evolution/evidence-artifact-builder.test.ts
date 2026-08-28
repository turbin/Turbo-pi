import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { validateManifest } from "../../src/evolution/artifact-schema.ts";
import { canonicalJson, computeArtifactId } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import {
	buildEvidenceArtifact,
	type EvidenceArtifactInput,
	storeEvidenceArtifact,
} from "../../src/evolution/evidence-artifact-builder.ts";

function makeInput(): EvidenceArtifactInput {
	return {
		taskId: "task-001",
		versionContract: {
			artifactId: "b".repeat(64),
			scaffoldHash: "c".repeat(64),
			snapshotSha: "d".repeat(64),
		},
		toolEvents: [
			{
				toolName: "read",
				argsHash: "1".repeat(64),
				resultHash: "2".repeat(64),
				durationMs: 12,
				timestamp: 1_700_000_000_000,
			},
			{
				toolName: "bash",
				argsHash: "3".repeat(64),
				resultHash: "4".repeat(64),
				durationMs: 350,
				error: "exit code 1",
				timestamp: 1_700_000_001_000,
			},
		],
		productManifest: [{ path: "src/index.ts", sizeBytes: 128, sha256: "5".repeat(64), mtimeMs: 1_700_000_002_000 }],
		graderOutcomes: [
			{
				taskId: "task-001",
				outcome: "success",
				graderSha: "6".repeat(64),
				score: 1,
				timestamp: "2026-08-28T00:00:00.000Z",
			},
		],
		userCorrections: [
			{
				taskId: "task-001",
				correctionType: "explicit",
				content: "use tabs, not spaces",
				timestamp: "2026-08-28T00:01:00.000Z",
			},
		],
		escalationJoinKeys: [{ gatewaySequence: 42, qualitySignalsSha: "7".repeat(64) }],
	};
}

describe("evidence artifact builder", () => {
	let baseDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "evo-evidence-"));
		const db = openEvolutionDb(join(baseDir, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(baseDir, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("builds a valid composite artifact manifest", () => {
		const input = makeInput();
		const { manifest, blobs } = buildEvidenceArtifact(input);

		expect(manifest.kind).toBe("composite");
		expect(manifest.parent_ids).toEqual([]);
		expect(manifest.operator).toBe("draft");
		expect(manifest.scope).toEqual(["evidence"]);
		expect(manifest.retention_policy_ref).toBe("pending_0b");
		expect(manifest.scaffold_hash).toBe(input.versionContract.scaffoldHash);
		expect(manifest.evidence_refs).toContain("task:task-001");
		expect(manifest.evidence_refs).toContain("tool_events:2");
		expect(manifest.evidence_refs).toContain("product_manifest_entries:1");
		expect(manifest.evidence_refs).toContain("grader_outcomes:1");
		expect(manifest.evidence_refs).toContain("user_corrections:1");
		expect(manifest.evidence_refs).toContain("escalation_join_keys:1");
		expect(manifest.blob_hashes).toHaveLength(2);

		const validation = validateManifest(manifest);
		expect(validation.ok).toBe(true);

		for (let i = 0; i < blobs.length; i++) {
			const actual = createHash("sha256").update(blobs[i]).digest("hex");
			expect(actual).toBe(manifest.blob_hashes[i]);
		}
	});

	it("blobs contain the aggregated evidence and the product manifest", () => {
		const input = makeInput();
		const { blobs } = buildEvidenceArtifact(input);

		const evidence = JSON.parse(blobs[0].toString("utf8")) as Record<string, unknown>;
		expect(evidence.task_id).toBe("task-001");
		expect(evidence.version_contract).toEqual({
			artifact_id: "b".repeat(64),
			scaffold_hash: "c".repeat(64),
			snapshot_sha: "d".repeat(64),
		});
		expect(evidence.tool_events).toEqual([
			{
				toolName: "read",
				argsHash: "1".repeat(64),
				resultHash: "2".repeat(64),
				durationMs: 12,
				timestamp: 1_700_000_000_000,
			},
			{
				toolName: "bash",
				argsHash: "3".repeat(64),
				resultHash: "4".repeat(64),
				durationMs: 350,
				error: "exit code 1",
				timestamp: 1_700_000_001_000,
			},
		]);
		expect(evidence.grader_outcomes).toEqual(input.graderOutcomes);
		expect(evidence.user_corrections).toEqual(input.userCorrections);
		expect(evidence.escalation_join_keys).toEqual(input.escalationJoinKeys);

		const productManifest = JSON.parse(blobs[1].toString("utf8")) as unknown;
		expect(productManifest).toEqual(input.productManifest);
	});

	it("blobs are canonical JSON (parse -> canonicalJson round-trips byte-exact)", () => {
		const { blobs } = buildEvidenceArtifact(makeInput());
		for (const blob of blobs) {
			expect(canonicalJson(JSON.parse(blob.toString("utf8")))).toBe(blob.toString("utf8"));
		}
	});

	it("storeEvidenceArtifact stores to the registry and returns the content-addressed artifact_id", () => {
		const result = storeEvidenceArtifact(registry, makeInput());
		expect(result.artifactId).toMatch(/^[0-9a-f]{64}$/);
		expect(result.artifactId).toBe(computeArtifactId(result.manifest));
		expect(registry.readManifest(result.artifactId)).toEqual(result.manifest);
	});

	it("rejects missing or malformed required fields", () => {
		const valid = makeInput();

		expect(() => buildEvidenceArtifact({ ...valid, taskId: "" })).toThrow(/taskId/);
		expect(() => buildEvidenceArtifact({ ...valid, versionContract: undefined as never })).toThrow(/versionContract/);
		expect(() =>
			buildEvidenceArtifact({ ...valid, versionContract: { ...valid.versionContract, scaffoldHash: "pending_0b" } }),
		).toThrow(/scaffoldHash/);
		expect(() => buildEvidenceArtifact({ ...valid, toolEvents: undefined as never })).toThrow(/toolEvents/);
		expect(() => buildEvidenceArtifact({ ...valid, productManifest: undefined as never })).toThrow(/productManifest/);
		expect(() => buildEvidenceArtifact({ ...valid, graderOutcomes: undefined as never })).toThrow(/graderOutcomes/);
		expect(() => buildEvidenceArtifact({ ...valid, userCorrections: undefined as never })).toThrow(/userCorrections/);
		expect(() => buildEvidenceArtifact({ ...valid, escalationJoinKeys: undefined as never })).toThrow(
			/escalationJoinKeys/,
		);
		expect(() => buildEvidenceArtifact(undefined as never)).toThrow(/expected an object/);
	});

	it("round-trip: fetchBundle returns the same manifest and blob content", () => {
		const input = makeInput();
		const result = storeEvidenceArtifact(registry, input);
		const loaded = registry.fetchBundle(result.artifactId);

		expect(loaded.manifest).toEqual(result.manifest);
		expect(loaded.blobs).toHaveLength(result.blobs.length);
		for (let i = 0; i < result.blobs.length; i++) {
			expect(loaded.blobs[i].equals(result.blobs[i])).toBe(true);
		}
		expect(JSON.parse(loaded.blobs[0].toString("utf8"))).toEqual(JSON.parse(result.blobs[0].toString("utf8")));
		expect(JSON.parse(loaded.blobs[1].toString("utf8"))).toEqual(input.productManifest);
	});
});
