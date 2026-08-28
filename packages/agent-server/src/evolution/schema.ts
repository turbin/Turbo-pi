/**
 * Phase 0a T1: evolution.db frozen schema (architecture doc §6, D1).
 *
 * The evolution control plane lives in its own SQLite database, separate from
 * experience-store.db (D1). All six tables are append-only: UPDATE/DELETE are
 * rejected by `APPEND_ONLY_TRIGGERS_SQL` and the DAO exposes no mutating
 * statements. Time columns are INTEGER epoch ms, array columns are TEXT JSON
 * (same convention as `experience-store.ts`).
 *
 * Freeze rule: every column, enum and constraint below is a contract (A2).
 * Changing it requires a schema version bump and a design decision record.
 */

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Frozen enum sets (§6). The DAO validates against these before SQLite does;
// the CHECK constraints below are the same lists, written out in SQL.
// ---------------------------------------------------------------------------

export const ARTIFACT_KINDS = ["experience_snapshot", "scaffold_config", "source_patch", "composite"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const OPERATORS = ["draft", "improve", "debug", "crossover", "consolidate", "rollback"] as const;
export type Operator = (typeof OPERATORS)[number];

export const DATA_CLASSES = ["diagnostic_ops", "user_content", "aggregate_only"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const VERDICTS = ["pass", "reject", "quarantine", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const EVENT_TYPES = [
	"shadow",
	"canary_pending_approval",
	"canary",
	"active_pending_approval",
	"active",
	"rollback",
	"quarantine",
	"reject",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DRIFT_FLAGS = [
	"none",
	"external_drift_unknown",
	"external_drift_non_reproducible",
	"slot_mismatch",
] as const;
export type DriftFlag = (typeof DRIFT_FLAGS)[number];

export const JOURNAL_STATES = ["written", "committed"] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

// ---------------------------------------------------------------------------
// Table DDL. TEXT primary keys declare explicit NOT NULL: SQLite rowid tables
// otherwise accept NULL in PRIMARY KEY columns, which would violate the
// content-addressed identity contract.
// ---------------------------------------------------------------------------

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifact_immutable_manifests (
	artifact_id TEXT PRIMARY KEY NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('experience_snapshot','scaffold_config','source_patch','composite')),
	parent_ids TEXT NOT NULL DEFAULT '[]',
	operator TEXT NOT NULL CHECK (operator IN ('draft','improve','debug','crossover','consolidate','rollback')),
	scope TEXT NOT NULL,
	evidence_refs TEXT NOT NULL DEFAULT '[]',
	scaffold_hash TEXT NOT NULL,
	model_fingerprint TEXT NOT NULL,
	data_class TEXT NOT NULL CHECK (data_class IN ('diagnostic_ops','user_content','aggregate_only')),
	retention_policy_ref TEXT NOT NULL,
	blob_hashes TEXT NOT NULL,
	canonical_manifest TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_attestations (
	attestation_id TEXT PRIMARY KEY NOT NULL,
	artifact_id TEXT NOT NULL REFERENCES artifact_immutable_manifests(artifact_id),
	contract_id TEXT NOT NULL,
	baseline_artifact_id TEXT REFERENCES evaluation_attestations(attestation_id),
	task_manifest_sha TEXT NOT NULL,
	grader_sha TEXT NOT NULL,
	workspace_tree_sha TEXT NOT NULL,
	environment_fingerprint TEXT NOT NULL,
	provider_model TEXT NOT NULL,
	sampling_contract TEXT NOT NULL,
	metrics_hash TEXT NOT NULL,
	verdict TEXT NOT NULL CHECK (verdict IN ('pass','reject','quarantine','inconclusive')),
	real_tokens INTEGER NOT NULL,
	cost_micros INTEGER NOT NULL,
	trace_ref TEXT NOT NULL,
	failure_classification TEXT NOT NULL,
	signer_key_id TEXT NOT NULL,
	signature TEXT NOT NULL,
	attested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attestation_revocations (
	attestation_id TEXT PRIMARY KEY NOT NULL REFERENCES evaluation_attestations(attestation_id),
	reason TEXT NOT NULL,
	revoker_key_id TEXT NOT NULL,
	signature TEXT NOT NULL,
	revoked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_event_stream (
	event_id TEXT PRIMARY KEY NOT NULL,
	seq INTEGER NOT NULL UNIQUE,
	slot TEXT NOT NULL,
	event_type TEXT NOT NULL CHECK (event_type IN ('shadow','canary_pending_approval','canary','active_pending_approval','active','rollback','quarantine','reject')),
	artifact_id TEXT NOT NULL REFERENCES artifact_immutable_manifests(artifact_id),
	previous_event_id TEXT REFERENCES deployment_event_stream(event_id),
	previous_artifact_id TEXT,
	operator TEXT NOT NULL,
	reason TEXT NOT NULL,
	key_id TEXT NOT NULL,
	signature TEXT NOT NULL,
	occurred_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_resolved_manifests (
	resolved_id TEXT PRIMARY KEY NOT NULL,
	task_id TEXT NOT NULL,
	slot TEXT NOT NULL,
	artifact_id TEXT NOT NULL REFERENCES artifact_immutable_manifests(artifact_id),
	deployment_event_id TEXT NOT NULL REFERENCES deployment_event_stream(event_id),
	resolved_blob_shas TEXT NOT NULL,
	resolved_scaffold_hash TEXT NOT NULL,
	actual_provider_model TEXT NOT NULL,
	actual_api_identifier TEXT NOT NULL,
	env_snapshot_hash TEXT NOT NULL,
	drift_flag TEXT NOT NULL CHECK (drift_flag IN ('none','external_drift_unknown','external_drift_non_reproducible','slot_mismatch')),
	resolved_at INTEGER NOT NULL,
	UNIQUE (task_id, slot, resolved_at)
);

CREATE TABLE IF NOT EXISTS evolution_journal (
	journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
	operation TEXT NOT NULL,
	payload_hash TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('written','committed')),
	created_at INTEGER NOT NULL
);

-- P2-T23: artifact lineage edges (parent/child/operator). Content-addressed
-- edge_id = sha256Hex(canonicalJson([parent_id, child_id, operator, created_at]));
-- see lineage.ts. Append-only like every other table.
CREATE TABLE IF NOT EXISTS lineage_edges (
	edge_id TEXT PRIMARY KEY NOT NULL,
	parent_id TEXT NOT NULL,
	child_id TEXT NOT NULL,
	operator TEXT NOT NULL CHECK (operator IN ('draft','improve','debug','crossover','consolidate','rollback')),
	diff_summary TEXT,
	created_at INTEGER NOT NULL
);

-- Supporting index for the §6.3 derived view (slot current state = max seq
-- per slot). UNIQUE(seq) and UNIQUE(task_id, slot, resolved_at) are table
-- constraints above.
CREATE INDEX IF NOT EXISTS idx_event_slot_seq ON deployment_event_stream(slot, seq);
`;

// ---------------------------------------------------------------------------
// Append-only triggers: one UPDATE guard and one DELETE guard per table.
// The DAO layer is the primary defense (it never issues UPDATE/DELETE/REPLACE);
// these triggers are the second, DB-level defense (A2).
// ---------------------------------------------------------------------------

const APPEND_ONLY_TABLES = [
	"artifact_immutable_manifests",
	"evaluation_attestations",
	"attestation_revocations",
	"deployment_event_stream",
	"runtime_resolved_manifests",
	"evolution_journal",
	"lineage_edges",
];

export const APPEND_ONLY_TRIGGERS_SQL = APPEND_ONLY_TABLES.map(
	(t) => `
CREATE TRIGGER IF NOT EXISTS trg_${t}_no_update BEFORE UPDATE ON ${t}
BEGIN
	SELECT RAISE(ABORT, 'append-only: UPDATE forbidden on ${t}');
END;

CREATE TRIGGER IF NOT EXISTS trg_${t}_no_delete BEFORE DELETE ON ${t}
BEGIN
	SELECT RAISE(ABORT, 'append-only: DELETE forbidden on ${t}');
END;
`,
).join("\n");
