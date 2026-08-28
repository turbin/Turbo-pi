/**
 * P5-1: capability-limited candidate-extension ABI manifest.
 *
 * A candidate extension is the unit of source-level self-bootstrap. It is
 * strictly smaller than the full pi extension API: only declarative policies
 * and pure transform functions are allowed in v1. The ABI is enforced by the
 * manifest validator before any candidate is loaded, built into an artifact, or
 * executed in an isolated runner.
 */

export const CANDIDATE_ABI_VERSION = "candidate-extension-v1" as const;

export const CANDIDATE_CAPABILITIES = [
	"declarative/tool-prompt",
	"declarative/system-guideline",
	"declarative/replacement",
	"transform/text",
	"transform/json",
] as const;
export type CandidateCapability = (typeof CANDIDATE_CAPABILITIES)[number];

/** Provenance metadata linking a candidate back to the failure cluster that produced it. */
export interface CandidateProvenance {
	taskId: string;
	clusterId: string;
	evidenceArtifactId: string;
}

/** Declarative policy: extra prompt snippet shown when a named tool is active. */
export interface ToolPromptPolicy {
	toolName: string;
	promptSnippet: string;
}

/** Declarative policy: literal pattern → replacement, optionally scoped to paths. */
export interface ReplacementPolicy {
	pattern: string;
	replacement: string;
	/** Optional path prefixes where the replacement may apply. */
	paths?: string[];
}

/** Declarative policy section: static, model-readable instructions. */
export interface DeclarativePolicies {
	toolPrompts?: ToolPromptPolicy[];
	systemGuidelines?: string[];
	replacements?: ReplacementPolicy[];
}

/**
 * Candidate-extension manifest.
 *
 * The manifest is stored as blob[1] of a `source_patch` artifact (blob[0] is
 * the unified diff). It declares what the candidate can do (capabilities),
 * where it came from (provenance), and any static declarations or transform
 * entry point. No field may contain network endpoints, shell commands, or
 * absolute paths.
 */
export interface CandidateExtensionManifest {
	abiVersion: typeof CANDIDATE_ABI_VERSION;
	name: string;
	description: string;
	generatedFrom: CandidateProvenance;
	capabilities: CandidateCapability[];
	declarations?: DeclarativePolicies;
	/**
	 * Relative path to the transform module inside the source_patch artifact,
	 * e.g. "transform.js". Optional; required when a transform capability is
	 * declared.
	 */
	entry?: string;
}

export type CandidateManifestValidation =
	| { ok: true; manifest: CandidateExtensionManifest }
	| { ok: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCapability(value: unknown): value is CandidateCapability {
	return isNonEmptyString(value) && (CANDIDATE_CAPABILITIES as readonly string[]).includes(value);
}

function validateProvenance(input: unknown, path: string): string[] {
	const errors: string[] = [];
	if (!isPlainObject(input)) {
		return [`${path}: expected an object`];
	}
	const record = input as Record<string, unknown>;
	for (const key of ["taskId", "clusterId", "evidenceArtifactId"] as const) {
		if (!isNonEmptyString(record[key])) {
			errors.push(`${path}.${key}: expected non-empty string`);
		}
	}
	return errors;
}

function validateToolPrompts(input: unknown, path: string): string[] {
	const errors: string[] = [];
	if (!Array.isArray(input)) {
		return [`${path}: expected an array`];
	}
	for (const [index, item] of input.entries()) {
		const itemPath = `${path}[${index}]`;
		if (!isPlainObject(item)) {
			errors.push(`${itemPath}: expected an object`);
			continue;
		}
		const record = item as Record<string, unknown>;
		if (!isNonEmptyString(record.toolName)) {
			errors.push(`${itemPath}.toolName: expected non-empty string`);
		}
		if (!isNonEmptyString(record.promptSnippet)) {
			errors.push(`${itemPath}.promptSnippet: expected non-empty string`);
		}
		for (const key of Object.keys(record)) {
			if (key !== "toolName" && key !== "promptSnippet") {
				errors.push(`${itemPath}.${key}: unknown field`);
			}
		}
	}
	return errors;
}

function validateReplacements(input: unknown, path: string): string[] {
	const errors: string[] = [];
	if (!Array.isArray(input)) {
		return [`${path}: expected an array`];
	}
	for (const [index, item] of input.entries()) {
		const itemPath = `${path}[${index}]`;
		if (!isPlainObject(item)) {
			errors.push(`${itemPath}: expected an object`);
			continue;
		}
		const record = item as Record<string, unknown>;
		if (!isNonEmptyString(record.pattern)) {
			errors.push(`${itemPath}.pattern: expected non-empty string`);
		}
		if (typeof record.replacement !== "string") {
			errors.push(`${itemPath}.replacement: expected string`);
		}
		if (record.paths !== undefined && !isStringArray(record.paths)) {
			errors.push(`${itemPath}.paths: expected array of non-empty strings`);
		}
		for (const key of Object.keys(record)) {
			if (key !== "pattern" && key !== "replacement" && key !== "paths") {
				errors.push(`${itemPath}.${key}: unknown field`);
			}
		}
	}
	return errors;
}

function validateDeclarations(input: unknown, path: string): string[] {
	const errors: string[] = [];
	if (!isPlainObject(input)) {
		return [`${path}: expected an object`];
	}
	const record = input as Record<string, unknown>;
	if (record.toolPrompts !== undefined) {
		errors.push(...validateToolPrompts(record.toolPrompts, `${path}.toolPrompts`));
	}
	if (record.systemGuidelines !== undefined) {
		if (!isStringArray(record.systemGuidelines)) {
			errors.push(`${path}.systemGuidelines: expected array of non-empty strings`);
		}
	}
	if (record.replacements !== undefined) {
		errors.push(...validateReplacements(record.replacements, `${path}.replacements`));
	}
	for (const key of Object.keys(record)) {
		if (key !== "toolPrompts" && key !== "systemGuidelines" && key !== "replacements") {
			errors.push(`${path}.${key}: unknown field`);
		}
	}
	return errors;
}

/**
 * Fail-closed manifest validation.
 *
 * Rejects unknown fields, missing required fields, unsupported capabilities, and
 * transform entry points missing when a transform capability is declared.
 */
export function validateCandidateManifest(input: unknown): CandidateManifestValidation {
	if (!isPlainObject(input)) {
		return { ok: false, errors: ["candidate manifest: expected a JSON object"] };
	}
	const record = input as Record<string, unknown>;
	const errors: string[] = [];

	for (const key of Object.keys(record)) {
		if (
			key !== "abiVersion" &&
			key !== "name" &&
			key !== "description" &&
			key !== "generatedFrom" &&
			key !== "capabilities" &&
			key !== "declarations" &&
			key !== "entry"
		) {
			errors.push(`candidate manifest.${key}: unknown field`);
		}
	}

	if (record.abiVersion !== CANDIDATE_ABI_VERSION) {
		errors.push(`candidate manifest.abiVersion: must be "${CANDIDATE_ABI_VERSION}"`);
	}
	if (!isNonEmptyString(record.name)) {
		errors.push("candidate manifest.name: expected non-empty string");
	}
	if (typeof record.description !== "string") {
		errors.push("candidate manifest.description: expected string");
	}

	errors.push(...validateProvenance(record.generatedFrom, "candidate manifest.generatedFrom"));

	if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) {
		errors.push("candidate manifest.capabilities: expected non-empty array");
	} else {
		for (const [index, cap] of record.capabilities.entries()) {
			if (!isValidCapability(cap)) {
				errors.push(`candidate manifest.capabilities[${index}]: unsupported capability "${String(cap)}"`);
			}
		}
	}

	if (record.declarations !== undefined) {
		errors.push(...validateDeclarations(record.declarations, "candidate manifest.declarations"));
	}

	const needsEntry =
		Array.isArray(record.capabilities) && record.capabilities.some((cap) => String(cap).startsWith("transform/"));
	if (needsEntry) {
		if (!isNonEmptyString(record.entry)) {
			errors.push("candidate manifest.entry: required non-empty string when a transform capability is declared");
		}
	} else if (record.entry !== undefined && !isNonEmptyString(record.entry)) {
		errors.push("candidate manifest.entry: expected non-empty string or omitted");
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true, manifest: record as unknown as CandidateExtensionManifest };
}
