import type { ArtifactRegistry } from "./artifact-registry.ts";
import { FAILURE_TAXONOMY, type FailureTaxonomy } from "./taxonomy.ts";

/**
 * P1-T19: failure classification for the evidence collection path.
 *
 * Integrates the Phase 0a failure taxonomy (T7, V3 §8.1) into evidence
 * handling: every failure record must be attributed to one taxonomy category,
 * with `unknown` as the fail-closed catch-all (confidence 0) whenever no
 * trustworthy signal exists. Classification never guesses: invalid hints and
 * unparseable artifacts degrade to `unknown`, never to a fabricated category.
 */

export interface FailureClassification {
	taskId: string;
	category: FailureTaxonomy;
	/** Confidence in [0, 1]; 0 means "no basis for attribution" (unknown). */
	confidence: number;
	evidenceRefs: string[];
	classifiedAt: number;
}

/** Optional caller-supplied suggestion. An invalid/missing category degrades to unknown. */
export interface FailureClassificationHints {
	category?: unknown;
	confidence?: number;
}

export type ClassificationValidation = { ok: true; value: FailureClassification } | { ok: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isTaxonomyCategory(value: unknown): value is FailureTaxonomy {
	return isNonEmptyString(value) && (FAILURE_TAXONOMY as readonly string[]).includes(value);
}

function isValidConfidence(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Fail-closed validation of a classification record. */
export function validateFailureClassification(input: unknown): ClassificationValidation {
	const errors: string[] = [];
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, errors: ["failureClassification: expected object"] };
	}
	const record = input as Record<string, unknown>;
	if (!isNonEmptyString(record.taskId)) {
		errors.push("taskId: expected non-empty string");
	}
	if (!isTaxonomyCategory(record.category)) {
		errors.push(`category: expected one of ${FAILURE_TAXONOMY.join(" | ")}`);
	}
	if (!isValidConfidence(record.confidence)) {
		errors.push("confidence: expected number in [0, 1]");
	}
	if (!Array.isArray(record.evidenceRefs) || !record.evidenceRefs.every((v) => typeof v === "string")) {
		errors.push("evidenceRefs: expected array of strings");
	}
	if (typeof record.classifiedAt !== "number" || !Number.isFinite(record.classifiedAt)) {
		errors.push("classifiedAt: expected finite number");
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: record as unknown as FailureClassification };
}

/**
 * Classifies a failure. A valid hint category is adopted (confidence defaults
 * to 0.5 when not supplied); a missing or invalid hint category yields
 * `unknown` with confidence 0. Throws on empty taskId, malformed evidenceRefs,
 * or a hint confidence outside [0, 1].
 */
export function classifyFailure(
	taskId: string,
	evidenceRefs: string[],
	hints?: FailureClassificationHints,
): FailureClassification {
	if (!isNonEmptyString(taskId)) {
		throw new Error("classifyFailure: taskId must be a non-empty string");
	}
	if (!Array.isArray(evidenceRefs) || !evidenceRefs.every((v) => typeof v === "string")) {
		throw new Error("classifyFailure: evidenceRefs must be an array of strings");
	}
	let category: FailureTaxonomy = "unknown";
	let confidence = 0;
	if (hints !== undefined) {
		if (hints.confidence !== undefined && !isValidConfidence(hints.confidence)) {
			throw new Error("classifyFailure: hints.confidence must be in [0, 1]");
		}
		if (isTaxonomyCategory(hints.category)) {
			category = hints.category;
			confidence = hints.confidence ?? 0.5;
		}
	}
	return { taskId, category, confidence, evidenceRefs: [...evidenceRefs], classifiedAt: Date.now() };
}

function taskIdFromRefs(refs: string[], fallback: string): string {
	const ref = refs.find((r) => r.startsWith("task:") && r.length > "task:".length);
	return ref ? ref.slice("task:".length) : fallback;
}

function unknownClassification(taskId: string, refs: string[]): FailureClassification {
	return { taskId, category: "unknown", confidence: 0, evidenceRefs: [...refs], classifiedAt: Date.now() };
}

/**
 * Loads a stored evidence artifact and infers the failure category.
 *
 * Inference order (first match wins, fail closed to unknown):
 *   1. explicit manifest ref `failure:<category>` / `failure_category:<category>` (confidence 0.9);
 *   2. non-empty escalation_join_keys in the evidence payload -> model (0.6);
 *   3. any tool event carrying an error -> environment (0.5);
 *   4. otherwise (including missing artifact or unparseable blob) -> unknown (0).
 */
export function classifyFromEvidence(artifactId: string, registry: ArtifactRegistry): FailureClassification {
	let manifestRefs: string[] = [];
	let payload: unknown;
	try {
		const bundle = registry.fetchBundle(artifactId);
		manifestRefs = bundle.manifest.evidence_refs;
		payload = JSON.parse(bundle.blobs[0].toString("utf8"));
	} catch {
		return unknownClassification(taskIdFromRefs(manifestRefs, artifactId), manifestRefs);
	}

	const taskId = taskIdFromRefs(manifestRefs, artifactId);

	for (const ref of manifestRefs) {
		const match = /^failure(?:_category)?:(.+)$/.exec(ref);
		if (match && isTaxonomyCategory(match[1])) {
			return {
				taskId,
				category: match[1],
				confidence: 0.9,
				evidenceRefs: [...manifestRefs],
				classifiedAt: Date.now(),
			};
		}
	}

	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return unknownClassification(taskId, manifestRefs);
	}
	const record = payload as Record<string, unknown>;

	if (Array.isArray(record.escalation_join_keys) && record.escalation_join_keys.length > 0) {
		return { taskId, category: "model", confidence: 0.6, evidenceRefs: [...manifestRefs], classifiedAt: Date.now() };
	}
	if (
		Array.isArray(record.tool_events) &&
		record.tool_events.some(
			(e) => typeof e === "object" && e !== null && isNonEmptyString((e as Record<string, unknown>).error),
		)
	) {
		return {
			taskId,
			category: "environment",
			confidence: 0.5,
			evidenceRefs: [...manifestRefs],
			classifiedAt: Date.now(),
		};
	}
	return unknownClassification(taskId, manifestRefs);
}
