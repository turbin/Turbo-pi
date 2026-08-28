import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import {
	buildEvidenceArtifact,
	type EvidenceArtifactInput,
	storeEvidenceArtifact,
} from "../../src/evolution/evidence-artifact-builder.ts";
import {
	classifyFailure,
	classifyFromEvidence,
	validateFailureClassification,
} from "../../src/evolution/failure-classifier.ts";
import { FAILURE_TAXONOMY } from "../../src/evolution/taxonomy.ts";

function makeInput(overrides: Partial<EvidenceArtifactInput> = {}): EvidenceArtifactInput {
	return {
		taskId: "task-001",
		versionContract: { artifactId: "b".repeat(64), scaffoldHash: "c".repeat(64), snapshotSha: "d".repeat(64) },
		toolEvents: [],
		productManifest: [],
		graderOutcomes: [],
		userCorrections: [],
		escalationJoinKeys: [],
		...overrides,
	};
}

describe("classifyFailure", () => {
	it("accepts every taxonomy category via hints", () => {
		for (const category of FAILURE_TAXONOMY) {
			const result = classifyFailure("task-1", ["ref:a"], { category, confidence: 0.8 });
			expect(result.category).toBe(category);
			expect(result.confidence).toBe(0.8);
			expect(result.taskId).toBe("task-1");
			expect(result.evidenceRefs).toEqual(["ref:a"]);
			expect(typeof result.classifiedAt).toBe("number");
			expect(validateFailureClassification(result).ok).toBe(true);
		}
	});

	it("defaults hinted confidence to 0.5", () => {
		expect(classifyFailure("task-1", [], { category: "model" }).confidence).toBe(0.5);
	});

	it("returns unknown with confidence 0 when no hints are given", () => {
		const result = classifyFailure("task-1", ["ref:a"]);
		expect(result.category).toBe("unknown");
		expect(result.confidence).toBe(0);
	});

	it("returns unknown with confidence 0 for an invalid hint category", () => {
		for (const category of ["not-a-category", "", 42, null, undefined]) {
			const result = classifyFailure("task-1", [], { category });
			expect(result.category).toBe("unknown");
			expect(result.confidence).toBe(0);
		}
	});

	it("rejects an empty taskId", () => {
		expect(() => classifyFailure("", [])).toThrow(/taskId/);
		expect(validateFailureClassification({ ...classifyFailure("t", []), taskId: "" }).ok).toBe(false);
	});

	it("rejects confidence outside [0, 1]", () => {
		expect(() => classifyFailure("task-1", [], { category: "model", confidence: -0.1 })).toThrow(/confidence/);
		expect(() => classifyFailure("task-1", [], { category: "model", confidence: 1.1 })).toThrow(/confidence/);
		expect(() => classifyFailure("task-1", [], { category: "model", confidence: Number.NaN })).toThrow(/confidence/);
		const base = classifyFailure("task-1", []);
		expect(validateFailureClassification({ ...base, confidence: 2 }).ok).toBe(false);
		expect(validateFailureClassification({ ...base, confidence: -1 }).ok).toBe(false);
	});

	it("rejects an invalid category in validation", () => {
		const base = classifyFailure("task-1", []);
		const result = validateFailureClassification({ ...base, category: "bogus" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join()).toMatch(/category/);
	});
});

describe("classifyFromEvidence", () => {
	let baseDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "evo-classify-"));
		const db = openEvolutionDb(join(baseDir, "evolution.db"));
		registry = openArtifactRegistry(db.db, join(baseDir, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("infers the category from an explicit failure:<category> evidence ref", () => {
		const built = buildEvidenceArtifact(makeInput());
		built.manifest.evidence_refs.push("failure:retrieval");
		const artifactId = registry.storeArtifact(built.manifest, built.blobs);
		const result = classifyFromEvidence(artifactId, registry);
		expect(result.category).toBe("retrieval");
		expect(result.confidence).toBe(0.9);
		expect(result.taskId).toBe("task-001");
	});

	it("infers model from escalation join keys", () => {
		const { artifactId } = storeEvidenceArtifact(
			registry,
			makeInput({ escalationJoinKeys: [{ gatewaySequence: 1, qualitySignalsSha: "7".repeat(64) }] }),
		);
		const result = classifyFromEvidence(artifactId, registry);
		expect(result.category).toBe("model");
		expect(result.confidence).toBe(0.6);
	});

	it("infers environment from tool events carrying errors", () => {
		const { artifactId } = storeEvidenceArtifact(
			registry,
			makeInput({
				toolEvents: [
					{
						toolName: "bash",
						argsHash: "1".repeat(64),
						resultHash: "2".repeat(64),
						durationMs: 10,
						error: "exit code 1",
						timestamp: 1_700_000_000_000,
					},
				],
			}),
		);
		expect(classifyFromEvidence(artifactId, registry).category).toBe("environment");
	});

	it("returns unknown when the artifact carries no failure signal", () => {
		const { artifactId } = storeEvidenceArtifact(registry, makeInput());
		const result = classifyFromEvidence(artifactId, registry);
		expect(result.category).toBe("unknown");
		expect(result.confidence).toBe(0);
	});

	it("returns unknown for an unparseable artifact blob", () => {
		const blob = Buffer.from("this is not json", "utf8");
		const manifest: ArtifactManifest = {
			kind: "composite",
			parent_ids: [],
			operator: "draft",
			scope: ["evidence"],
			evidence_refs: ["task:task-garbage"],
			scaffold_hash: "a".repeat(64),
			model_fingerprint: JSON.stringify({ source: "test" }),
			data_class: "diagnostic_ops",
			retention_policy_ref: "pending_0b",
			blob_hashes: [createHash("sha256").update(blob).digest("hex")],
		};
		const artifactId = registry.storeArtifact(manifest, [blob]);
		const result = classifyFromEvidence(artifactId, registry);
		expect(result.category).toBe("unknown");
		expect(result.confidence).toBe(0);
		expect(result.taskId).toBe("task-garbage");
	});

	it("returns unknown for a missing artifact", () => {
		const result = classifyFromEvidence("f".repeat(64), registry);
		expect(result.category).toBe("unknown");
		expect(result.confidence).toBe(0);
	});
});
