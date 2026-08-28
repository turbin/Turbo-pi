import { SHA256_HEX_PATTERN } from "./artifact-schema.ts";
import { FAILURE_TAXONOMY, type FailureTaxonomy } from "./taxonomy.ts";

/**
 * T7: recordEvidence contract types and field validators.
 *
 * This file freezes the write contract for the evidence plane. It does NOT
 * implement collection hooks (Phase 1). Any missing or malformed required field
 * returns a field-level error; the write must be refused (fail closed, C1).
 */

export const EVIDENCE_OUTCOMES = ["success", "failure", "inconclusive"] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

export const TOOL_EVENT_OUTCOMES = ["ok", "error"] as const;
export type ToolEventOutcome = (typeof TOOL_EVENT_OUTCOMES)[number];

export interface ToolEventSummary {
	toolName: string;
	canonicalRequestHash: string;
	outcome: ToolEventOutcome;
}

export interface ProductManifest {
	/** SHA256 of each artifact blob; same format as ArtifactManifest.blob_hashes. */
	blobHashes: string[];
	description: string;
}

export interface EscalationJoinKey {
	/**
	 * Sequence number from the agent-gateway request/escalation log. Matches the
	 * gateway's sequence field so evidence can be joined to quality_signals for
	 * post-run analysis.
	 */
	gatewaySequence: number;
	/** SHA256 of the gateway quality_signals snapshot used for escalation. */
	qualitySignalsSha: string;
}

export interface RecordEvidenceInput {
	taskId: string;
	traceId: string;
	artifactRefs: string[];
	toolEvents: ToolEventSummary[];
	tokens: number;
	costMicros: number;
	outcome: EvidenceOutcome;
	productManifest?: ProductManifest;
	escalationJoinKey?: EscalationJoinKey;
	failureClassification?: FailureTaxonomy;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isToolEventSummary(value: unknown): value is ToolEventSummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		isNonEmptyString(record.toolName) &&
		isSha256Hex(record.canonicalRequestHash) &&
		isNonEmptyString(record.outcome) &&
		TOOL_EVENT_OUTCOMES.includes(record.outcome as ToolEventOutcome)
	);
}

function pushError(errors: string[], field: string, message: string): void {
	errors.push(`${field}: ${message}`);
}

export function validateEscalationJoinKey(value: unknown): ValidationResult<EscalationJoinKey> {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: ["escalationJoinKey: expected object"] };
	}
	const record = value as Record<string, unknown>;
	if (!isSafeNonNegativeInteger(record.gatewaySequence)) {
		pushError(errors, "escalationJoinKey.gatewaySequence", "expected non-negative integer");
	}
	if (!isSha256Hex(record.qualitySignalsSha)) {
		pushError(errors, "escalationJoinKey.qualitySignalsSha", "expected 64 lowercase hex chars");
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: record as unknown as EscalationJoinKey };
}

export function validateProductManifest(value: unknown): ValidationResult<ProductManifest> {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, errors: ["productManifest: expected object"] };
	}
	const record = value as Record<string, unknown>;
	if (!isStringArray(record.blobHashes) || record.blobHashes.length === 0 || !record.blobHashes.every(isSha256Hex)) {
		pushError(errors, "productManifest.blobHashes", "expected non-empty array of sha256 hex strings");
	}
	if (!isNonEmptyString(record.description)) {
		pushError(errors, "productManifest.description", "expected non-empty string");
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: record as unknown as ProductManifest };
}

export function validateRecordEvidence(input: unknown): ValidationResult<RecordEvidenceInput> {
	const errors: string[] = [];
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, errors: ["recordEvidence: expected object"] };
	}
	const record = input as Record<string, unknown>;

	if (!isNonEmptyString(record.taskId)) pushError(errors, "taskId", "expected non-empty string");
	if (!isNonEmptyString(record.traceId)) pushError(errors, "traceId", "expected non-empty string");
	if (!isStringArray(record.artifactRefs) || record.artifactRefs.length === 0) {
		pushError(errors, "artifactRefs", "expected non-empty array of strings");
	}
	if (
		!Array.isArray(record.toolEvents) ||
		record.toolEvents.length === 0 ||
		!record.toolEvents.every(isToolEventSummary)
	) {
		pushError(errors, "toolEvents", "expected non-empty array of valid tool event summaries");
	}
	if (!isSafeNonNegativeInteger(record.tokens)) pushError(errors, "tokens", "expected non-negative integer");
	if (!isSafeNonNegativeInteger(record.costMicros)) pushError(errors, "costMicros", "expected non-negative integer");
	if (!isNonEmptyString(record.outcome) || !EVIDENCE_OUTCOMES.includes(record.outcome as EvidenceOutcome)) {
		pushError(errors, "outcome", `expected one of ${EVIDENCE_OUTCOMES.join(" | ")}`);
	}
	if (record.failureClassification !== undefined) {
		if (!FAILURE_TAXONOMY.includes(record.failureClassification as FailureTaxonomy)) {
			pushError(errors, "failureClassification", `expected one of ${FAILURE_TAXONOMY.join(" | ")}`);
		}
	}
	if (record.productManifest !== undefined) {
		const pm = validateProductManifest(record.productManifest);
		if (!pm.ok) errors.push(...pm.errors);
	}
	if (record.escalationJoinKey !== undefined) {
		const ej = validateEscalationJoinKey(record.escalationJoinKey);
		if (!ej.ok) errors.push(...ej.errors);
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: record as unknown as RecordEvidenceInput };
}
