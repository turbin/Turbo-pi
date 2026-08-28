/**
 * P0b-T10: Phase 0b parameter registration schema and default registry.
 *
 * Pre-registers the operational/data parameters P1–P10 listed in §9 of
 * doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md.
 *
 * Every parameter carries an owner, rationale, version, expiry, and a
 * fail-closed default. No numeric values are decided here: `value` stays
 * "not_yet_registered" until the responsible owner confirms the parameter.
 * Registration rule: P1–P9 are Phase 0b blockers; P10 is a cross-phase ledger.
 */

export type ParameterId = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "P10";

export const PARAMETER_STATUSES = ["registered", "pending", "expired"] as const;
export type ParameterStatus = (typeof PARAMETER_STATUSES)[number];

export interface EvolutionParameter {
	id: ParameterId;
	name: string;
	owner: string;
	/** Confirmed value, or "not_yet_registered" while undecided. */
	value: string;
	rationale: string;
	version: string;
	/** ISO 8601 timestamp after which the registration must be re-confirmed. */
	expiresAt: string;
	/** Behavior enforced while the parameter is undecided: the capability is unavailable. */
	failClosedDefault: string;
	status: ParameterStatus;
}

const PHASE0B_VERSION = "0b-draft.1";
const PHASE0B_EXPIRY = "2026-12-31T00:00:00.000Z";

interface ParameterDraft {
	id: ParameterId;
	name: string;
	owner: string;
	rationale: string;
	failClosedDefault: string;
}

function draft(d: ParameterDraft): EvolutionParameter {
	return {
		id: d.id,
		name: d.name,
		owner: d.owner,
		value: "not_yet_registered",
		rationale: d.rationale,
		version: PHASE0B_VERSION,
		expiresAt: PHASE0B_EXPIRY,
		failClosedDefault: d.failClosedDefault,
		status: "pending",
	};
}

export const DEFAULT_PARAMETERS: readonly EvolutionParameter[] = [
	draft({
		id: "P1",
		name: "signing-key-operations",
		owner: "security-owner",
		rationale:
			"Rotation period, revocation propagation, and old-key verification window for the evaluation signer and audit writer (V3 §11 Phase 0b, §18.7).",
		failClosedDefault: "No key rotation (single key stays valid); revocation only via explicit revocation events.",
	}),
	draft({
		id: "P2",
		name: "production-worm-anchor",
		owner: "ops-owner",
		rationale:
			"Operating entity, anchoring frequency, and anchor storage selection for the production WORM chain (adversarial review round 3, V3 §11 Phase 0b).",
		failClosedDefault: "chain_mode stays local_diagnostic; no production anchoring is claimed.",
	}),
	draft({
		id: "P3",
		name: "data-classes",
		owner: "data-owner",
		rationale:
			"Full data-class enum with TTL/legal-hold basis/erasure/tombstone/aggregation granularity/cold storage, plus generation-0 class assignment (adversarial review round 4, V3 §7.7).",
		failClosedDefault:
			"gen0 retention_policy_ref points at the pending_0b placeholder policy (local retention only); no deletion, no external export.",
	}),
	draft({
		id: "P4",
		name: "shadow-budget",
		owner: "ops-owner",
		rationale:
			"Per-artifact-class token/cost/wall-time/worker caps, exhaustion action (pause/reject), and the escalation path for budget expansion (V3 §11 Phase 0b, §13).",
		failClosedDefault:
			"No pre-configured budget means no shadow runs; any exhaustion must terminate evaluation rather than hang (issue-023 lesson).",
	}),
	draft({
		id: "P5",
		name: "build-run-exceptions",
		owner: "security-owner",
		rationale:
			"Approver and validity window for the signed dependency exception manifest; internal mirror list; runtime endpoint list; short-term capability allowlist (V3 §11 Phase 0b, §13, adversarial review round 5).",
		failClosedDefault:
			"Hermetic by default; without a signed exception, new dependencies/endpoints/capabilities are forbidden.",
	}),
	draft({
		id: "P6",
		name: "candidate-abi-expansion",
		owner: "agent-owner",
		rationale:
			"Ordering of capability expansion, per-class approvers, and evidence required at each Go Gate for widening the candidate ABI (V3 §11 Phase 0b, adversarial review round 4).",
		failClosedDefault: "Phase 0a exposes no M3 channel; no expansion means no opening.",
	}),
	draft({
		id: "P7",
		name: "gen0-fingerprint-scope",
		owner: "agent-owner",
		rationale:
			"Confirmation of the fingerprint collection manifest: config file set, experience.db snapshot scope, and whether extensions/skills enter scaffold_hash (V3 §11 P0a-6).",
		failClosedDefault:
			"Collection scope equals the bootstrap script default manifest; unlisted paths never enter the gen0 fingerprint and coverage is reported as-is.",
	}),
	draft({
		id: "P8",
		name: "issue-023-numerics",
		owner: "ops-owner",
		rationale:
			"Account-class error (402/401/403) fast-fail detection, backoff caps, preflight balance threshold, and stall-alert threshold (doc/issues-snapshot/issue-023-* pending-fix list).",
		failClosedDefault:
			"Unknown balance means preflight refuses to start; a single account-class error terminates and alerts, no retry.",
	}),
	draft({
		id: "P9",
		name: "confirmation-set-granularity",
		owner: "data-owner",
		rationale:
			"Expression granularity in TEK contracts for the post-D sealed list of 20 never-executed tasks plus their SHA256 (denylist effective scope) (post-D plan §154–155, V3 §11 P0a-5).",
		failClosedDefault:
			"Confirmation set is referenced via PinTaskContractRequest.taskManifestSha; until the denylist is frozen, no confirmation-set protection may be claimed.",
	}),
	draft({
		id: "P10",
		name: "statistics-ledger",
		owner: "research-owner",
		rationale:
			"Minimum practical gain / non-inferiority margin / disaster-rate upper bound, power, and sample size, pre-registered for Phase 3 (V3 §9.2, §18.5).",
		failClosedDefault:
			"This phase only builds the ledger; no attestation metrics may be interpreted as statistical conclusions.",
	}),
];

/**
 * Return the parameter registry. When no registry is supplied, the built-in
 * P1–P10 defaults are returned as a defensive copy.
 */
export function loadParameters(registry?: EvolutionParameter[]): EvolutionParameter[] {
	const source = registry ?? DEFAULT_PARAMETERS;
	return source.map((p) => ({ ...p }));
}

/** Validate a single parameter; any missing required field fails closed. */
export function validateParameter(param: EvolutionParameter): { ok: true } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (!param.id || !/^P([1-9]|10)$/.test(param.id)) {
		errors.push("id must be one of P1..P10");
	}
	if (!param.name || param.name.trim().length === 0) {
		errors.push("name must be non-empty");
	}
	if (!param.owner || param.owner.trim().length === 0) {
		errors.push("owner must be non-empty");
	}
	if (!param.value || param.value.trim().length === 0) {
		errors.push("value must be non-empty");
	}
	if (!param.rationale || param.rationale.trim().length === 0) {
		errors.push("rationale must be non-empty");
	}
	if (!param.version || param.version.trim().length === 0) {
		errors.push("version must be non-empty");
	}
	if (!param.expiresAt || Number.isNaN(Date.parse(param.expiresAt))) {
		errors.push("expiresAt must be a parseable ISO 8601 timestamp");
	}
	if (!param.failClosedDefault || param.failClosedDefault.trim().length === 0) {
		errors.push("failClosedDefault must be non-empty");
	}
	if (!PARAMETER_STATUSES.includes(param.status)) {
		errors.push(`status must be one of ${PARAMETER_STATUSES.join(", ")}`);
	}
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true };
}

/** P0b-T11: every P1–P10 parameter must be present in a Phase 0b registry. */
export const REQUIRED_PARAMETER_IDS: readonly ParameterId[] = [
	"P1",
	"P2",
	"P3",
	"P4",
	"P5",
	"P6",
	"P7",
	"P8",
	"P9",
	"P10",
];

export interface RegistryValidationOptions {
	/** Reference time for expiry checks; defaults to the current time. */
	now?: Date;
	/** When true, expired registrations do not fail validation (re-confirmation in progress). */
	allowExpired?: boolean;
}

/**
 * Validate a whole Phase 0b parameter registry. Fails closed: all P1–P10 must
 * be present, each parameter must pass `validateParameter`, ids must be
 * unique, and no registration may be expired unless `allowExpired` is set.
 */
export function validateRegistry(
	params: EvolutionParameter[],
	options: RegistryValidationOptions = {},
): { ok: true } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const now = (options.now ?? new Date()).getTime();

	for (const id of REQUIRED_PARAMETER_IDS) {
		if (!params.some((p) => p.id === id)) {
			errors.push(`missing parameter ${id}`);
		}
	}

	const seen = new Set<string>();
	for (const param of params) {
		if (seen.has(param.id)) {
			errors.push(`duplicate parameter id ${param.id}`);
		}
		seen.add(param.id);

		const result = validateParameter(param);
		if (!result.ok) {
			for (const error of result.errors) {
				errors.push(`${param.id}: ${error}`);
			}
		}

		if (!options.allowExpired) {
			const expiresAt = Date.parse(param.expiresAt);
			if (!Number.isNaN(expiresAt) && expiresAt <= now) {
				errors.push(`expired parameter ${param.id} (expiresAt ${param.expiresAt})`);
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true };
}
