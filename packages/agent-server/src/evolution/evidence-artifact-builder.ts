import { createHash } from "node:crypto";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { SHA256_HEX_PATTERN } from "./artifact-schema.ts";
import { canonicalJson } from "./canonical.ts";
import type { EscalationJoinKey } from "./evidence-schema.ts";

/**
 * P1-T18: evidence artifact builder.
 *
 * Aggregates every Phase 1 collector output (tool events, product manifest,
 * grader outcomes, user corrections, escalation join keys) plus the gen0
 * version contract into a single content-addressed `composite` artifact and
 * stores it through the T3 artifact registry.
 *
 * Cross-package boundary: the collectors live in
 * `packages/coding-agent/src/core/evolution/`, which this package must not
 * import. The record types below are structural mirrors of the collector
 * interfaces (same field names/types); EscalationJoinKey is imported from the
 * T7 evidence-schema, which already froze the identical shape.
 *
 * Blob layout (order is frozen and mirrored in manifest.blob_hashes):
 *   blob[0]: canonical JSON of the aggregated evidence payload
 *   blob[1]: canonical JSON of the product manifest entries
 */

/** Structural mirror of coding-agent core/evolution/version-contract.ts. */
export interface VersionContract {
	artifactId: string;
	scaffoldHash: string;
	snapshotSha: string;
}

/** Structural mirror of coding-agent core/evolution/tool-event-collector.ts. */
export interface ToolEvent {
	toolName: string;
	argsHash: string;
	resultHash: string;
	durationMs: number;
	error?: string;
	timestamp: number;
}

/** Structural mirror of coding-agent core/evolution/product-manifest-collector.ts. */
export interface ProductManifestEntry {
	path: string;
	sizeBytes: number;
	sha256: string;
	mtimeMs: number;
}

/** Structural mirror of coding-agent core/evolution/outcome-collector.ts. */
export type GraderOutcomeKind = "success" | "partial" | "failure" | "aborted";

export interface GraderOutcome {
	taskId: string;
	outcome: GraderOutcomeKind;
	graderSha: string;
	score?: number;
	notes?: string;
	timestamp: string;
}

export type CorrectionType = "explicit" | "implicit";

export interface UserCorrection {
	taskId: string;
	correctionType: CorrectionType;
	content: string;
	timestamp: string;
}

export interface EvidenceArtifactInput {
	taskId: string;
	versionContract: VersionContract;
	toolEvents: ToolEvent[];
	productManifest: ProductManifestEntry[];
	graderOutcomes: GraderOutcome[];
	userCorrections: UserCorrection[];
	escalationJoinKeys: EscalationJoinKey[];
}

export interface EvidenceArtifact {
	manifest: ArtifactManifest;
	blobs: Buffer[];
}

export interface StoredEvidenceArtifact extends EvidenceArtifact {
	artifactId: string;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed input validation: any missing/malformed required field rejects the build. */
function assertValidInput(input: EvidenceArtifactInput): void {
	const errors: string[] = [];
	if (!isRecord(input)) {
		throw new Error("evidence artifact input: expected an object");
	}
	if (!isNonEmptyString(input.taskId)) {
		errors.push("taskId: expected non-empty string");
	}
	if (!isRecord(input.versionContract)) {
		errors.push("versionContract: expected object");
	} else {
		if (!isNonEmptyString(input.versionContract.artifactId)) {
			errors.push("versionContract.artifactId: expected non-empty string");
		}
		if (
			typeof input.versionContract.scaffoldHash !== "string" ||
			!SHA256_HEX_PATTERN.test(input.versionContract.scaffoldHash)
		) {
			errors.push("versionContract.scaffoldHash: expected 64 lowercase hex chars (sha256)");
		}
		if (!isNonEmptyString(input.versionContract.snapshotSha)) {
			errors.push("versionContract.snapshotSha: expected non-empty string");
		}
	}
	const arrayFields = [
		"toolEvents",
		"productManifest",
		"graderOutcomes",
		"userCorrections",
		"escalationJoinKeys",
	] as const;
	for (const field of arrayFields) {
		if (!Array.isArray(input[field])) {
			errors.push(`${field}: expected array (may be empty)`);
		}
	}
	if (errors.length > 0) {
		throw new Error(`invalid evidence artifact input: ${errors.join("; ")}`);
	}
}

/**
 * Serializes a payload to a canonical JSON blob. A JSON round-trip first drops
 * `undefined` optional fields (ToolEvent.error, GraderOutcome.score/notes),
 * which canonicalJson rejects by design.
 */
function toCanonicalBlob(value: unknown): Buffer {
	const normalized: unknown = JSON.parse(JSON.stringify(value));
	return Buffer.from(canonicalJson(normalized), "utf8");
}

function blobSha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Builds the composite evidence artifact: manifest + blobs. Nothing is stored;
 * pass the result to a registry (or use storeEvidenceArtifact).
 */
export function buildEvidenceArtifact(input: EvidenceArtifactInput): EvidenceArtifact {
	assertValidInput(input);
	const contract = input.versionContract;

	const evidencePayload = {
		task_id: input.taskId,
		version_contract: {
			artifact_id: contract.artifactId,
			scaffold_hash: contract.scaffoldHash,
			snapshot_sha: contract.snapshotSha,
		},
		tool_events: input.toolEvents,
		grader_outcomes: input.graderOutcomes,
		user_corrections: input.userCorrections,
		escalation_join_keys: input.escalationJoinKeys,
	};

	const evidenceBlob = toCanonicalBlob(evidencePayload);
	const productManifestBlob = toCanonicalBlob(input.productManifest);

	const manifest: ArtifactManifest = {
		kind: "composite",
		parent_ids: [],
		operator: "draft",
		scope: ["evidence"],
		evidence_refs: [
			`task:${input.taskId}`,
			`tool_events:${input.toolEvents.length}`,
			`product_manifest_entries:${input.productManifest.length}`,
			`grader_outcomes:${input.graderOutcomes.length}`,
			`user_corrections:${input.userCorrections.length}`,
			`escalation_join_keys:${input.escalationJoinKeys.length}`,
		],
		scaffold_hash: contract.scaffoldHash,
		// Evidence artifacts are not model-generated; the fingerprint slot carries
		// the gen0 version-contract identity instead of a sampling contract.
		model_fingerprint: JSON.stringify({
			source: "phase1_evidence_collectors",
			artifact_id: contract.artifactId,
			snapshot_sha: contract.snapshotSha,
		}),
		// User corrections carry free-form user content, so the bundle cannot be
		// classified as diagnostic_ops.
		data_class: "user_content",
		retention_policy_ref: "pending_0b",
		blob_hashes: [blobSha256(evidenceBlob), blobSha256(productManifestBlob)],
	};

	return { manifest, blobs: [evidenceBlob, productManifestBlob] };
}

/** Builds the evidence artifact and stores it via the artifact registry; returns the artifact_id. */
export function storeEvidenceArtifact(
	registry: ArtifactRegistry,
	input: EvidenceArtifactInput,
): StoredEvidenceArtifact {
	const built = buildEvidenceArtifact(input);
	const artifactId = registry.storeArtifact(built.manifest, built.blobs);
	return { artifactId, manifest: built.manifest, blobs: built.blobs };
}
