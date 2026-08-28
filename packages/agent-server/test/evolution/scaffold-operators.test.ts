import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { createDefaultScaffoldConfig, type ScaffoldConfig } from "../../src/evolution/scaffold-config.ts";
import { applyScaffoldOperator, type ScaffoldOperatorInput } from "../../src/evolution/scaffold-operators.ts";

describe("P3-T30 scaffold operators", () => {
	let base: string;
	let registry: ArtifactRegistry;
	let lineage: LineageTracker;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-scaffold-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
		DevAuditWriter.loadOrCreate(join(base, "creds"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	function storeRawConfig(config: ScaffoldConfig | Partial<ScaffoldConfig>, evidenceRef: string): string {
		const blob = Buffer.from(JSON.stringify(config), "utf8");
		const blobHash = createHash("sha256").update(blob).digest("hex");
		return registry.storeArtifact(
			{
				kind: "scaffold_config",
				parent_ids: [],
				operator: "draft",
				scope: ["scaffold/config"],
				evidence_refs: [evidenceRef],
				scaffold_hash: "0000000000000000000000000000000000000000000000000000000000000000",
				model_fingerprint: JSON.stringify({ model: "test" }),
				data_class: "diagnostic_ops",
				retention_policy_ref: "pending_0b",
				blob_hashes: [blobHash],
			},
			[blob],
		);
	}

	it("draft produces a valid scaffold config artifact", () => {
		const result = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-draft"],
		});
		expect(result.status).toBe("generated");
		expect(result.artifactId).toMatch(/^[0-9a-f]{64}$/);
		expect(result.parentIds).toEqual([]);
		expect(result.operator).toBe("draft");

		const bundle = registry.fetchBundle(result.artifactId);
		expect(bundle.manifest.kind).toBe("scaffold_config");
		const config = JSON.parse(bundle.blobs[0].toString("utf8")) as ScaffoldConfig;
		expect(config.activeTools).toContain("read");
		expect(config.retrievalFinalLimit).toBe(5);
	});

	it("improve increments retrievalFinalLimit", () => {
		const parent = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-improve"],
		});
		expect(parent.status).toBe("generated");

		const result = applyScaffoldOperator(registry, lineage, {
			operator: "improve",
			parentArtifactIds: [parent.artifactId],
			evidenceRefs: ["cluster-improve"],
		});
		expect(result.status).toBe("generated");

		const before = JSON.parse(registry.fetchBundle(parent.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		const after = JSON.parse(registry.fetchBundle(result.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		expect(after.retrievalFinalLimit).toBe(before.retrievalFinalLimit + 1);
	});

	it("debug fills missing fields", () => {
		const incomplete: Partial<ScaffoldConfig> = { activeTools: ["read"] };
		const parentId = storeRawConfig(incomplete, "cluster-debug");

		const result = applyScaffoldOperator(registry, lineage, {
			operator: "debug",
			parentArtifactIds: [parentId],
			evidenceRefs: ["cluster-debug"],
		});
		expect(result.status).toBe("generated");

		const fixed = JSON.parse(registry.fetchBundle(result.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		expect(fixed.activeTools).toEqual(["read"]);
		expect(fixed.retrievalFinalLimit).toBe(createDefaultScaffoldConfig().retrievalFinalLimit);
		expect(fixed.skillLimit).toBeDefined();
	});

	it("crossover merges two parents", () => {
		const parentA = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-crossover-a"],
		});
		const parentB = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-crossover-b"],
		});

		// Mutate parentB via improve so the two configs differ.
		const improvedB = applyScaffoldOperator(registry, lineage, {
			operator: "improve",
			parentArtifactIds: [parentB.artifactId],
			evidenceRefs: ["cluster-crossover-b"],
		});

		const result = applyScaffoldOperator(registry, lineage, {
			operator: "crossover",
			parentArtifactIds: [parentA.artifactId, improvedB.artifactId],
			evidenceRefs: ["cluster-crossover"],
		});
		expect(result.status).toBe("generated");
		expect(result.parentIds).toHaveLength(2);

		const config = JSON.parse(registry.fetchBundle(result.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		const cfgA = JSON.parse(registry.fetchBundle(parentA.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		const cfgB = JSON.parse(registry.fetchBundle(improvedB.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		// Field order: systemPromptFragments(0,A), activeTools(1,B), toolExecutionModes(2,A),
		// retrievalCandidateLimit(3,B), retrievalFinalLimit(4,A), ...
		expect(config.systemPromptFragments).toEqual(cfgA.systemPromptFragments);
		expect(config.activeTools).toEqual(cfgB.activeTools);
		expect(config.retrievalFinalLimit).toBe(cfgA.retrievalFinalLimit);
		expect(config.retrievalCandidateLimit).toBe(cfgB.retrievalCandidateLimit);
	});

	it("consolidate removes redundancy", () => {
		const raw: ScaffoldConfig = {
			...createDefaultScaffoldConfig(),
			systemPromptFragments: ["a", "a", "b", "a"],
			activeTools: ["read", "read", "bash", "read"],
		};
		const parentId = storeRawConfig(raw, "cluster-consolidate");

		const result = applyScaffoldOperator(registry, lineage, {
			operator: "consolidate",
			parentArtifactIds: [parentId],
			evidenceRefs: ["cluster-consolidate"],
		});
		expect(result.status).toBe("generated");

		const config = JSON.parse(registry.fetchBundle(result.artifactId).blobs[0].toString("utf8")) as ScaffoldConfig;
		expect(config.systemPromptFragments).toEqual(["a", "b"]);
		expect(config.activeTools).toEqual(["read", "bash"]);
	});

	it("records lineage edges for every parent", () => {
		const parent = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-lineage"],
		});
		const child = applyScaffoldOperator(registry, lineage, {
			operator: "improve",
			parentArtifactIds: [parent.artifactId],
			evidenceRefs: ["cluster-lineage"],
		});

		const parents = lineage.getParents(child.artifactId);
		expect(parents.some((e) => e.parentId === parent.artifactId && e.operator === "improve")).toBe(true);
		const children = lineage.getChildren(parent.artifactId);
		expect(children.some((e) => e.childId === child.artifactId)).toBe(true);
	});

	it("rejects invalid operators", () => {
		const result = applyScaffoldOperator(registry, lineage, {
			operator: "invalid" as ScaffoldOperatorInput["operator"],
			parentArtifactIds: [],
			evidenceRefs: ["cluster-invalid"],
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("unknown operator");
	});
});
