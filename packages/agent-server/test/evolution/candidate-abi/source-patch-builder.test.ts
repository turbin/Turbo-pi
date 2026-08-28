import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRegistry } from "../../../src/evolution/artifact-registry.ts";
import { openArtifactRegistry } from "../../../src/evolution/artifact-registry.ts";
import {
	CANDIDATE_ABI_VERSION,
	type CandidateExtensionManifest,
} from "../../../src/evolution/candidate-abi/manifest.ts";
import {
	buildSourcePatchArtifact,
	storeSourcePatchArtifact,
} from "../../../src/evolution/candidate-abi/source-patch-builder.ts";
import { openEvolutionDb } from "../../../src/evolution/db.ts";

function makeManifest(): CandidateExtensionManifest {
	return {
		abiVersion: CANDIDATE_ABI_VERSION,
		name: "patch-candidate",
		description: "adds a system guideline for read_file retries",
		generatedFrom: {
			taskId: "task-42",
			clusterId: "cluster-7",
			evidenceArtifactId: "ev-abc123",
		},
		capabilities: ["declarative/system-guideline"],
		declarations: {
			systemGuidelines: ["If read_file fails with ENOENT, check the cwd before retrying."],
		},
	};
}

const DIFF = `--- a/.pi/candidate-extensions/read-retry/policy.json
+++ b/.pi/candidate-extensions/read-retry/policy.json
@@ -0,0 +1 @@
+{"guidelines":["check cwd on ENOENT"]}
`;

describe("buildSourcePatchArtifact", () => {
	it("builds a source_patch artifact with the expected layout", () => {
		const result = buildSourcePatchArtifact({
			candidateManifest: makeManifest(),
			diff: DIFF,
			parentIds: ["parent-1"],
			evidenceRefs: ["task:task-42", "cluster:cluster-7"],
			scaffoldHash: "a".repeat(64),
			modelFingerprint: JSON.stringify({ model: "test", temperature: 0 }),
		});

		expect(result.manifest.kind).toBe("source_patch");
		expect(result.manifest.operator).toBe("draft");
		expect(result.manifest.parent_ids).toEqual(["parent-1"]);
		expect(result.manifest.scope).toEqual(["declarative/system-guideline"]);
		expect(result.manifest.evidence_refs).toEqual(["task:task-42", "cluster:cluster-7"]);
		expect(result.manifest.data_class).toBe("diagnostic_ops");
		expect(result.manifest.retention_policy_ref).toBe("pending_0b");
		expect(result.manifest.blob_hashes).toHaveLength(2);

		expect(result.blobs).toHaveLength(2);
		expect(result.blobs[0].toString("utf8")).toBe(DIFF);
		const parsedManifest = JSON.parse(result.blobs[1].toString("utf8")) as ReturnType<typeof makeManifest>;
		expect(parsedManifest.name).toBe("patch-candidate");
		expect(parsedManifest.capabilities).toEqual(["declarative/system-guideline"]);
	});

	it("throws for an invalid candidate manifest", () => {
		expect(() =>
			buildSourcePatchArtifact({
				candidateManifest: { ...makeManifest(), capabilities: [] },
				diff: DIFF,
				parentIds: [],
				evidenceRefs: [],
				scaffoldHash: "a".repeat(64),
				modelFingerprint: JSON.stringify({ model: "test" }),
			}),
		).toThrow(/invalid candidate manifest/);
	});
});

describe("storeSourcePatchArtifact", () => {
	let base: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "source-patch-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("stores and round-trips a source_patch artifact", () => {
		const stored = storeSourcePatchArtifact(registry, {
			candidateManifest: makeManifest(),
			diff: DIFF,
			parentIds: [],
			evidenceRefs: ["task:task-42"],
			scaffoldHash: "b".repeat(64),
			modelFingerprint: JSON.stringify({ model: "test" }),
		});

		const bundle = registry.fetchBundle(stored.artifactId);
		expect(bundle.manifest.kind).toBe("source_patch");
		expect(bundle.blobs[0].toString("utf8")).toBe(DIFF);
		const parsed = JSON.parse(bundle.blobs[1].toString("utf8")) as ReturnType<typeof makeManifest>;
		expect(parsed.name).toBe("patch-candidate");
	});
});
