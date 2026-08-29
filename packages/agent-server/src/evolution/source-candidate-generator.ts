/**
 * P5-2: failure-cluster → source-candidate generator.
 *
 * Scans `composite` evidence artifacts, groups recurrent failure patterns into
 * clusters, and emits a `source_patch` artifact containing a capability-limited
 * candidate extension. The generator is deterministic and model-free: it does
 * not call LLMs or use API keys.
 */

import { createHash } from "node:crypto";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import {
	CANDIDATE_ABI_VERSION,
	type CandidateCapability,
	type CandidateExtensionManifest,
	type DeclarativePolicies,
	type SourcePatchArtifactInput,
	storeSourcePatchArtifact,
} from "./candidate-abi/index.ts";
import { classifyFromEvidence } from "./failure-classifier.ts";
import type { LineageTracker } from "./lineage.ts";
import type { FailureTaxonomy } from "./taxonomy.ts";

export interface FailureCluster {
	clusterId: string;
	category: FailureTaxonomy;
	signal: string;
	toolName?: string;
	error?: string;
	sampleArtifactIds: string[];
	sampleTaskIds: string[];
	sampleCount: number;
}

export interface FailureClusterDiscoveryOptions {
	/** Minimum samples for a cluster to be actionable. Defaults to 2. */
	minClusterSize?: number;
	/** Maximum clusters to return. Defaults to unlimited. */
	maxClusters?: number;
	/** Restrict clustering to these taxonomy categories. */
	categoryFilter?: FailureTaxonomy[];
}

export interface SourceCandidateInput {
	registry: ArtifactRegistry;
	lineage: LineageTracker;
	parentIds: string[];
	scaffoldHash: string;
	modelFingerprint: string;
	/** Optional pre-selected cluster; otherwise the generator discovers one. */
	cluster?: FailureCluster;
	/** Options passed to cluster discovery when no cluster is supplied. */
	clusterOptions?: FailureClusterDiscoveryOptions;
}

export interface SourceCandidateResult {
	status: "generated" | "no_cluster" | "failed";
	artifactId?: string;
	clusterId?: string;
	error?: string;
}

interface EvidencePayload {
	task_id?: unknown;
	detector_snapshot?: {
		signals?: Array<{ name?: unknown; evidenceRefs?: unknown }>;
	};
	tool_events?: Array<{ toolName?: unknown; error?: unknown }>;
}

function sha256HexShort(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseEvidencePayload(registry: ArtifactRegistry, artifactId: string): EvidencePayload | undefined {
	try {
		const bundle = registry.fetchBundle(artifactId);
		return JSON.parse(bundle.blobs[0].toString("utf8")) as EvidencePayload;
	} catch {
		return undefined;
	}
}

function taskIdFromPayload(payload: EvidencePayload | undefined, fallback: string): string {
	if (payload && isNonEmptyString(payload.task_id)) {
		return payload.task_id;
	}
	return fallback;
}

function clusterKey(category: string, signal: string, toolName: string, error: string): string {
	return `${category}\t${signal}\t${toolName}\t${error}`;
}

/**
 * Discovers failure clusters from stored `composite` evidence artifacts.
 *
 * Clustering dimensions: failure taxonomy category, detector signal name, and
 * (when present) the failing tool name and error message. Only clusters with at
 * least `minClusterSize` samples are returned, sorted by sample count desc.
 */
export function discoverFailureClusters(
	registry: ArtifactRegistry,
	options: FailureClusterDiscoveryOptions = {},
): FailureCluster[] {
	const minClusterSize = options.minClusterSize ?? 2;
	const categoryFilter = options.categoryFilter;

	const rows = registry.db
		.prepare("SELECT artifact_id FROM artifact_immutable_manifests WHERE kind = 'composite'")
		.all() as Array<{ artifact_id: string }>;

	const clusters = new Map<string, FailureCluster>();

	for (const row of rows) {
		const artifactId = row.artifact_id;
		const classification = classifyFromEvidence(artifactId, registry);
		if (categoryFilter && !categoryFilter.includes(classification.category)) {
			continue;
		}

		const payload = parseEvidencePayload(registry, artifactId);
		const taskId = taskIdFromPayload(payload, classification.taskId);
		const signals = payload?.detector_snapshot?.signals ?? [];
		const toolEvents = payload?.tool_events ?? [];

		for (const signal of signals) {
			const signalName = isNonEmptyString(signal.name) ? signal.name : "unknown";
			const failingEvent = toolEvents.find((e) => isNonEmptyString(e.error));
			const toolName = failingEvent && isNonEmptyString(failingEvent.toolName) ? failingEvent.toolName : "";
			const error = failingEvent && isNonEmptyString(failingEvent.error) ? failingEvent.error.slice(0, 120) : "";
			const key = clusterKey(classification.category, signalName, toolName, error);
			const existing = clusters.get(key);
			if (existing) {
				existing.sampleArtifactIds.push(artifactId);
				existing.sampleTaskIds.push(taskId);
				existing.sampleCount++;
			} else {
				clusters.set(key, {
					clusterId: `${classification.category}-${signalName}-${toolName ? `${toolName}-` : ""}${sha256HexShort(key)}`,
					category: classification.category,
					signal: signalName,
					toolName: toolName || undefined,
					error: error || undefined,
					sampleArtifactIds: [artifactId],
					sampleTaskIds: [taskId],
					sampleCount: 1,
				});
			}
		}
	}

	const result = Array.from(clusters.values())
		.filter((c) => c.sampleCount >= minClusterSize)
		.sort((a, b) => b.sampleCount - a.sampleCount || a.clusterId.localeCompare(b.clusterId));

	if (options.maxClusters !== undefined) {
		return result.slice(0, options.maxClusters);
	}
	return result;
}

function clusterToPolicy(cluster: FailureCluster): {
	capability: CandidateCapability;
	declarations: DeclarativePolicies;
} {
	if (cluster.signal === "repeatedToolFailure" && cluster.toolName) {
		return {
			capability: "declarative/tool-prompt",
			declarations: {
				toolPrompts: [
					{
						toolName: cluster.toolName,
						promptSnippet: `Before retrying ${cluster.toolName} after a failure, verify arguments, cwd, and that the target exists.`,
					},
				],
			},
		};
	}
	if (cluster.signal === "deliveryMissing") {
		return {
			capability: "declarative/system-guideline",
			declarations: {
				systemGuidelines: [
					"Always produce a concrete deliverable file or explicit failure note before finishing the task.",
				],
			},
		};
	}
	if (cluster.signal === "progressStalled") {
		return {
			capability: "declarative/system-guideline",
			declarations: {
				systemGuidelines: [
					"If repeated identical tool calls produce no progress, stop and ask the user for clarification.",
				],
			},
		};
	}
	if (cluster.signal === "escalationRecommended") {
		return {
			capability: "declarative/system-guideline",
			declarations: {
				systemGuidelines: [
					"When local model quality signals are weak, escalate via the gateway and preserve the escalation join key.",
				],
			},
		};
	}
	return {
		capability: "declarative/system-guideline",
		declarations: {
			systemGuidelines: [`Pay extra attention to ${cluster.category} failures in this domain.`],
		},
	};
}

function buildPolicyDiff(cluster: FailureCluster, declarations: DeclarativePolicies): string {
	const targetPath = `.pi/candidate-extensions/${cluster.clusterId}/policy.json`;
	// Use compact canonical JSON so the diff is stable and deterministic.
	const content = JSON.stringify(declarations);
	return `--- /dev/null\n+++ ${targetPath}\n@@ -0,0 +1 @@\n+${content}\n`;
}

function buildCandidateManifest(
	cluster: FailureCluster,
	capability: CandidateCapability,
	declarations: DeclarativePolicies,
): CandidateExtensionManifest {
	return {
		abiVersion: CANDIDATE_ABI_VERSION,
		name: `source-candidate-${cluster.clusterId}`,
		description: `Declarative policy generated from failure cluster ${cluster.clusterId} (${cluster.category}:${cluster.signal})`,
		generatedFrom: {
			taskId: cluster.sampleTaskIds[0] ?? cluster.sampleArtifactIds[0] ?? "unknown",
			clusterId: cluster.clusterId,
			evidenceArtifactId: cluster.sampleArtifactIds[0] ?? "",
		},
		capabilities: [capability],
		declarations,
	};
}

/**
 * Generates a source_patch candidate artifact from a failure cluster.
 *
 * If `input.cluster` is not provided, the generator discovers clusters and
 * selects the largest one. The resulting artifact is stored in the registry and
 * lineage edges are recorded for each parent.
 */
export function generateSourceCandidate(input: SourceCandidateInput): SourceCandidateResult {
	try {
		let cluster = input.cluster;
		if (!cluster) {
			const clusters = discoverFailureClusters(input.registry, input.clusterOptions);
			if (clusters.length === 0) {
				return { status: "no_cluster" };
			}
			cluster = clusters[0];
		}

		const { capability, declarations } = clusterToPolicy(cluster);
		const diff = buildPolicyDiff(cluster, declarations);
		const candidateManifest = buildCandidateManifest(cluster, capability, declarations);

		const patchInput: SourcePatchArtifactInput = {
			candidateManifest,
			diff,
			parentIds: input.parentIds,
			evidenceRefs: [
				`task:${cluster.sampleTaskIds[0] ?? "unknown"}`,
				`cluster:${cluster.clusterId}`,
				`failure_category:${cluster.category}`,
				`detector_signal:${cluster.signal}`,
			],
			scaffoldHash: input.scaffoldHash,
			modelFingerprint: input.modelFingerprint,
		};

		const stored = storeSourcePatchArtifact(input.registry, patchInput);

		for (const parentId of input.parentIds) {
			input.lineage.recordEdge({
				parentId,
				childId: stored.artifactId,
				operator: "draft",
				diffSummary: `source-candidate-${cluster.clusterId}:${cluster.category}:${cluster.signal}`,
			});
		}

		return { status: "generated", artifactId: stored.artifactId, clusterId: cluster.clusterId };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}
