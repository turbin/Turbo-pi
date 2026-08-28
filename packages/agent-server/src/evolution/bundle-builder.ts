import { createHash } from "node:crypto";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { canonicalJson } from "./canonical.ts";

/**
 * T3: generation-0 bundle builder.
 *
 * Builds the immutable generation-0 artifact that freezes the current active
 * scaffold / experience / model / config baseline. The manifest carries only
 * frozen fields (architecture §6.1); the remaining generation-0 specific
 * metadata (experience snapshot SHA, config fingerprint, denylist version,
 * coverage report) is serialized into a canonical JSON blob so the full bundle
 * can be reconstructed and audited.
 *
 * D5: operator='draft', parent_ids=[].
 * §9 P3 / P7: retention_policy_ref='pending_0b'; coverage report honestly
 * labels covered and uncovered paths.
 */

export interface FrozenFingerprints {
	/** Combined hash of system prompt / tools / extensions / settings / code commit. */
	scaffold_hash: string;
	/** SHA256 of the generation-0 experience snapshot. */
	experience_snapshot_sha: string;
	/** JSON object text: generating model + sampling contract. */
	model_fingerprint: string;
	/** SHA256 of the relevant configuration bundle. */
	config_fingerprint: string;
	/** M0 denylist / runner denylist version reference. */
	denylist_version: string;
}

export interface GenerationZeroBundle {
	manifest: ArtifactManifest;
	blobs: Buffer[];
	artifactId: string;
}

export interface CoverageReport {
	covered: readonly string[];
	uncovered: readonly string[];
}

export interface Gen0Metadata {
	contract_id: string;
	experience_snapshot_sha: string;
	config_fingerprint: string;
	denylist_version: string;
	coverage: CoverageReport;
}

const GEN0_EVIDENCE_REFS = [
	"doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md",
	"doc/design/plans/2026-08-28-self-evolving-phase0a-tasks.md",
	"doc/design/progress/2026-08-28-existing-modules-survey.md",
];

function assertFingerprints(fingerprints: FrozenFingerprints): void {
	const missing: string[] = [];
	for (const [key, value] of Object.entries(fingerprints)) {
		if (typeof value !== "string" || value.length === 0) {
			missing.push(key);
		}
	}
	if (missing.length > 0) {
		throw new Error(`missing fingerprint: ${missing.join(", ")}`);
	}
}

/**
 * Build and store a generation-0 bundle.
 *
 * The caller supplies the frozen fingerprints (see `fingerprint.ts`). The
 * returned artifact_id is the content-addressed identity of the canonical
 * manifest; the metadata blob preserves the original snapshot SHAs for
 * reconstruction and audit.
 */
export function buildGenerationZeroBundle(
	registry: ArtifactRegistry,
	fingerprints: FrozenFingerprints,
	contractId: string,
): GenerationZeroBundle {
	assertFingerprints(fingerprints);

	const coverage: CoverageReport = {
		covered: [
			"packages/coding-agent/.pi/config.json",
			"packages/coding-agent/.pi/system-prompt.md",
			"packages/agent-server/data/experience-store.db:active",
		],
		uncovered: [
			"runtime environment variables (Phase 0b)",
			"full dependency lockfile digest (Phase 0b)",
			"production WORM anchor (Phase 0b)",
		],
	};

	const metadata: Gen0Metadata = {
		contract_id: contractId,
		experience_snapshot_sha: fingerprints.experience_snapshot_sha,
		config_fingerprint: fingerprints.config_fingerprint,
		denylist_version: fingerprints.denylist_version,
		coverage,
	};

	const metadataBlob = Buffer.from(canonicalJson(metadata), "utf8");
	const metadataHash = createHash("sha256").update(metadataBlob).digest("hex");

	const manifest: ArtifactManifest = {
		kind: "composite",
		parent_ids: [],
		operator: "draft",
		scope: ["M0-frozen-paths"],
		evidence_refs: GEN0_EVIDENCE_REFS,
		scaffold_hash: fingerprints.scaffold_hash,
		model_fingerprint: fingerprints.model_fingerprint,
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [metadataHash],
	};

	const artifactId = registry.storeArtifact(manifest, [metadataBlob]);
	return { manifest, blobs: [metadataBlob], artifactId };
}
