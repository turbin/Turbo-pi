/**
 * T2: artifact manifest TS types + field validator.
 *
 * Field names and meanings mirror the T1 `artifact_immutable_manifests` table
 * (architecture §6.1) one-to-one. The manifest is the carrier of the canonical
 * JSON; storage metadata (artifact_id / canonical_manifest / created_at) is
 * NOT manifest fields — the validator fails closed on unknown fields so the
 * hash input carries no timestamp/random noise.
 */

export const ARTIFACT_KINDS = ["experience_snapshot", "scaffold_config", "source_patch", "composite"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const MANIFEST_OPERATORS = ["draft", "improve", "debug", "crossover", "consolidate", "rollback"] as const;
export type ManifestOperator = (typeof MANIFEST_OPERATORS)[number];

export const DATA_CLASSES = ["diagnostic_ops", "user_content", "aggregate_only"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** sha256 hex text (64 lowercase chars). */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Frozen manifest field set (same names as architecture §6.1, incl. blob_hashes). */
export const MANIFEST_FIELDS = [
	"kind",
	"parent_ids",
	"operator",
	"scope",
	"evidence_refs",
	"scaffold_hash",
	"model_fingerprint",
	"data_class",
	"retention_policy_ref",
	"blob_hashes",
] as const;

export interface ArtifactManifest {
	/** Mutation-plane kind (architecture §6.1 CHECK enum). */
	kind: ArtifactKind;
	/** JSON array; generation-0 = []. */
	parent_ids: string[];
	/** D5: generation-0 = "draft". */
	operator: ManifestOperator;
	/** JSON whitelist of modifiable files/fields; gen0 points at the frozen path list. */
	scope: string[];
	/** JSON array; failure-cluster/issue/trace/task IDs; gen0 = frozen decision-record refs. */
	evidence_refs: string[];
	/** Combined hash of system prompt/tools/extensions/settings/code commit (sha256 hex). */
	scaffold_hash: string;
	/** JSON object text: generating model + sampling contract (must parse as a JSON object). */
	model_fingerprint: string;
	/** Minimal frozen enum for 0a; gen0 class attribution pending (architecture §9 P3). */
	data_class: DataClass;
	/** Bundle-internal policy file ref; must point at the `pending_0b` placeholder until decided. */
	retention_policy_ref: string;
	/** JSON array: SHA256 of each bundle blob (input to artifact_id), non-empty. */
	blob_hashes: string[];
}

export type ManifestValidation = { ok: true; manifest: ArtifactManifest } | { ok: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown, minLength: number): value is string[] {
	return Array.isArray(value) && value.length >= minLength && value.every(isNonEmptyString);
}

function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

/** model_fingerprint must be parseable JSON object text (model + sampling contract). */
function isJsonObjectText(value: unknown): value is string {
	if (!isNonEmptyString(value)) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

/**
 * Field-level validation (fail closed): missing required field, invalid value,
 * or unknown field (timestamp / random / derived id) -> field-level error list,
 * write must be refused.
 */
export function validateManifest(input: unknown): ManifestValidation {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, errors: ["manifest: expected a JSON object"] };
	}
	const record = input as Record<string, unknown>;
	const errors: string[] = [];

	for (const key of Object.keys(record)) {
		if (!(MANIFEST_FIELDS as readonly string[]).includes(key)) {
			errors.push(
				`manifest.${key}: unknown field (not in the frozen manifest schema; timestamps/random fields rejected)`,
			);
		}
	}

	if (!isNonEmptyString(record.kind) || !(ARTIFACT_KINDS as readonly string[]).includes(record.kind)) {
		errors.push(`manifest.kind: must be one of ${ARTIFACT_KINDS.join(" | ")}`);
	}
	if (!Array.isArray(record.parent_ids) || !record.parent_ids.every(isNonEmptyString)) {
		errors.push("manifest.parent_ids: must be an array of strings");
	}
	if (!isNonEmptyString(record.operator) || !(MANIFEST_OPERATORS as readonly string[]).includes(record.operator)) {
		errors.push(`manifest.operator: must be one of ${MANIFEST_OPERATORS.join(" | ")}`);
	}
	if (!isStringArray(record.scope, 1)) {
		errors.push("manifest.scope: must be a non-empty array of strings");
	}
	if (!Array.isArray(record.evidence_refs) || !record.evidence_refs.every(isNonEmptyString)) {
		errors.push("manifest.evidence_refs: must be an array of strings");
	}
	if (!isSha256Hex(record.scaffold_hash)) {
		errors.push("manifest.scaffold_hash: must be 64 lowercase hex chars (sha256)");
	}
	if (!isJsonObjectText(record.model_fingerprint)) {
		errors.push("manifest.model_fingerprint: must be parseable JSON object text (model + sampling contract)");
	}
	if (!isNonEmptyString(record.data_class) || !(DATA_CLASSES as readonly string[]).includes(record.data_class)) {
		errors.push(`manifest.data_class: must be one of ${DATA_CLASSES.join(" | ")}`);
	}
	if (!isNonEmptyString(record.retention_policy_ref)) {
		errors.push(
			"manifest.retention_policy_ref: required non-empty string (use pending_0b placeholder until decided)",
		);
	}
	if (!isStringArray(record.blob_hashes, 1)) {
		errors.push("manifest.blob_hashes: must be a non-empty array of strings");
	}
	for (const hash of Array.isArray(record.blob_hashes) ? record.blob_hashes : []) {
		if (!isSha256Hex(hash)) {
			errors.push(`manifest.blob_hashes: invalid sha256 hex "${typeof hash === "string" ? hash : "<non-string>"}"`);
			break;
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true, manifest: record as unknown as ArtifactManifest };
}
