import type { ExperienceStore } from "../experience-store.ts";
import type { Experience } from "../types.ts";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { ArtifactManifest } from "./artifact-schema.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { LineageTracker } from "./lineage.ts";

/**
 * P2-T24: M1 experience candidate generator.
 *
 * Adapts the offline evolution pipeline (offline/scheduler.ts `runDailyEvolution`)
 * into a candidate generator whose output is a versioned, content-addressed
 * `experience_snapshot` artifact (architecture §6.1) instead of a direct
 * promotion into the active experience library:
 *
 *   - "draft"       — simplified stand-in for the LLM offline pipeline: reads the
 *                     active library from the ExperienceStore and snapshots it.
 *                     No LLM calls in M1; the real TS→Python pipeline is wired
 *                     behind this entry point in a later phase.
 *   - "improve"     — deterministic transformation of the parent snapshot:
 *                     dedupe by contentHash (keep highest quality) and re-rank.
 *   - "consolidate" — merge entries that share a title (keep the highest-quality
 *                     entry per title), then dedupe + re-rank.
 *
 * The snapshot blob format below is the M1-local minimal format. T22
 * (`experience-snapshot-builder.ts`) owns the full-fidelity payload format
 * ({ entry_count, source_db_sha, entries }); `parseSnapshot` accepts both so
 * improve/consolidate work on parents produced by either path. The
 * artifact/lineage plumbing here is the stable contract.
 *
 * Every mutation-plane output goes through the artifact registry (CAS, fail
 * closed) and one lineage edge per parent is recorded in `lineage_edges`.
 * Failures never throw: they return `status: "failed"` with the error message
 * so the caller can keep the failure record (plan T24 TDD: 保留失败记录).
 */

export const SNAPSHOT_BLOB_FORMAT = "experience-snapshot/v1";

const EXPERIENCE_TYPES: readonly Experience["type"][] = ["SKILL", "SOP", "ABILITY", "EVIDENCE"];
/** Max active rows read per type when drafting from the store. */
const DRAFT_LIST_LIMIT = 10_000;
/** Default entry budget (max entries kept in the candidate snapshot). */
const DEFAULT_BUDGET = 1_000;

export interface SnapshotEntry {
	id: string;
	type: string;
	title: string;
	quality: number;
	confidence: number;
	contentHash: string;
	payload: Record<string, unknown>;
}

export interface ExperienceSnapshotBlob {
	format: typeof SNAPSHOT_BLOB_FORMAT;
	entries: SnapshotEntry[];
}

export interface CandidateGenerationInput {
	/** Parent snapshot artifact_id. Required for improve/consolidate; optional for draft. */
	parentSnapshotId?: string;
	operator: "draft" | "improve" | "consolidate";
	/** Failure-cluster/issue/trace/task IDs backing this generation. */
	evidenceRefs: string[];
	/** Max entries kept in the candidate snapshot. Default 1000. */
	budget?: number;
}

export interface CandidateGenerationResult {
	candidateId: string;
	snapshotArtifactId: string;
	parentIds: string[];
	operator: CandidateGenerationInput["operator"];
	status: "generated" | "failed";
	error?: string;
}

/** Deterministic candidate id: hash of the generation inputs + resulting artifact (or failure). */
function computeCandidateId(operator: string, parentIds: string[], evidenceRefs: string[], outcome: string): string {
	return `cand-${sha256Hex(canonicalJson([operator, parentIds, evidenceRefs, outcome])).slice(0, 32)}`;
}

function toSnapshotEntry(exp: Experience): SnapshotEntry {
	return {
		id: exp.id,
		type: exp.type,
		title: exp.title,
		quality: exp.quality,
		confidence: exp.confidence,
		contentHash: exp.contentHash,
		payload: exp.payload,
	};
}

/** Rank: quality desc, ties broken by contentHash asc (deterministic). */
function rank(entries: SnapshotEntry[]): SnapshotEntry[] {
	return [...entries].sort((a, b) => b.quality - a.quality || (a.contentHash < b.contentHash ? -1 : 1));
}

/** Dedupe by contentHash, keeping the highest-quality entry per hash. */
function dedupeByContentHash(entries: SnapshotEntry[]): SnapshotEntry[] {
	const best = new Map<string, SnapshotEntry>();
	for (const entry of entries) {
		const existing = best.get(entry.contentHash);
		if (!existing || entry.quality > existing.quality) {
			best.set(entry.contentHash, entry);
		}
	}
	return [...best.values()];
}

/** Merge entries sharing a title, keeping the highest-quality entry per title. */
function mergeByTitle(entries: SnapshotEntry[]): SnapshotEntry[] {
	const best = new Map<string, SnapshotEntry>();
	for (const entry of entries) {
		const existing = best.get(entry.title);
		if (!existing || entry.quality > existing.quality) {
			best.set(entry.title, entry);
		}
	}
	return [...best.values()];
}

function serializeSnapshot(entries: SnapshotEntry[]): Buffer {
	const blob: ExperienceSnapshotBlob = { format: SNAPSHOT_BLOB_FORMAT, entries };
	return Buffer.from(canonicalJson(blob), "utf8");
}

/**
 * Parse a parent snapshot blob. Accepts the M1-local format
 * ({ format, entries }) and the T22 builder payload
 * ({ entry_count, source_db_sha, entries }) whose entries are full
 * JSON-round-tripped Experience rows.
 */
function parseSnapshot(data: Buffer, artifactId: string): SnapshotEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data.toString("utf8"));
	} catch {
		throw new Error(`parent snapshot ${artifactId}: blob is not valid JSON`);
	}
	const blob = parsed as Partial<ExperienceSnapshotBlob>;
	if (!Array.isArray(blob.entries)) {
		throw new Error(`parent snapshot ${artifactId}: unexpected blob format ${String(blob.format)}`);
	}
	if (blob.format === SNAPSHOT_BLOB_FORMAT) {
		return blob.entries;
	}
	// T22 payload format: entries are full Experience rows.
	return (blob.entries as unknown[]).map((row) => toSnapshotEntry(row as Experience));
}

function buildManifest(
	operator: CandidateGenerationInput["operator"],
	parentIds: string[],
	evidenceRefs: string[],
	blobHash: string,
): ArtifactManifest {
	return {
		kind: "experience_snapshot",
		parent_ids: parentIds,
		operator,
		scope: ["experience-library/active"],
		evidence_refs: evidenceRefs,
		// M1 mock: no real scaffold fingerprinting yet (T9 wires the real one);
		// deterministic placeholder so artifact_id stays content-addressed.
		scaffold_hash: sha256Hex("candidate-generator/scaffold/m1"),
		model_fingerprint: JSON.stringify({ model: "deterministic-mock", operator, temperature: 0 }),
		// Experience payloads contain user/session content; keep in step with
		// experience-snapshot-builder.ts / evidence-artifact-builder.ts.
		data_class: "user_content",
		retention_policy_ref: "pending_0b",
		blob_hashes: [blobHash],
	};
}

/** Draft-stage stand-in for the offline pipeline: snapshot the current active library. */
async function collectActiveEntries(store: ExperienceStore): Promise<SnapshotEntry[]> {
	const entries: SnapshotEntry[] = [];
	for (const type of EXPERIENCE_TYPES) {
		const rows = await store.listActive(type, DRAFT_LIST_LIMIT);
		for (const row of rows) {
			entries.push(toSnapshotEntry(row));
		}
	}
	return entries;
}

/**
 * Generate one experience candidate. Never throws: any pipeline, registry, or
 * lineage failure is returned as `status: "failed"` with the error message.
 */
export async function generateExperienceCandidate(
	store: ExperienceStore,
	registry: ArtifactRegistry,
	lineage: LineageTracker,
	input: CandidateGenerationInput,
): Promise<CandidateGenerationResult> {
	const parentIds = input.parentSnapshotId ? [input.parentSnapshotId] : [];
	const failed = (error: string): CandidateGenerationResult => ({
		candidateId: computeCandidateId(input.operator, parentIds, input.evidenceRefs, `failed:${error}`),
		snapshotArtifactId: "",
		parentIds,
		operator: input.operator,
		status: "failed",
		error,
	});

	try {
		if (input.budget !== undefined && (!Number.isInteger(input.budget) || input.budget <= 0)) {
			return failed(`budget must be a positive integer, got ${String(input.budget)}`);
		}
		if (input.operator !== "draft" && !input.parentSnapshotId) {
			return failed(`operator "${input.operator}" requires parentSnapshotId`);
		}

		const budget = input.budget ?? DEFAULT_BUDGET;
		let entries: SnapshotEntry[];
		let diffSummary: string;

		if (input.operator === "draft") {
			// Simplified offline pipeline (no LLM): snapshot of the active library,
			// deduped and ranked. Also applied when a draft parent is given, since
			// the draft re-reads the library rather than transforming the parent.
			const collected = await collectActiveEntries(store);
			entries = rank(dedupeByContentHash(collected)).slice(0, budget);
			diffSummary = `draft: ${collected.length} active -> ${entries.length} entries`;
		} else {
			const parentId = input.parentSnapshotId as string;
			const bundle = registry.fetchBundle(parentId);
			if (bundle.manifest.kind !== "experience_snapshot") {
				return failed(`parent ${parentId} is kind "${bundle.manifest.kind}", expected experience_snapshot`);
			}
			const parentEntries = parseSnapshot(bundle.blobs[0], parentId);
			if (input.operator === "improve") {
				entries = rank(dedupeByContentHash(parentEntries)).slice(0, budget);
				diffSummary = `improve: ${parentEntries.length} -> ${entries.length} entries (dedupe+rerank)`;
			} else {
				entries = rank(dedupeByContentHash(mergeByTitle(parentEntries))).slice(0, budget);
				diffSummary = `consolidate: ${parentEntries.length} -> ${entries.length} entries (merge-title+dedupe+rerank)`;
			}
		}

		const blob = serializeSnapshot(entries);
		const blobHash = sha256Hex(blob.toString("utf8"));
		const manifest = buildManifest(input.operator, parentIds, input.evidenceRefs, blobHash);
		const snapshotArtifactId = registry.storeArtifact(manifest, [blob]);

		for (const parentId of parentIds) {
			lineage.recordEdge({ parentId, childId: snapshotArtifactId, operator: input.operator, diffSummary });
		}

		return {
			candidateId: computeCandidateId(input.operator, parentIds, input.evidenceRefs, snapshotArtifactId),
			snapshotArtifactId,
			parentIds,
			operator: input.operator,
			status: "generated",
		};
	} catch (err) {
		return failed(err instanceof Error ? err.message : String(err));
	}
}
