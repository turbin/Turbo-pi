import type Database from "better-sqlite3";
import {
	ARTIFACT_KINDS,
	type ArtifactKind,
	DATA_CLASSES,
	type DataClass,
	DRIFT_FLAGS,
	type DriftFlag,
	EVENT_TYPES,
	type EventType,
	JOURNAL_STATES,
	type JournalState,
	OPERATORS,
	type Operator,
	VERDICTS,
	type Verdict,
} from "./schema.ts";

/**
 * Phase 0a T1: append-only DAO for evolution.db.
 *
 * The only write surface of the control plane: every public method appends
 * one row and returns its primary key. There is deliberately no UPDATE,
 * DELETE, REPLACE or upsert path — even if the SQLite triggers were absent,
 * this class can never mutate an existing row (defense in depth, T1 risk).
 *
 * Inputs are validated field-by-field before any SQL runs; a rejection throws
 * `AppendRejectedError` listing every offending field (fail closed, A2).
 */

export class AppendRejectedError extends Error {
	readonly reasons: readonly string[];

	constructor(reasons: readonly string[]) {
		super(`append rejected: ${reasons.join("; ")}`);
		this.name = "AppendRejectedError";
		this.reasons = reasons;
	}
}

// ---------------------------------------------------------------------------
// Input contracts (camelCase mirrors of the frozen snake_case columns).
// Arrays are TS arrays serialized to TEXT JSON; JSON documents are TEXT.
// ---------------------------------------------------------------------------

export interface ArtifactInput {
	artifactId: string;
	kind: ArtifactKind;
	/** JSON array; omitted -> '[]' (generation-0 has no parents). */
	parentIds?: string[];
	operator: Operator;
	/** JSON document: allowed-file whitelist. */
	scope: string;
	/** JSON array; omitted -> '[]'. */
	evidenceRefs?: string[];
	scaffoldHash: string;
	/** JSON document: generating model + sampling contract. */
	modelFingerprint: string;
	dataClass: DataClass;
	retentionPolicyRef: string;
	/** JSON array of blob SHA256s (input to artifact_id). */
	blobHashes: string[];
	/** Canonical manifest JSON (input to artifact_id). */
	canonicalManifest: string;
	/** INTEGER epoch ms. */
	createdAt: number;
}

export interface AttestationInput {
	attestationId: string;
	artifactId: string;
	contractId: string;
	/** NULL for generation-0. */
	baselineArtifactId?: string | null;
	taskManifestSha: string;
	graderSha: string;
	workspaceTreeSha: string;
	environmentFingerprint: string;
	providerModel: string;
	/** JSON document: canonical sampling parameters. */
	samplingContract: string;
	metricsHash: string;
	verdict: Verdict;
	realTokens: number;
	costMicros: number;
	traceRef: string;
	failureClassification: string;
	signerKeyId: string;
	signature: string;
	/** INTEGER epoch ms. */
	attestedAt: number;
}

export interface RevocationInput {
	attestationId: string;
	reason: string;
	revokerKeyId: string;
	signature: string;
	/** INTEGER epoch ms. */
	revokedAt: number;
}

export interface DeploymentEventInput {
	eventId: string;
	/** Global monotonic seq; duplicates rejected. */
	seq: number;
	slot: string;
	eventType: EventType;
	artifactId: string;
	/** NULL only for the first event of the stream (CAS chain head). */
	previousEventId?: string | null;
	previousArtifactId?: string | null;
	operator: string;
	reason: string;
	keyId: string;
	signature: string;
	/** INTEGER epoch ms. */
	occurredAt: number;
}

export interface ResolvedManifestInput {
	resolvedId: string;
	taskId: string;
	slot: string;
	artifactId: string;
	deploymentEventId: string;
	/** JSON array: SHA256 of every blob actually loaded. */
	resolvedBlobShas: string[];
	resolvedScaffoldHash: string;
	actualProviderModel: string;
	actualApiIdentifier: string;
	envSnapshotHash: string;
	driftFlag: DriftFlag;
	/** INTEGER epoch ms. */
	resolvedAt: number;
}

export interface JournalInput {
	operation: string;
	payloadHash: string;
	/** 'written' = half-written, never treated as success (A11). */
	state: JournalState;
	/** INTEGER epoch ms. */
	createdAt: number;
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

type FieldKind = "text" | "int" | "jsonText" | "stringArray";

interface FieldSpec {
	kind: FieldKind;
	/** CHECK enum allow-list; validated before SQLite. */
	enum?: readonly string[];
	/** Optional fields may be undefined/null and are skipped. */
	required?: boolean;
}

function validateFields(record: object, fields: Record<string, FieldSpec>): void {
	const input = record as Record<string, unknown>;
	const reasons: string[] = [];
	for (const [name, spec] of Object.entries(fields)) {
		const value = input[name];
		if (value === undefined || value === null) {
			if (spec.required !== false) reasons.push(`missing required field: ${name}`);
			continue;
		}
		if (spec.enum && !spec.enum.includes(value as never)) {
			reasons.push(`invalid ${name}: ${String(value)} (allowed: ${spec.enum.join(", ")})`);
			continue;
		}
		switch (spec.kind) {
			case "text":
				if (typeof value !== "string" || value.length === 0)
					reasons.push(`invalid ${name}: expected non-empty string`);
				break;
			case "int":
				if (typeof value !== "number" || !Number.isSafeInteger(value))
					reasons.push(`invalid ${name}: expected integer epoch ms`);
				break;
			case "jsonText":
				if (typeof value !== "string") {
					reasons.push(`invalid ${name}: expected JSON string`);
					break;
				}
				try {
					JSON.parse(value);
				} catch {
					reasons.push(`invalid ${name}: not valid JSON`);
				}
				break;
			case "stringArray":
				if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
					reasons.push(`invalid ${name}: expected array of strings`);
				}
				break;
		}
	}
	if (reasons.length > 0) throw new AppendRejectedError(reasons);
}

const OPTIONAL = { required: false };

const ARTIFACT_FIELDS: Record<keyof ArtifactInput, FieldSpec> = {
	artifactId: { kind: "text" },
	kind: { kind: "text", enum: ARTIFACT_KINDS },
	parentIds: { kind: "stringArray", ...OPTIONAL },
	operator: { kind: "text", enum: OPERATORS },
	scope: { kind: "jsonText" },
	evidenceRefs: { kind: "stringArray", ...OPTIONAL },
	scaffoldHash: { kind: "text" },
	modelFingerprint: { kind: "jsonText" },
	dataClass: { kind: "text", enum: DATA_CLASSES },
	retentionPolicyRef: { kind: "text" },
	blobHashes: { kind: "stringArray" },
	canonicalManifest: { kind: "jsonText" },
	createdAt: { kind: "int" },
};

const ATTESTATION_FIELDS: Record<keyof AttestationInput, FieldSpec> = {
	attestationId: { kind: "text" },
	artifactId: { kind: "text" },
	contractId: { kind: "text" },
	baselineArtifactId: { kind: "text", ...OPTIONAL },
	taskManifestSha: { kind: "text" },
	graderSha: { kind: "text" },
	workspaceTreeSha: { kind: "text" },
	environmentFingerprint: { kind: "text" },
	providerModel: { kind: "text" },
	samplingContract: { kind: "jsonText" },
	metricsHash: { kind: "text" },
	verdict: { kind: "text", enum: VERDICTS },
	realTokens: { kind: "int" },
	costMicros: { kind: "int" },
	traceRef: { kind: "text" },
	failureClassification: { kind: "text" },
	signerKeyId: { kind: "text" },
	signature: { kind: "text" },
	attestedAt: { kind: "int" },
};

const REVOCATION_FIELDS: Record<keyof RevocationInput, FieldSpec> = {
	attestationId: { kind: "text" },
	reason: { kind: "text" },
	revokerKeyId: { kind: "text" },
	signature: { kind: "text" },
	revokedAt: { kind: "int" },
};

const EVENT_FIELDS: Record<keyof DeploymentEventInput, FieldSpec> = {
	eventId: { kind: "text" },
	seq: { kind: "int" },
	slot: { kind: "text" },
	eventType: { kind: "text", enum: EVENT_TYPES },
	artifactId: { kind: "text" },
	previousEventId: { kind: "text", ...OPTIONAL },
	previousArtifactId: { kind: "text", ...OPTIONAL },
	operator: { kind: "text" },
	reason: { kind: "text" },
	keyId: { kind: "text" },
	signature: { kind: "text" },
	occurredAt: { kind: "int" },
};

const RESOLVED_FIELDS: Record<keyof ResolvedManifestInput, FieldSpec> = {
	resolvedId: { kind: "text" },
	taskId: { kind: "text" },
	slot: { kind: "text" },
	artifactId: { kind: "text" },
	deploymentEventId: { kind: "text" },
	resolvedBlobShas: { kind: "stringArray" },
	resolvedScaffoldHash: { kind: "text" },
	actualProviderModel: { kind: "text" },
	actualApiIdentifier: { kind: "text" },
	envSnapshotHash: { kind: "text" },
	driftFlag: { kind: "text", enum: DRIFT_FLAGS },
	resolvedAt: { kind: "int" },
};

const JOURNAL_FIELDS: Record<keyof JournalInput, FieldSpec> = {
	operation: { kind: "text" },
	payloadHash: { kind: "text" },
	state: { kind: "text", enum: JOURNAL_STATES },
	createdAt: { kind: "int" },
};

// ---------------------------------------------------------------------------
// Append-only DAO
// ---------------------------------------------------------------------------

export class AppendOnlyDao {
	readonly db: Database.Database;
	private readonly artifactStmt: Database.Statement;
	private readonly attestationStmt: Database.Statement;
	private readonly revocationStmt: Database.Statement;
	private readonly eventStmt: Database.Statement;
	private readonly resolvedStmt: Database.Statement;
	private readonly journalStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.artifactStmt = db.prepare(`
			INSERT INTO artifact_immutable_manifests
				(artifact_id, kind, parent_ids, operator, scope, evidence_refs, scaffold_hash,
				 model_fingerprint, data_class, retention_policy_ref, blob_hashes, canonical_manifest, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.attestationStmt = db.prepare(`
			INSERT INTO evaluation_attestations
				(attestation_id, artifact_id, contract_id, baseline_artifact_id, task_manifest_sha,
				 grader_sha, workspace_tree_sha, environment_fingerprint, provider_model, sampling_contract,
				 metrics_hash, verdict, real_tokens, cost_micros, trace_ref, failure_classification,
				 signer_key_id, signature, attested_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.revocationStmt = db.prepare(`
			INSERT INTO attestation_revocations (attestation_id, reason, revoker_key_id, signature, revoked_at)
			VALUES (?, ?, ?, ?, ?)
		`);
		this.eventStmt = db.prepare(`
			INSERT INTO deployment_event_stream
				(event_id, seq, slot, event_type, artifact_id, previous_event_id, previous_artifact_id,
				 operator, reason, key_id, signature, occurred_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.resolvedStmt = db.prepare(`
			INSERT INTO runtime_resolved_manifests
				(resolved_id, task_id, slot, artifact_id, deployment_event_id, resolved_blob_shas,
				 resolved_scaffold_hash, actual_provider_model, actual_api_identifier, env_snapshot_hash,
				 drift_flag, resolved_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		this.journalStmt = db.prepare(`
			INSERT INTO evolution_journal (operation, payload_hash, state, created_at)
			VALUES (?, ?, ?, ?)
		`);
	}

	/** Append one frozen artifact manifest; returns `artifact_id`. */
	appendArtifact(input: ArtifactInput): string {
		validateFields(input, ARTIFACT_FIELDS);
		this.artifactStmt.run(
			input.artifactId,
			input.kind,
			JSON.stringify(input.parentIds ?? []),
			input.operator,
			input.scope,
			JSON.stringify(input.evidenceRefs ?? []),
			input.scaffoldHash,
			input.modelFingerprint,
			input.dataClass,
			input.retentionPolicyRef,
			JSON.stringify(input.blobHashes),
			input.canonicalManifest,
			input.createdAt,
		);
		return input.artifactId;
	}

	/** Append one signed evaluation attestation; returns `attestation_id`. */
	appendAttestation(input: AttestationInput): string {
		validateFields(input, ATTESTATION_FIELDS);
		this.attestationStmt.run(
			input.attestationId,
			input.artifactId,
			input.contractId,
			input.baselineArtifactId ?? null,
			input.taskManifestSha,
			input.graderSha,
			input.workspaceTreeSha,
			input.environmentFingerprint,
			input.providerModel,
			input.samplingContract,
			input.metricsHash,
			input.verdict,
			input.realTokens,
			input.costMicros,
			input.traceRef,
			input.failureClassification,
			input.signerKeyId,
			input.signature,
			input.attestedAt,
		);
		return input.attestationId;
	}

	/** Append one revocation event; returns the revoked `attestation_id`. */
	appendRevocation(input: RevocationInput): string {
		validateFields(input, REVOCATION_FIELDS);
		this.revocationStmt.run(input.attestationId, input.reason, input.revokerKeyId, input.signature, input.revokedAt);
		return input.attestationId;
	}

	/** Append one signed deployment event; returns `event_id`. */
	appendEvent(input: DeploymentEventInput): string {
		validateFields(input, EVENT_FIELDS);
		this.eventStmt.run(
			input.eventId,
			input.seq,
			input.slot,
			input.eventType,
			input.artifactId,
			input.previousEventId ?? null,
			input.previousArtifactId ?? null,
			input.operator,
			input.reason,
			input.keyId,
			input.signature,
			input.occurredAt,
		);
		return input.eventId;
	}

	/** Append one runtime resolved manifest; returns `resolved_id`. */
	appendResolved(input: ResolvedManifestInput): string {
		validateFields(input, RESOLVED_FIELDS);
		this.resolvedStmt.run(
			input.resolvedId,
			input.taskId,
			input.slot,
			input.artifactId,
			input.deploymentEventId,
			JSON.stringify(input.resolvedBlobShas),
			input.resolvedScaffoldHash,
			input.actualProviderModel,
			input.actualApiIdentifier,
			input.envSnapshotHash,
			input.driftFlag,
			input.resolvedAt,
		);
		return input.resolvedId;
	}

	/** Append one journal entry; returns the autoincrement `journal_id`. */
	appendJournal(input: JournalInput): number {
		validateFields(input, JOURNAL_FIELDS);
		return Number(
			this.journalStmt.run(input.operation, input.payloadHash, input.state, input.createdAt).lastInsertRowid,
		);
	}
}
