import type { ArtifactRegistry } from "./artifact-registry.ts";

/**
 * P2-T25: executable replay/validation for experience candidates.
 *
 * Loads a candidate (and optionally a baseline) `experience_snapshot` artifact
 * from the T3 registry, replays its metric profile (entry count, quality
 * distribution, contentHash overlap), and emits a verdict:
 *
 *   pass         — candidate quality >= baseline on every compared axis and no
 *                  baseline contentHash is lost;
 *   reject       — candidate regresses (lower mean/min quality, lost baseline
 *                  hashes) or carries structurally invalid entries;
 *   inconclusive — metrics cannot be determined (missing artifact, unparsable
 *                  blob, wrong kind, or an empty snapshot on either side).
 *
 * Both snapshot blob formats are accepted: T22 (`experience-snapshot-builder`:
 * { entry_count, source_db_sha, entries } with full Experience rows) and T24
 * (`candidate-generator`: { format: "experience-snapshot/v1", entries }).
 *
 * The verdict is a pure function of artifact contents: same input -> same
 * verdict. `timestamp` defaults to wall clock; pass `options.now` for a fully
 * deterministic result record.
 */

export type ReplayVerdict = "pass" | "reject" | "inconclusive";

export interface SnapshotMetrics {
	entryCount: number;
	meanQuality: number | null;
	minQuality: number | null;
	/** Histogram over the frozen buckets "0.0-0.2" .. "0.8-1.0". */
	qualityDistribution: Record<string, number>;
	distinctContentHashes: number;
}

export interface ReplayMetrics {
	candidate: SnapshotMetrics | null;
	baseline: SnapshotMetrics | null;
	/** Fraction of baseline contentHashes still present in the candidate; null without baseline. */
	contentHashOverlap: number | null;
	/** Baseline contentHashes missing from the candidate; null without baseline. */
	lostContentHashes: number | null;
	meanQualityDelta: number | null;
	minQualityDelta: number | null;
	/** Entries with a non-finite/out-of-range quality or missing contentHash. */
	invalidEntries: number;
}

export interface ReplayResult {
	candidateId: string;
	baselineId: string | null;
	metrics: ReplayMetrics;
	verdict: ReplayVerdict;
	timestamp: string;
}

export interface ReplayOptions {
	/** Fixed ISO timestamp for deterministic results. Defaults to current time. */
	now?: string;
}

interface NormalizedEntry {
	quality: number;
	contentHash: string;
}

interface ParsedSnapshot {
	entries: NormalizedEntry[];
	/** T22 declared entry_count; null for the T24 format. */
	declaredCount: number | null;
}

const QUALITY_BUCKETS = ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"] as const;
/** Float tolerance for quality comparisons. */
const EPSILON = 1e-9;

function parseSnapshotBlob(data: Buffer): ParsedSnapshot {
	const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
	if (!Array.isArray(parsed.entries)) {
		throw new Error("snapshot blob has no entries array");
	}
	const declaredCount = typeof parsed.entry_count === "number" ? parsed.entry_count : null;
	const entries = (parsed.entries as Record<string, unknown>[]).map((row) => ({
		quality: typeof row.quality === "number" ? row.quality : Number.NaN,
		contentHash: typeof row.contentHash === "string" ? row.contentHash : "",
	}));
	return { entries, declaredCount };
}

/** Load and parse a snapshot artifact; null on any registry/parse failure or wrong kind. */
function loadSnapshot(registry: ArtifactRegistry, artifactId: string): ParsedSnapshot | null {
	try {
		const bundle = registry.fetchBundle(artifactId);
		if (bundle.manifest.kind !== "experience_snapshot" || bundle.blobs.length !== 1) {
			return null;
		}
		return parseSnapshotBlob(bundle.blobs[0]);
	} catch {
		return null;
	}
}

function countInvalid(entries: NormalizedEntry[]): number {
	return entries.filter((e) => !Number.isFinite(e.quality) || e.quality < 0 || e.quality > 1 || e.contentHash === "")
		.length;
}

export function computeMetrics(entries: NormalizedEntry[]): SnapshotMetrics {
	const qualityDistribution: Record<string, number> = {};
	for (const bucket of QUALITY_BUCKETS) {
		qualityDistribution[bucket] = 0;
	}
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	const hashes = new Set<string>();
	for (const entry of entries) {
		sum += entry.quality;
		if (entry.quality < min) {
			min = entry.quality;
		}
		hashes.add(entry.contentHash);
		const idx = Math.min(QUALITY_BUCKETS.length - 1, Math.max(0, Math.floor(entry.quality * 5)));
		qualityDistribution[QUALITY_BUCKETS[idx] as string] += 1;
	}
	return {
		entryCount: entries.length,
		meanQuality: entries.length > 0 ? sum / entries.length : null,
		minQuality: entries.length > 0 ? min : null,
		qualityDistribution,
		distinctContentHashes: hashes.size,
	};
}

function makeResult(
	candidateId: string,
	baselineId: string | null,
	metrics: ReplayMetrics,
	verdict: ReplayVerdict,
	now: string,
): ReplayResult {
	return { candidateId, baselineId, metrics, verdict, timestamp: now };
}

/**
 * Replay a candidate against a baseline snapshot and emit a verdict.
 * Never throws: any load/parse failure degrades to `inconclusive`.
 */
export function replayCandidate(
	candidateArtifactId: string,
	baselineArtifactId: string,
	registry: ArtifactRegistry,
	options: ReplayOptions = {},
): Promise<ReplayResult> {
	const now = options.now ?? new Date().toISOString();
	const candidate = loadSnapshot(registry, candidateArtifactId);
	const baseline = loadSnapshot(registry, baselineArtifactId);

	const metrics: ReplayMetrics = {
		candidate: candidate ? computeMetrics(candidate.entries) : null,
		baseline: baseline ? computeMetrics(baseline.entries) : null,
		contentHashOverlap: null,
		lostContentHashes: null,
		meanQualityDelta: null,
		minQualityDelta: null,
		invalidEntries:
			(candidate ? countInvalid(candidate.entries) : 0) + (baseline ? countInvalid(baseline.entries) : 0),
	};

	if (!candidate || !baseline) {
		return Promise.resolve(makeResult(candidateArtifactId, baselineArtifactId, metrics, "inconclusive", now));
	}
	if (countInvalid(candidate.entries) > 0) {
		return Promise.resolve(makeResult(candidateArtifactId, baselineArtifactId, metrics, "reject", now));
	}
	if (countInvalid(baseline.entries) > 0 || candidate.entries.length === 0 || baseline.entries.length === 0) {
		return Promise.resolve(makeResult(candidateArtifactId, baselineArtifactId, metrics, "inconclusive", now));
	}

	const candidateHashes = new Set(candidate.entries.map((e) => e.contentHash));
	const baselineHashes = new Set(baseline.entries.map((e) => e.contentHash));
	let lost = 0;
	for (const hash of baselineHashes) {
		if (!candidateHashes.has(hash)) {
			lost += 1;
		}
	}
	metrics.lostContentHashes = lost;
	metrics.contentHashOverlap = baselineHashes.size > 0 ? (baselineHashes.size - lost) / baselineHashes.size : null;
	metrics.meanQualityDelta = (metrics.candidate?.meanQuality ?? 0) - (metrics.baseline?.meanQuality ?? 0);
	metrics.minQualityDelta = (metrics.candidate?.minQuality ?? 0) - (metrics.baseline?.minQuality ?? 0);

	const regressed =
		lost > 0 || (metrics.meanQualityDelta as number) < -EPSILON || (metrics.minQualityDelta as number) < -EPSILON;
	return Promise.resolve(
		makeResult(candidateArtifactId, baselineArtifactId, metrics, regressed ? "reject" : "pass", now),
	);
}

/**
 * Validate a candidate snapshot on its own (no baseline comparison).
 * pass: well-formed, non-empty, declared count consistent; reject: structurally
 * invalid entries or entry_count mismatch; inconclusive: unloadable or empty.
 */
export function validateCandidate(
	candidateArtifactId: string,
	registry: ArtifactRegistry,
	options: ReplayOptions = {},
): Promise<ReplayResult> {
	const now = options.now ?? new Date().toISOString();
	const candidate = loadSnapshot(registry, candidateArtifactId);
	const metrics: ReplayMetrics = {
		candidate: candidate ? computeMetrics(candidate.entries) : null,
		baseline: null,
		contentHashOverlap: null,
		lostContentHashes: null,
		meanQualityDelta: null,
		minQualityDelta: null,
		invalidEntries: candidate ? countInvalid(candidate.entries) : 0,
	};

	let verdict: ReplayVerdict;
	if (!candidate || candidate.entries.length === 0) {
		verdict = "inconclusive";
	} else if (
		metrics.invalidEntries > 0 ||
		(candidate.declaredCount !== null && candidate.declaredCount !== candidate.entries.length)
	) {
		verdict = "reject";
	} else {
		verdict = "pass";
	}
	return Promise.resolve(makeResult(candidateArtifactId, null, metrics, verdict, now));
}
