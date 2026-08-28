import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ArtifactInput,
	AttestationInput,
	DeploymentEventInput,
	JournalInput,
	ResolvedManifestInput,
	RevocationInput,
} from "../../src/evolution/append-only-dao.ts";
import { AppendOnlyDao, AppendRejectedError } from "../../src/evolution/append-only-dao.ts";
import { EvolutionDb } from "../../src/evolution/db.ts";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../../src/evolution/schema.ts";

/**
 * Phase 0a T1 (architecture doc §6): evolution.db frozen schema contract.
 *
 * Every table shape below is the authoritative freeze: column names, types,
 * NOT NULL, PK, defaults, CHECK enums, FK and UNIQUE constraints are asserted
 * mechanically against `PRAGMA table_info` and behavioral inserts. Changing a
 * column here without a schema version bump is a contract break.
 */

interface ColumnContract {
	name: string;
	type: string;
	notNull: boolean;
	pk: boolean;
	default: string | null;
}

const TABLES: Record<string, { columns: ColumnContract[] }> = {
	artifact_immutable_manifests: {
		columns: [
			{ name: "artifact_id", type: "TEXT", notNull: true, pk: true, default: null },
			{ name: "kind", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "parent_ids", type: "TEXT", notNull: true, pk: false, default: "'[]'" },
			{ name: "operator", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "scope", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "evidence_refs", type: "TEXT", notNull: true, pk: false, default: "'[]'" },
			{ name: "scaffold_hash", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "model_fingerprint", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "data_class", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "retention_policy_ref", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "blob_hashes", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "canonical_manifest", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "created_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
	evaluation_attestations: {
		columns: [
			{ name: "attestation_id", type: "TEXT", notNull: true, pk: true, default: null },
			{ name: "artifact_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "contract_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "baseline_artifact_id", type: "TEXT", notNull: false, pk: false, default: null },
			{ name: "task_manifest_sha", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "grader_sha", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "workspace_tree_sha", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "environment_fingerprint", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "provider_model", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "sampling_contract", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "metrics_hash", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "verdict", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "real_tokens", type: "INTEGER", notNull: true, pk: false, default: null },
			{ name: "cost_micros", type: "INTEGER", notNull: true, pk: false, default: null },
			{ name: "trace_ref", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "failure_classification", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "signer_key_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "signature", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "attested_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
	attestation_revocations: {
		columns: [
			{ name: "attestation_id", type: "TEXT", notNull: true, pk: true, default: null },
			{ name: "reason", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "revoker_key_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "signature", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "revoked_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
	deployment_event_stream: {
		columns: [
			{ name: "event_id", type: "TEXT", notNull: true, pk: true, default: null },
			{ name: "seq", type: "INTEGER", notNull: true, pk: false, default: null },
			{ name: "slot", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "event_type", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "artifact_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "previous_event_id", type: "TEXT", notNull: false, pk: false, default: null },
			{ name: "previous_artifact_id", type: "TEXT", notNull: false, pk: false, default: null },
			{ name: "operator", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "reason", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "key_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "signature", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "occurred_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
	runtime_resolved_manifests: {
		columns: [
			{ name: "resolved_id", type: "TEXT", notNull: true, pk: true, default: null },
			{ name: "task_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "slot", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "artifact_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "deployment_event_id", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "resolved_blob_shas", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "resolved_scaffold_hash", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "actual_provider_model", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "actual_api_identifier", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "env_snapshot_hash", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "drift_flag", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "resolved_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
	evolution_journal: {
		columns: [
			{ name: "journal_id", type: "INTEGER", notNull: false, pk: true, default: null },
			{ name: "operation", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "payload_hash", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "state", type: "TEXT", notNull: true, pk: false, default: null },
			{ name: "created_at", type: "INTEGER", notNull: true, pk: false, default: null },
		],
	},
};

const TABLE_NAMES = Object.keys(TABLES);

/** snake_case row fixtures matching the frozen columns (values are valid for all constraints). */
const FIXTURES: Record<string, Record<string, unknown>> = {
	artifact_immutable_manifests: {
		artifact_id: "artifact-1",
		kind: "composite",
		parent_ids: "[]",
		operator: "draft",
		scope: "[]",
		evidence_refs: "[]",
		scaffold_hash: "sha-scaffold",
		model_fingerprint: "{}",
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: "[]",
		canonical_manifest: "{}",
		created_at: 1_785_000_000_000,
	},
	evaluation_attestations: {
		attestation_id: "att-1",
		artifact_id: "artifact-1",
		contract_id: "contract-1",
		baseline_artifact_id: null,
		task_manifest_sha: "sha-task",
		grader_sha: "sha-grader",
		workspace_tree_sha: "sha-tree",
		environment_fingerprint: "sha-env",
		provider_model: "provider/model-1",
		sampling_contract: "{}",
		metrics_hash: "sha-metrics",
		verdict: "pass",
		real_tokens: 1000,
		cost_micros: 5000,
		trace_ref: "trace-1",
		failure_classification: "none",
		signer_key_id: "dev-key-1",
		signature: "sig-att",
		attested_at: 1_785_000_000_001,
	},
	attestation_revocations: {
		attestation_id: "att-1",
		reason: "superseded",
		revoker_key_id: "dev-key-2",
		signature: "sig-revoke",
		revoked_at: 1_785_000_000_002,
	},
	deployment_event_stream: {
		event_id: "event-1",
		seq: 1,
		slot: "experience.active",
		event_type: "active",
		artifact_id: "artifact-1",
		previous_event_id: null,
		previous_artifact_id: null,
		operator: "bootstrap",
		reason: "gen0 bootstrap",
		key_id: "dev-audit-1",
		signature: "sig-event",
		occurred_at: 1_785_000_000_003,
	},
	runtime_resolved_manifests: {
		resolved_id: "resolved-1",
		task_id: "task-1",
		slot: "experience.active",
		artifact_id: "artifact-1",
		deployment_event_id: "event-1",
		resolved_blob_shas: "[]",
		resolved_scaffold_hash: "sha-scaffold",
		actual_provider_model: "provider/model-1",
		actual_api_identifier: "endpoint-fp",
		env_snapshot_hash: "sha-env",
		drift_flag: "none",
		resolved_at: 1_785_000_000_004,
	},
	evolution_journal: {
		operation: "store_artifact",
		payload_hash: "sha-payload",
		state: "committed",
		created_at: 1_785_000_000_005,
	},
};

/** PK column per table; evolution_journal.journal_id is autoincrement (not in fixture). */
const PK_COL: Record<string, string | undefined> = {
	artifact_immutable_manifests: "artifact_id",
	evaluation_attestations: "attestation_id",
	attestation_revocations: "attestation_id",
	deployment_event_stream: "event_id",
	runtime_resolved_manifests: "resolved_id",
	evolution_journal: "journal_id",
};

/** A non-PK column to mutate in the UPDATE-rejection test, per table. */
const UPDATE_COL: Record<string, string> = {
	artifact_immutable_manifests: "scope",
	evaluation_attestations: "verdict",
	attestation_revocations: "reason",
	deployment_event_stream: "slot",
	runtime_resolved_manifests: "drift_flag",
	evolution_journal: "state",
};

/** FK-reference fixture defaults that must be suffixed in lockstep with the row's PK. */
const REF_DEFAULTS = new Set(["artifact-1", "att-1", "event-1"]);

function insertRow(
	db: Database.Database,
	table: string,
	overrides: Record<string, unknown> = {},
	suffix = "",
	omit?: string,
): void {
	const row: Record<string, unknown> = { ...FIXTURES[table], ...overrides };
	if (omit) delete row[omit];
	if (suffix && table !== "evolution_journal") {
		const pk = PK_COL[table];
		if (pk && !(pk in overrides)) row[pk] = `${String(row[pk])}-${suffix}`;
		// seq is a GLOBAL unique counter: derive a deterministic unique value per
		// suffix unless the caller pinned it explicitly.
		if ("seq" in row && !("seq" in overrides)) row.seq = seqForSuffix(suffix);
		// Keep fixture-default FK references pointing at the suffixed parent rows.
		for (const f of Object.keys(row)) {
			if (f === pk || f in overrides) continue;
			const v = row[f];
			if (typeof v === "string" && REF_DEFAULTS.has(v)) row[f] = `${v}-${suffix}`;
		}
	}
	const cols = Object.keys(row);
	db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
		...cols.map((c) => row[c]),
	);
}

/** Deterministic per-suffix seq (global UNIQUE): FNV-1a over the suffix text. */
function seqForSuffix(suffix: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < suffix.length; i++) {
		h ^= suffix.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) + 1;
}

/**
 * Seed the FK parents a row depends on (artifact -> attestation -> revocation;
 * artifact -> event -> resolved). Suffix keeps every seeded id unique.
 */
function seedParents(db: Database.Database, table: string, suffix: string): void {
	if (table !== "artifact_immutable_manifests") insertRow(db, "artifact_immutable_manifests", {}, suffix);
	if (table === "attestation_revocations") insertRow(db, "evaluation_attestations", {}, suffix);
	if (table === "runtime_resolved_manifests") insertRow(db, "deployment_event_stream", {}, suffix);
}

/** Enum CHECK columns: one invalid value plus the valid value used by fixtures. */
const ENUM_CASES: { table: string; column: string; invalid: string; valid: string }[] = [
	{ table: "artifact_immutable_manifests", column: "kind", invalid: "binary_patch", valid: "composite" },
	{ table: "artifact_immutable_manifests", column: "operator", invalid: "auto", valid: "draft" },
	{ table: "artifact_immutable_manifests", column: "data_class", invalid: "raw_tokens", valid: "diagnostic_ops" },
	{ table: "evaluation_attestations", column: "verdict", invalid: "revoked", valid: "pass" },
	{ table: "deployment_event_stream", column: "event_type", invalid: "activate", valid: "active" },
	{ table: "runtime_resolved_manifests", column: "drift_flag", invalid: "unknown", valid: "none" },
	{ table: "evolution_journal", column: "state", invalid: "pending", valid: "written" },
];

describe("evolution schema (T1)", () => {
	let evo: EvolutionDb;
	let dao: AppendOnlyDao;

	beforeEach(() => {
		evo = new EvolutionDb(":memory:");
		evo.migrate();
		dao = new AppendOnlyDao(evo.db);
	});

	afterEach(() => {
		evo.close();
	});

	describe("schema installation", () => {
		it("creates the six frozen tables", () => {
			const rows = evo.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
			const names = rows.map((r) => r.name);
			for (const t of TABLE_NAMES) expect(names, `table ${t}`).toContain(t);
		});

		it("columns/types/constraints match architecture §6 exactly (PRAGMA table_info)", () => {
			for (const [table, contract] of Object.entries(TABLES)) {
				const info = evo.db.prepare(`PRAGMA table_info(${table})`).all() as {
					name: string;
					type: string;
					notnull: number;
					pk: number;
					dflt_value: string | null;
				}[];
				const actual = info.map((c) => ({
					name: c.name,
					type: c.type,
					notNull: c.notnull === 1,
					pk: c.pk === 1,
					default: c.dflt_value,
				}));
				expect(actual, `table ${table}`).toEqual(contract.columns);
			}
		});

		it("installs an UPDATE and a DELETE reject trigger on every table", () => {
			const rows = evo.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").all() as {
				name: string;
				tbl_name: string;
			}[];
			const byTable = new Map<string, string[]>();
			for (const r of rows) byTable.set(r.tbl_name, [...(byTable.get(r.tbl_name) ?? []), r.name]);
			for (const t of TABLE_NAMES) {
				const names = byTable.get(t) ?? [];
				expect(names, `triggers for ${t}`).toEqual(
					expect.arrayContaining([`trg_${t}_no_update`, `trg_${t}_no_delete`]),
				);
				expect(names.length, `trigger count for ${t}`).toBe(2);
			}
		});

		it("stamps user_version and migrates idempotently", () => {
			expect(evo.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
			evo.migrate();
			expect(evo.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
		});

		it("enables foreign key enforcement on every connection", () => {
			expect(evo.db.pragma("foreign_keys", { simple: true })).toBe(1);
		});
	});

	describe("append-only triggers (A2)", () => {
		it("rejects UPDATE and DELETE of any row in any table and leaves rows intact", () => {
			for (const table of TABLE_NAMES) {
				seedParents(evo.db, table, table);
				insertRow(evo.db, table, {}, table);
				const pkCol = PK_COL[table]!;
				const row = evo.db.prepare(`SELECT ${pkCol} AS pk FROM ${table}`).get() as { pk: string | number };
				expect(
					() =>
						evo.db
							.prepare(`UPDATE ${table} SET ${UPDATE_COL[table]} = ? WHERE ${pkCol} = ?`)
							.run("mutated", row.pk),
					`UPDATE ${table}`,
				).toThrow(/append-only/);
				expect(
					() => evo.db.prepare(`DELETE FROM ${table} WHERE ${pkCol} = ?`).run(row.pk),
					`DELETE ${table}`,
				).toThrow(/append-only/);
				const count = evo.db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
				expect(count.c, `row survived ${table}`).toBe(1);
			}
		});
	});

	describe("NOT NULL: missing required fields are rejected with an explicit reason (A2)", () => {
		it("rejects raw inserts omitting any NOT NULL column, naming table.column", () => {
			for (const [table, contract] of Object.entries(TABLES)) {
				// Columns with DEFAULT values do not trigger NOT NULL rejection when omitted.
				for (const col of contract.columns.filter((c) => c.notNull && !c.pk && c.default === null)) {
					const suffix = `nn-${table}-${col.name}`;
					seedParents(evo.db, table, suffix);
					expect(() => insertRow(evo.db, table, {}, suffix, col.name), `${table}.${col.name}`).toThrow(
						`NOT NULL constraint failed: ${table}.${col.name}`,
					);
				}
			}
		});

		it("DAO rejects every missing required field naming the field", () => {
			const cases: { method: keyof AppendOnlyDao; base: Record<string, unknown>; optional: Set<string> }[] = [
				{ method: "appendArtifact", base: daoArtifactInput(), optional: new Set(["parentIds", "evidenceRefs"]) },
				{ method: "appendAttestation", base: daoAttestationInput(), optional: new Set(["baselineArtifactId"]) },
				{ method: "appendRevocation", base: daoRevocationInput(), optional: new Set() },
				{
					method: "appendEvent",
					base: daoEventInput(),
					optional: new Set(["previousEventId", "previousArtifactId"]),
				},
				{ method: "appendResolved", base: daoResolvedInput(), optional: new Set() },
				{ method: "appendJournal", base: daoJournalInput(), optional: new Set() },
			];
			for (const { method, base, optional } of cases) {
				const fn = dao[method] as unknown as (input: Record<string, unknown>) => unknown;
				for (const field of Object.keys(base)) {
					if (optional.has(field)) continue;
					const input = { ...base };
					delete input[field];
					expect(() => fn(input), `${method} missing ${field}`).toThrow(`missing required field: ${field}`);
				}
			}
		});
	});

	describe("CHECK enum constraints", () => {
		it("accepts only the frozen enum values (§6)", () => {
			for (const { table, column, invalid, valid } of ENUM_CASES) {
				const suffixInvalid = `enum-${table}-${column}-invalid`;
				const suffixValid = `enum-${table}-${column}-valid`;
				seedParents(evo.db, table, suffixInvalid);
				expect(
					() => insertRow(evo.db, table, { [column]: invalid }, suffixInvalid),
					`${table}.${column}=${invalid}`,
				).toThrow(/CHECK constraint failed/);
				seedParents(evo.db, table, suffixValid);
				insertRow(evo.db, table, { [column]: valid }, suffixValid);
			}
		});

		it("journal state is exactly written|committed (A11)", () => {
			insertRow(evo.db, "evolution_journal", { state: "written" }, "a11");
			insertRow(evo.db, "evolution_journal", { state: "committed" }, "a11b");
			expect(() => insertRow(evo.db, "evolution_journal", { state: "committed" }, "a11c")).not.toThrow();
			expect(() => insertRow(evo.db, "evolution_journal", { state: "active" }, "a11d")).toThrow(
				/CHECK constraint failed/,
			);
		});
	});

	describe("foreign keys (§6)", () => {
		it("rejects dangling references on every FK column", () => {
			expect(() => insertRow(evo.db, "evaluation_attestations", { artifact_id: "ghost-artifact" }, "fk1")).toThrow(
				/FOREIGN KEY constraint failed/,
			);
			insertRow(evo.db, "artifact_immutable_manifests", {}, "fk1");
			insertRow(evo.db, "artifact_immutable_manifests", {}, "fk2");
			expect(() =>
				insertRow(evo.db, "evaluation_attestations", { baseline_artifact_id: "ghost-att" }, "fk2"),
			).toThrow(/FOREIGN KEY constraint failed/);
			expect(() => insertRow(evo.db, "attestation_revocations", { attestation_id: "ghost-att" }, "fk3")).toThrow(
				/FOREIGN KEY constraint failed/,
			);
			expect(() => insertRow(evo.db, "deployment_event_stream", { artifact_id: "ghost-artifact" }, "fk4")).toThrow(
				/FOREIGN KEY constraint failed/,
			);
			insertRow(evo.db, "artifact_immutable_manifests", {}, "fk5");
			insertRow(evo.db, "deployment_event_stream", {}, "fk5");
			insertRow(evo.db, "artifact_immutable_manifests", {}, "fk6");
			expect(() =>
				insertRow(evo.db, "deployment_event_stream", { previous_event_id: "ghost-event" }, "fk6"),
			).toThrow(/FOREIGN KEY constraint failed/);
			expect(() =>
				insertRow(evo.db, "runtime_resolved_manifests", { artifact_id: "ghost-artifact" }, "fk7"),
			).toThrow(/FOREIGN KEY constraint failed/);
			insertRow(evo.db, "artifact_immutable_manifests", {}, "fk8");
			expect(() =>
				insertRow(evo.db, "runtime_resolved_manifests", { deployment_event_id: "ghost-event" }, "fk8"),
			).toThrow(/FOREIGN KEY constraint failed/);
		});

		it("accepts a valid parent-child chain and self-referencing previous_event_id", () => {
			insertRow(evo.db, "artifact_immutable_manifests", {}, "chain");
			insertRow(evo.db, "evaluation_attestations", {}, "chain");
			insertRow(evo.db, "artifact_immutable_manifests", {}, "chain2");
			insertRow(
				evo.db,
				"evaluation_attestations",
				{ attestation_id: "att-1-chain2", baseline_artifact_id: "att-1-chain" },
				"chain2",
			);
			insertRow(evo.db, "attestation_revocations", {}, "chain");
			insertRow(evo.db, "deployment_event_stream", {}, "chain");
			insertRow(
				evo.db,
				"deployment_event_stream",
				{ event_id: "event-1-chain2", seq: 2, previous_event_id: "event-1-chain" },
				"chain2",
			);
			insertRow(evo.db, "runtime_resolved_manifests", {}, "chain");
		});
	});

	describe("UNIQUE and defaults", () => {
		it("rejects duplicate primary keys and duplicate seq", () => {
			insertRow(evo.db, "artifact_immutable_manifests", {}, "uniq");
			expect(() => insertRow(evo.db, "artifact_immutable_manifests", {}, "uniq")).toThrow(
				/UNIQUE constraint failed/,
			);
			insertRow(evo.db, "artifact_immutable_manifests", {}, "uniq2");
			insertRow(evo.db, "artifact_immutable_manifests", {}, "uniq3");
			// Pin seq explicitly: fixture seq is auto-derived per suffix, so to test
			// UNIQUE(seq) we must override seq to the same value across rows.
			insertRow(evo.db, "deployment_event_stream", { event_id: "event-first", seq: 999 }, "uniq2");
			expect(() =>
				insertRow(evo.db, "deployment_event_stream", { event_id: "event-dup", seq: 999 }, "uniq3"),
			).toThrow(/UNIQUE constraint failed/);
			insertRow(evo.db, "deployment_event_stream", { event_id: "event-ok", seq: 1000 }, "uniq3");
		});

		it("enforces UNIQUE(task_id, slot, resolved_at) idempotency key", () => {
			for (const suffix of ["uniq", "uniq2", "uniq3"]) seedParents(evo.db, "runtime_resolved_manifests", suffix);
			insertRow(evo.db, "runtime_resolved_manifests", {}, "uniq");
			expect(() => insertRow(evo.db, "runtime_resolved_manifests", { resolved_id: "resolved-2" }, "uniq2")).toThrow(
				/UNIQUE constraint failed/,
			);
			insertRow(
				evo.db,
				"runtime_resolved_manifests",
				{ resolved_id: "resolved-3", resolved_at: 1_785_000_000_099 },
				"uniq3",
			);
		});

		it("defaults parent_ids/evidence_refs to '[]'", () => {
			const row = FIXTURES.artifact_immutable_manifests;
			const cols = Object.keys(row).filter((c) => c !== "parent_ids" && c !== "evidence_refs");
			evo.db
				.prepare(
					`INSERT INTO artifact_immutable_manifests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
				)
				.run(...cols.map((c) => row[c]));
			const got = evo.db.prepare("SELECT parent_ids, evidence_refs FROM artifact_immutable_manifests").get() as {
				parent_ids: string;
				evidence_refs: string;
			};
			expect(got).toEqual({ parent_ids: "[]", evidence_refs: "[]" });
		});

		it("DAO omitting optional array fields stores '[]'", () => {
			const { parentIds: _p, evidenceRefs: _e, ...rest } = daoArtifactInput();
			dao.appendArtifact(rest as unknown as ArtifactInput);
			const got = evo.db.prepare("SELECT parent_ids, evidence_refs FROM artifact_immutable_manifests").get() as {
				parent_ids: string;
				evidence_refs: string;
			};
			expect(got).toEqual({ parent_ids: "[]", evidence_refs: "[]" });
		});
	});

	describe("DAO field validation (fail closed with explicit reason)", () => {
		it("rejects invalid enum values", () => {
			expect(() => dao.appendArtifact({ ...daoArtifactInput(), kind: "binary_patch" } as never)).toThrow(
				/invalid kind/,
			);
			expect(() => dao.appendJournal({ ...daoJournalInput(), state: "pending" } as never)).toThrow(/invalid state/);
		});

		it("rejects malformed JSON text fields", () => {
			expect(() => dao.appendArtifact({ ...daoArtifactInput(), scope: "not-json" } as never)).toThrow(
				/invalid scope/,
			);
			expect(() =>
				dao.appendAttestation({ ...daoAttestationInput(), samplingContract: "{broken" } as never),
			).toThrow(/invalid samplingContract/);
		});

		it("rejects non-array JSON array fields and non-integer time fields", () => {
			expect(() => dao.appendArtifact({ ...daoArtifactInput(), blobHashes: {} } as never)).toThrow(
				/invalid blobHashes/,
			);
			expect(() => dao.appendEvent({ ...daoEventInput(), seq: 1.5 } as never)).toThrow(/invalid seq/);
			expect(() => dao.appendResolved({ ...daoResolvedInput(), resolvedAt: Number.NaN } as never)).toThrow(
				/invalid resolvedAt/,
			);
		});

		it("throws AppendRejectedError with every reason collected", () => {
			try {
				dao.appendArtifact({ ...daoArtifactInput(), scope: "not-json", kind: "bogus", createdAt: 1.5 } as never);
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(AppendRejectedError);
				const msg = (e as Error).message;
				expect(msg).toContain("scope");
				expect(msg).toContain("kind");
				expect(msg).toContain("createdAt");
			}
		});
	});

	describe("DAO append-only surface (defense in depth, trigger-independent)", () => {
		it("exposes only append* methods on the prototype", () => {
			const names = Object.getOwnPropertyNames(AppendOnlyDao.prototype).filter((n) => n !== "constructor");
			for (const name of names) expect(name, `method ${name}`).toMatch(/^append/);
		});

		it("never issues UPDATE/DELETE/REPLACE statements even without triggers installed", () => {
			const raw = new Database(":memory:");
			raw.exec(SCHEMA_SQL); // deliberately skip APPEND_ONLY_TRIGGERS_SQL
			const sqls: string[] = [];
			const prepare = raw.prepare.bind(raw);
			raw.prepare = ((sql: string) => {
				sqls.push(sql);
				return prepare(sql);
			}) as typeof raw.prepare;
			const plainDao = new AppendOnlyDao(raw);
			plainDao.appendArtifact(daoArtifactInput() as unknown as ArtifactInput);
			plainDao.appendAttestation(daoAttestationInput() as unknown as AttestationInput);
			plainDao.appendRevocation(daoRevocationInput() as unknown as RevocationInput);
			plainDao.appendEvent(daoEventInput() as unknown as DeploymentEventInput);
			plainDao.appendResolved(daoResolvedInput() as unknown as ResolvedManifestInput);
			plainDao.appendJournal(daoJournalInput() as unknown as JournalInput);
			raw.close();
			expect(sqls.length).toBeGreaterThanOrEqual(6);
			for (const sql of sqls) {
				expect(sql, `non-append SQL: ${sql}`).toMatch(/^\s*INSERT\s+INTO\b/i);
			}
		});
	});

	describe("journal recovery premise (A11)", () => {
		it("appendJournal accepts written state so half-written records stay observable", () => {
			const id1 = dao.appendJournal({ ...daoJournalInput(), state: "written" } as unknown as JournalInput);
			const id2 = dao.appendJournal({ ...daoJournalInput(), state: "committed" } as unknown as JournalInput);
			const rows = evo.db.prepare("SELECT journal_id, state FROM evolution_journal ORDER BY journal_id").all() as {
				journal_id: number;
				state: string;
			}[];
			expect(rows).toEqual([
				{ journal_id: id1, state: "written" },
				{ journal_id: id2, state: "committed" },
			]);
			expect(id1).toBe(1);
			expect(id2).toBe(2);
		});
	});
});

/**
 * DAO input fixtures (camelCase, mirror the frozen columns), deliberately typed
 * `Record<string, unknown>` so tests push raw records through the runtime
 * validator. Reject-cases cast the offending input `as never` (the append must
 * never succeed); accept-cases cast `as unknown as <Input>` because a Record is
 * not statically assignable to the typed input contract.
 */

function daoArtifactInput(): Record<string, unknown> {
	return {
		artifactId: "artifact-dao-1",
		kind: "composite",
		parentIds: [],
		operator: "draft",
		scope: "[]",
		evidenceRefs: [],
		scaffoldHash: "sha-scaffold",
		modelFingerprint: "{}",
		dataClass: "diagnostic_ops",
		retentionPolicyRef: "pending_0b",
		blobHashes: [],
		canonicalManifest: "{}",
		createdAt: 1_785_000_000_000,
	};
}

function daoAttestationInput(): Record<string, unknown> {
	return {
		attestationId: "att-dao-1",
		artifactId: "artifact-dao-1",
		contractId: "contract-1",
		baselineArtifactId: undefined,
		taskManifestSha: "sha-task",
		graderSha: "sha-grader",
		workspaceTreeSha: "sha-tree",
		environmentFingerprint: "sha-env",
		providerModel: "provider/model-1",
		samplingContract: "{}",
		metricsHash: "sha-metrics",
		verdict: "pass",
		realTokens: 1000,
		costMicros: 5000,
		traceRef: "trace-1",
		failureClassification: "none",
		signerKeyId: "dev-key-1",
		signature: "sig-att",
		attestedAt: 1_785_000_000_001,
	};
}

function daoRevocationInput(): Record<string, unknown> {
	return {
		attestationId: "att-dao-1",
		reason: "superseded",
		revokerKeyId: "dev-key-2",
		signature: "sig-revoke",
		revokedAt: 1_785_000_000_002,
	};
}

function daoEventInput(): Record<string, unknown> {
	return {
		eventId: "event-dao-1",
		seq: 1,
		slot: "experience.active",
		eventType: "active",
		artifactId: "artifact-dao-1",
		previousEventId: undefined,
		previousArtifactId: undefined,
		operator: "bootstrap",
		reason: "gen0 bootstrap",
		keyId: "dev-audit-1",
		signature: "sig-event",
		occurredAt: 1_785_000_000_003,
	};
}

function daoResolvedInput(): Record<string, unknown> {
	return {
		resolvedId: "resolved-dao-1",
		taskId: "task-1",
		slot: "experience.active",
		artifactId: "artifact-dao-1",
		deploymentEventId: "event-dao-1",
		resolvedBlobShas: [],
		resolvedScaffoldHash: "sha-scaffold",
		actualProviderModel: "provider/model-1",
		actualApiIdentifier: "endpoint-fp",
		envSnapshotHash: "sha-env",
		driftFlag: "none",
		resolvedAt: 1_785_000_000_004,
	};
}

function daoJournalInput(): Record<string, unknown> {
	return {
		operation: "store_artifact",
		payloadHash: "sha-payload",
		state: "committed",
		createdAt: 1_785_000_000_005,
	};
}
