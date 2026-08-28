/**
 * Evidence sink (Phase 4 P4-1).
 *
 * Builds a composite evidence artifact from the four Phase 1 collector outputs
 * and stores it in the session directory. This module intentionally does not
 * import `packages/agent-server`; it implements a local, structural mirror of
 * the agent-server `evidence-artifact-builder` API so the coding-agent package
 * stays dependency-free.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskLevelDetectorSnapshot } from "@earendil-works/pi-agent-core";
import type { EscalationJoinKey } from "./evolution/escalation-collector.ts";
import type { GraderOutcome, UserCorrection } from "./evolution/outcome-collector.ts";
import type { ProductManifestEntry } from "./evolution/product-manifest-collector.ts";
import type { ToolEvent } from "./evolution/tool-event-collector.ts";
import type { VersionContract } from "./evolution/version-contract.ts";

export interface TeacherCorrectionRef {
	kind: "teacher_correction";
	data_class: "pending_0b";
	retention_policy_ref: "pending_0b";
	task_id: string;
	gateway_marker: EscalationJoinKey;
	local_finish_reason: string;
	cloud_finish_reason: string;
	local_outcome?: string;
	cloud_outcome?: string;
	user_correction?: { correction_type: string; content: string; helpful: boolean };
	correction_text: string;
	improvement_basis: "grader" | "finish_reason" | "user_correction";
	dlp_findings: { pattern: string; location: string }[];
	aligned_at: number;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface ArtifactManifest {
	kind: "composite";
	parent_ids: string[];
	operator: "draft";
	scope: string[];
	evidence_refs: string[];
	scaffold_hash: string;
	model_fingerprint: string;
	data_class: "user_content";
	retention_policy_ref: string;
	blob_hashes: string[];
}

export interface EvidenceArtifactRecord {
	artifactId: string;
	manifest: ArtifactManifest;
	blobs: Buffer[];
	storedAt?: { manifestPath: string; blobsDir: string };
}

export interface EvidenceArtifactInput {
	taskId: string;
	versionContract: VersionContract;
	toolEvents: ToolEvent[];
	productManifest: ProductManifestEntry[];
	graderOutcomes: GraderOutcome[];
	userCorrections: UserCorrection[];
	escalationJoinKeys: EscalationJoinKey[];
	/** Optional frozen shadow task-level detector snapshot. */
	detectorSnapshot?: TaskLevelDetectorSnapshot;
	/** Optional aligned teacher correction ref produced by P4-3 backflow alignment. */
	teacherCorrectionRef?: TeacherCorrectionRef;
}

export interface EvidenceSinkOptions {
	/** Directory where artifacts are persisted. If omitted, artifacts are built in memory only. */
	storeDir?: string;
}

export interface EvidenceSink {
	buildAndStore(input: EvidenceArtifactInput): EvidenceArtifactRecord | undefined;
}

export function createEvidenceSink(options: EvidenceSinkOptions = {}): EvidenceSink {
	return new EvidenceSinkImpl(options.storeDir);
}

class EvidenceSinkImpl implements EvidenceSink {
	private readonly storeDir?: string;

	constructor(storeDir?: string) {
		this.storeDir = storeDir;
	}

	buildAndStore(input: EvidenceArtifactInput): EvidenceArtifactRecord | undefined {
		if (!this.isBuildableInput(input)) {
			return undefined;
		}

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
			...(input.detectorSnapshot !== undefined ? { detector_snapshot: input.detectorSnapshot } : {}),
			...(input.teacherCorrectionRef !== undefined ? { teacher_correction_ref: input.teacherCorrectionRef } : {}),
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
				...(input.detectorSnapshot ? [`detector_signals:${input.detectorSnapshot.signals.length}`] : []),
				...(input.teacherCorrectionRef ? [`teacher_correction_refs:1`] : []),
			],
			scaffold_hash: contract.scaffoldHash,
			model_fingerprint: JSON.stringify({
				source: "phase1_evidence_collectors",
				artifact_id: contract.artifactId,
				snapshot_sha: contract.snapshotSha,
			}),
			data_class: "user_content",
			retention_policy_ref: "pending_0b",
			blob_hashes: [sha256Hex(evidenceBlob), sha256Hex(productManifestBlob)],
		};

		const artifactId = computeArtifactId(manifest);
		const record: EvidenceArtifactRecord = { artifactId, manifest, blobs: [evidenceBlob, productManifestBlob] };

		if (this.storeDir) {
			record.storedAt = this.persistArtifact(artifactId, manifest, record.blobs);
		}

		return record;
	}

	private isBuildableInput(input: EvidenceArtifactInput): boolean {
		if (!input || typeof input !== "object") return false;
		if (!isNonEmptyString(input.taskId)) return false;
		if (!isValidVersionContract(input.versionContract)) return false;
		for (const field of [
			"toolEvents",
			"productManifest",
			"graderOutcomes",
			"userCorrections",
			"escalationJoinKeys",
		] as const) {
			if (!Array.isArray(input[field])) return false;
		}
		return true;
	}

	private persistArtifact(
		artifactId: string,
		manifest: ArtifactManifest,
		blobs: Buffer[],
	): { manifestPath: string; blobsDir: string } {
		const artifactDir = join(this.storeDir!, "evidence-artifacts", artifactId);
		const blobsDir = join(artifactDir, "blobs");
		mkdirSync(blobsDir, { recursive: true });

		const manifestPath = join(artifactDir, "manifest.json");
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

		for (let i = 0; i < blobs.length; i++) {
			writeFileSync(join(blobsDir, `${i}.bin`), blobs[i]);
		}

		return { manifestPath, blobsDir };
	}
}

function isValidVersionContract(value: unknown): value is VersionContract {
	if (!value || typeof value !== "object") return false;
	const contract = value as Partial<VersionContract>;
	return (
		isNonEmptyString(contract.artifactId) &&
		isNonEmptyString(contract.snapshotSha) &&
		typeof contract.scaffoldHash === "string" &&
		SHA256_HEX_PATTERN.test(contract.scaffoldHash)
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toCanonicalBlob(value: unknown): Buffer {
	const normalized: unknown = JSON.parse(JSON.stringify(value));
	return Buffer.from(canonicalJson(normalized), "utf8");
}

function sha256Hex(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function computeArtifactId(manifest: ArtifactManifest): string {
	const manifestText = canonicalJson(manifest);
	const blobHashesText = canonicalJson(manifest.blob_hashes);
	return createHash("sha256")
		.update(manifestText + blobHashesText, "utf8")
		.digest("hex");
}

/**
 * Canonical JSON serializer matching the agent-server `canonical.ts` spec:
 * - Object keys sorted by UTF-16 code unit.
 * - No whitespace.
 * - Finite numbers only; `-0` normalized to `0`; safe integers as plain decimal.
 * - `undefined`, `function`, `symbol`, `bigint`, and non-finite numbers throw.
 */
function canonicalJson(value: unknown): string {
	return serializeValue(value);
}

function serializeValue(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			return serializeNumber(value);
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map(serializeValue).join(",")}]`;
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`).join(",")}}`;
		}
		default:
			throw new Error(
				`canonicalJson: unsupported value type "${typeof value}" (undefined/function/symbol/bigint are not JSON)`,
			);
	}
}

function serializeNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error(`canonicalJson: non-finite number ${value} cannot be serialized`);
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	if (Number.isSafeInteger(value)) {
		return String(value);
	}
	return JSON.stringify(value);
}
