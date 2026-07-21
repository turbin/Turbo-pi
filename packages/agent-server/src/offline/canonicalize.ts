import { createHash } from "node:crypto";

/**
 * TS-side canonicalize (SPEC §6 Stage 4 / §4.2 step 5).
 *
 * The LLM-based canonicalize (TF-IDF blocking + five-rubric adjudication)
 * lives in the vendored Python `verification_selection` package and already
 * runs inside the offline pipeline. This module is the deterministic store
 * gate: identical content must never produce duplicate Experience rows, and a
 * verified re-run must be able to find the row it would duplicate.
 *
 * Dedup key = sha256 over the canonical JSON of (type, title, payload), so
 * key ordering inside payloads does not affect the hash.
 */

export interface Canonicalizable {
	type: string;
	title: string;
	payload: Record<string, unknown>;
}

/** Stable JSON serialization: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function contentHashFor(item: Canonicalizable): string {
	return createHash("sha256")
		.update(canonicalJson({ type: item.type, title: item.title, payload: item.payload }))
		.digest("hex");
}

/** Drop later occurrences of the same hash within a batch; first wins. */
export function dedupeCandidates<T>(items: T[], hashOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	const kept: T[] = [];
	for (const item of items) {
		const hash = hashOf(item);
		if (seen.has(hash)) continue;
		seen.add(hash);
		kept.push(item);
	}
	return kept;
}
