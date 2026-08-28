/**
 * P3-T30: small-scope scaffold operators.
 *
 * Implements the unified operator set (draft/improve/debug/crossover/consolidate)
 * for scaffold_config artifacts. Every output is stored through the content-
 * addressed artifact registry and a lineage edge is recorded per parent.
 */

import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { LineageTracker } from "./lineage.ts";
import { createDefaultScaffoldConfig, fillMissingFields, type ScaffoldConfig } from "./scaffold-config.ts";

export type ScaffoldOperator = "draft" | "improve" | "debug" | "crossover" | "consolidate";

export interface ScaffoldOperatorInput {
	/** Required for improve/debug/consolidate; two required for crossover. */
	parentArtifactIds?: string[];
	operator: ScaffoldOperator;
	/** Failure-cluster/issue/trace/task IDs backing this generation. */
	evidenceRefs: string[];
}

export interface ScaffoldOperatorResult {
	candidateId: string;
	artifactId: string;
	parentIds: string[];
	operator: ScaffoldOperator;
	status: "generated" | "failed";
	error?: string;
}

const SCAFFOLD_FIELDS: (keyof ScaffoldConfig)[] = [
	"systemPromptFragments",
	"activeTools",
	"toolExecutionModes",
	"retrievalCandidateLimit",
	"retrievalFinalLimit",
	"methodGuardLimit",
	"skillLimit",
	"sopLimit",
	"injectionPosition",
	"wrapperTemplate",
	"compactionThreshold",
	"retryPolicy",
	"taskLevelDetectorVersion",
	"providerModelSamplingMatrix",
];

function computeCandidateId(operator: string, parentIds: string[], evidenceRefs: string[], outcome: string): string {
	return `scaf-${sha256Hex(canonicalJson([operator, parentIds, evidenceRefs, outcome])).slice(0, 32)}`;
}

function serializeConfig(config: ScaffoldConfig): Buffer {
	return Buffer.from(canonicalJson(config), "utf8");
}

function configFingerprint(config: ScaffoldConfig): string {
	return sha256Hex(serializeConfig(config).toString("utf8"));
}

function buildManifest(
	operator: ScaffoldOperator,
	parentIds: string[],
	evidenceRefs: string[],
	blobHash: string,
	scaffoldHash: string,
): ArtifactManifest {
	return {
		kind: "scaffold_config",
		parent_ids: parentIds,
		operator,
		scope: ["scaffold/config"],
		evidence_refs: evidenceRefs,
		scaffold_hash: scaffoldHash,
		model_fingerprint: JSON.stringify({ model: "deterministic-scaffold-operator", operator, temperature: 0 }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [blobHash],
	};
}

function loadParentConfig(registry: ArtifactRegistry, parentId: string): ScaffoldConfig {
	const bundle = registry.fetchBundle(parentId);
	if (bundle.manifest.kind !== "scaffold_config") {
		throw new Error(`parent ${parentId} is kind "${bundle.manifest.kind}", expected scaffold_config`);
	}
	if (bundle.blobs.length !== 1) {
		throw new Error(`parent ${parentId} has ${bundle.blobs.length} blobs, expected 1`);
	}
	return JSON.parse(bundle.blobs[0].toString("utf8")) as ScaffoldConfig;
}

function applyImprove(config: ScaffoldConfig): ScaffoldConfig {
	return {
		...config,
		retrievalFinalLimit: Math.min(20, config.retrievalFinalLimit + 1),
	};
}

function applyDebug(config: Partial<ScaffoldConfig>): ScaffoldConfig {
	return fillMissingFields(config);
}

function applyCrossover(parentA: ScaffoldConfig, parentB: ScaffoldConfig): ScaffoldConfig {
	const result = {} as Record<keyof ScaffoldConfig, unknown>;
	for (let i = 0; i < SCAFFOLD_FIELDS.length; i++) {
		const field = SCAFFOLD_FIELDS[i] as keyof ScaffoldConfig;
		result[field] = i % 2 === 0 ? parentA[field] : parentB[field];
	}
	return fillMissingFields(result as unknown as Partial<ScaffoldConfig>);
}

function applyConsolidate(config: ScaffoldConfig): ScaffoldConfig {
	const dedupedFragments = [...new Set(config.systemPromptFragments)];
	const dedupedTools = [...new Set(config.activeTools)];
	return {
		...config,
		systemPromptFragments: dedupedFragments,
		activeTools: dedupedTools,
	};
}

function failResult(
	operator: ScaffoldOperator,
	parentIds: string[],
	evidenceRefs: string[],
	error: string,
): ScaffoldOperatorResult {
	return {
		candidateId: computeCandidateId(operator, parentIds, evidenceRefs, `failed:${error}`),
		artifactId: "",
		parentIds,
		operator,
		status: "failed",
		error,
	};
}

/**
 * Apply a scaffold operator and store the resulting scaffold_config artifact.
 *
 * Failures are returned as `status: "failed"` so the caller can record the
 * failure in the experiment ledger; they never throw.
 */
export function applyScaffoldOperator(
	registry: ArtifactRegistry,
	lineage: LineageTracker,
	input: ScaffoldOperatorInput,
): ScaffoldOperatorResult {
	const parentIds = input.parentArtifactIds ?? [];
	const evidenceRefs = input.evidenceRefs;

	try {
		let config: ScaffoldConfig;
		let diffSummary = "";

		switch (input.operator) {
			case "draft": {
				config = createDefaultScaffoldConfig();
				diffSummary = "draft: default scaffold config";
				break;
			}
			case "improve": {
				if (parentIds.length !== 1) {
					return failResult(input.operator, parentIds, evidenceRefs, "improve requires exactly one parent");
				}
				const parent = loadParentConfig(registry, parentIds[0] as string);
				config = applyImprove(parent);
				diffSummary = `improve: retrievalFinalLimit ${parent.retrievalFinalLimit} -> ${config.retrievalFinalLimit}`;
				break;
			}
			case "debug": {
				if (parentIds.length !== 1) {
					return failResult(input.operator, parentIds, evidenceRefs, "debug requires exactly one parent");
				}
				const parent = loadParentConfig(registry, parentIds[0] as string);
				config = applyDebug(parent);
				diffSummary = "debug: filled missing fields with defaults";
				break;
			}
			case "crossover": {
				if (parentIds.length !== 2) {
					return failResult(input.operator, parentIds, evidenceRefs, "crossover requires exactly two parents");
				}
				const parentA = loadParentConfig(registry, parentIds[0] as string);
				const parentB = loadParentConfig(registry, parentIds[1] as string);
				config = applyCrossover(parentA, parentB);
				diffSummary = "crossover: alternate fields from two parents";
				break;
			}
			case "consolidate": {
				if (parentIds.length !== 1) {
					return failResult(input.operator, parentIds, evidenceRefs, "consolidate requires exactly one parent");
				}
				const parent = loadParentConfig(registry, parentIds[0] as string);
				config = applyConsolidate(parent);
				diffSummary = "consolidate: removed duplicate fragments/tools";
				break;
			}
			default: {
				return failResult(input.operator, parentIds, evidenceRefs, `unknown operator: ${String(input.operator)}`);
			}
		}

		const blob = serializeConfig(config);
		const blobHash = sha256Hex(blob.toString("utf8"));
		const scaffoldHash = configFingerprint(config);
		const manifest = buildManifest(input.operator, parentIds, evidenceRefs, blobHash, scaffoldHash);
		const artifactId = registry.storeArtifact(manifest, [blob]);

		for (const parentId of parentIds) {
			lineage.recordEdge({ parentId, childId: artifactId, operator: input.operator, diffSummary });
		}

		return {
			candidateId: computeCandidateId(input.operator, parentIds, evidenceRefs, artifactId),
			artifactId,
			parentIds,
			operator: input.operator,
			status: "generated",
		};
	} catch (err) {
		return failResult(input.operator, parentIds, evidenceRefs, err instanceof Error ? err.message : String(err));
	}
}
