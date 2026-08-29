import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskLevelDetectorSnapshot } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { buildEvidenceArtifact } from "../../src/evolution/evidence-artifact-builder.ts";
import type { EscalationJoinKey } from "../../src/evolution/evidence-schema.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import {
	discoverFailureClusters,
	type FailureCluster,
	generateSourceCandidate,
} from "../../src/evolution/source-candidate-generator.ts";

function makeSnapshot(signal: string): TaskLevelDetectorSnapshot {
	return {
		version: "v1-rule",
		signals: [
			{
				name: signal as TaskLevelDetectorSnapshot["signals"][0]["name"],
				confidence: 1,
				evidenceRefs: ["tool_event:0"],
			},
		],
		recommended: signal === "escalationRecommended",
		originalTask: "test",
		computedAt: 1_700_000_000_000,
	};
}

function seedEvidenceArtifact(
	registry: ArtifactRegistry,
	options: {
		taskId: string;
		signal: string;
		toolName?: string;
		error?: string;
		escalationJoinKeys?: EscalationJoinKey[];
	},
): string {
	const built = buildEvidenceArtifact({
		taskId: options.taskId,
		versionContract: {
			artifactId: `contract-${options.taskId}`,
			scaffoldHash: "a".repeat(64),
			snapshotSha: `snapshot-${options.taskId}`,
		},
		toolEvents: options.toolName
			? [
					{
						toolName: options.toolName,
						argsHash: "hash1",
						resultHash: "hash2",
						durationMs: 10,
						error: options.error,
						timestamp: 1,
					},
				]
			: [],
		productManifest: [],
		graderOutcomes: [
			{ taskId: options.taskId, outcome: "failure", graderSha: "g1", timestamp: new Date().toISOString() },
		],
		userCorrections: [],
		escalationJoinKeys: options.escalationJoinKeys ?? [],
		detectorSnapshot: makeSnapshot(options.signal),
	});
	return registry.storeArtifact(built.manifest, built.blobs);
}

describe("discoverFailureClusters", () => {
	let base: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "source-candidate-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("groups repeated tool failures into a cluster", () => {
		seedEvidenceArtifact(registry, {
			taskId: "t1",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});
		seedEvidenceArtifact(registry, {
			taskId: "t2",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});
		seedEvidenceArtifact(registry, { taskId: "t3", signal: "deliveryMissing" });

		const clusters = discoverFailureClusters(registry);
		expect(clusters.length).toBeGreaterThanOrEqual(1);
		const readCluster = clusters.find((c) => c.signal === "repeatedToolFailure" && c.toolName === "read_file");
		expect(readCluster).toBeDefined();
		expect(readCluster?.sampleCount).toBe(2);
		expect(readCluster?.category).toBe("environment");
	});

	it("respects minClusterSize", () => {
		seedEvidenceArtifact(registry, { taskId: "t1", signal: "deliveryMissing" });
		seedEvidenceArtifact(registry, { taskId: "t2", signal: "deliveryMissing" });
		seedEvidenceArtifact(registry, { taskId: "t3", signal: "escalationRecommended" });

		const clusters = discoverFailureClusters(registry, { minClusterSize: 2 });
		expect(clusters.every((c) => c.sampleCount >= 2)).toBe(true);
	});

	it("filters by category", () => {
		seedEvidenceArtifact(registry, {
			taskId: "t1",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "x",
		});
		seedEvidenceArtifact(registry, {
			taskId: "t2",
			signal: "escalationRecommended",
			escalationJoinKeys: [{ gatewaySequence: 1, qualitySignalsSha: "b".repeat(64) }],
		});

		const clusters = discoverFailureClusters(registry, { categoryFilter: ["model"] });
		expect(clusters.every((c) => c.category === "model")).toBe(true);
	});
});

describe("generateSourceCandidate", () => {
	let base: string;
	let registry: ArtifactRegistry;
	let lineage: LineageTracker;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "source-candidate-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("generates a source_patch artifact for the largest cluster", () => {
		seedEvidenceArtifact(registry, {
			taskId: "t1",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});
		seedEvidenceArtifact(registry, {
			taskId: "t2",
			signal: "repeatedToolFailure",
			toolName: "read_file",
			error: "ENOENT",
		});

		const result = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "rule-generator" }),
		});

		expect(result.status).toBe("generated");
		expect(result.artifactId).toBeDefined();
		expect(result.clusterId).toBeDefined();

		const bundle = registry.fetchBundle(result.artifactId!);
		expect(bundle.manifest.kind).toBe("source_patch");
		expect(bundle.manifest.scope).toContain("declarative/tool-prompt");
		expect(bundle.blobs[0].toString("utf8")).toContain(".pi/candidate-extensions/");
		const manifest = JSON.parse(bundle.blobs[1].toString("utf8")) as { name: string; capabilities: string[] };
		expect(manifest.name).toContain(result.clusterId);
		expect(manifest.capabilities).toEqual(["declarative/tool-prompt"]);
	});

	it("records lineage edges for each parent", () => {
		seedEvidenceArtifact(registry, { taskId: "t1", signal: "deliveryMissing" });
		seedEvidenceArtifact(registry, { taskId: "t2", signal: "deliveryMissing" });
		const parentId = registry.db
			.prepare("SELECT artifact_id FROM artifact_immutable_manifests WHERE kind = 'composite' LIMIT 1")
			.get() as { artifact_id: string };

		const result = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [parentId.artifact_id],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "rule-generator" }),
		});

		expect(result.status).toBe("generated");
		const parents = lineage.getParents(result.artifactId!);
		expect(parents).toHaveLength(1);
		expect(parents[0].parentId).toBe(parentId.artifact_id);
		expect(parents[0].operator).toBe("draft");
	});

	it("returns no_cluster when no actionable pattern exists", () => {
		const result = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "rule-generator" }),
		});
		expect(result.status).toBe("no_cluster");
	});

	it("uses a provided cluster instead of discovering one", () => {
		const cluster: FailureCluster = {
			clusterId: "manual-cluster",
			category: "delivery",
			signal: "deliveryMissing",
			sampleArtifactIds: ["art-1"],
			sampleTaskIds: ["task-1"],
			sampleCount: 5,
		};
		const result = generateSourceCandidate({
			registry,
			lineage,
			parentIds: [],
			scaffoldHash: "c".repeat(64),
			modelFingerprint: JSON.stringify({ model: "rule-generator" }),
			cluster,
		});

		expect(result.status).toBe("generated");
		expect(result.clusterId).toBe("manual-cluster");
		const bundle = registry.fetchBundle(result.artifactId!);
		const manifest = JSON.parse(bundle.blobs[1].toString("utf8")) as { declarations: { systemGuidelines: string[] } };
		expect(manifest.declarations.systemGuidelines[0]).toContain("concrete deliverable");
	});
});
