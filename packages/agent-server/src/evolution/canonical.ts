import { createHash } from "node:crypto";
import type { ArtifactManifest } from "./artifact-schema.ts";

/**
 * T2: canonical JSON serialization + content-addressed hash (architecture §3.3 / §6.1 / D3 / A3).
 *
 * ==================== FROZEN canonical JSON spec (plain-text rules) ====================
 * The T4 evaluation-kernel re-implements this independently (no import of this
 * module) and MUST produce byte-identical serialization per this spec; T8
 * cross-checks both implementations. Any change requires updating this comment
 * and passing the T8 reconciliation suite.
 *
 * 1. Objects: keys sorted ascending by UTF-16 code unit value, recursively;
 *    emitted as `{"k1":v1,"k2":v2}` with no whitespace (for ASCII keys this
 *    equals byte order; the rule is frozen as code-unit order).
 * 2. Arrays: `[v1,v2]`, elements in order, no whitespace.
 * 3. Strings: JSON escaping per JSON.stringify semantics — `"` -> `\"`,
 *    `\` -> `\\`, short forms `\b \t \n \f \r`; all other U+0000–U+001F and
 *    U+2028/U+2029 as `\uXXXX`; all other characters emitted literally
 *    (UTF-8; ASCII is never \u-escaped).
 * 4. Numbers: finite values only; `-0` normalized to `0`; integers with
 *    |n| < 2^53 written as plain decimal (no exponent, no trailing ".0");
 *    everything else per ECMAScript Number::toString shortest round-trip
 *    (identical to JSON.stringify, exponent notation allowed).
 *    NaN / Infinity / -Infinity / undefined / function / symbol / bigint
 *    ALWAYS throw — never silently drop keys, never emit "null" (raw
 *    JSON.stringify would drop undefined keys and write NaN as null; it must
 *    not be used directly).
 * 5. Booleans / null: `true` / `false` / `null`.
 * 6. No trailing newline; the hash input is the UTF-8 encoding of the text.
 *
 * ==================== FROZEN artifact_id contract ====================
 * artifact_id = sha256_hex( utf8(canonicalJson(manifest)) ++ utf8(canonicalJson(manifest.blob_hashes)) )
 *   - canonicalJson(manifest): canonical text of the full manifest (including
 *     its blob_hashes field);
 *   - canonicalJson(manifest.blob_hashes): the blob_hashes array serialized
 *     independently;
 *   - "++": byte-level concatenation with NO separator (the two fragments end
 *     with `}` and start with `[`, so the boundary is unambiguous);
 *   - output: 64 lowercase hex chars.
 * The manifest carries no timestamp/random fields: created_at / artifact_id /
 * canonical_manifest are storage metadata (T1 table columns), not manifest
 * fields (rejected by the artifact-schema.ts validator), so rebuilds do not
 * produce new IDs from wall-clock drift (A3 stability).
 */

/** Stable JSON serialization (frozen spec in the header comment). Non-JSON values throw. */
export function canonicalJson(value: unknown): string {
	return serializeValue(value);
}

function serializeValue(value: unknown): string {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			return serializeNumber(value);
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map(serializeValue).join(",")}]`;
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeValue(record[key])}`).join(",")}}`;
		}
		default:
			throw new Error(
				`canonicalJson: unsupported value type "${typeof value}" (undefined/function/symbol/bigint are not JSON)`,
			);
	}
}

function serializeNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error(`canonicalJson: non-finite number ${value} cannot be serialized`);
	}
	if (Object.is(value, -0)) {
		return "0";
	}
	// Integers within 2^53 are written as plain decimal digits so integer
	// fields such as cost_micros are byte-exact; everything else uses the
	// Number::toString shortest round-trip (identical to JSON.stringify).
	if (Number.isSafeInteger(value)) {
		return String(value);
	}
	return JSON.stringify(value);
}

/** sha256 hex digest (64 lowercase chars). */
export function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

/** artifact_id computation contract (frozen, see header comment). */
export function computeArtifactId(manifest: ArtifactManifest): string {
	const manifestText = canonicalJson(manifest);
	const blobHashesText = canonicalJson(manifest.blob_hashes);
	return sha256Hex(manifestText + blobHashesText);
}

/**
 * Rebuild artifact_id from stored row text (T1 `artifact_immutable_manifests`
 * columns canonical_manifest + blob_hashes; the anchor for full-chain rebuild).
 * Throws if either text is not canonical (parse -> re-serialize differs): a
 * corrupted or non-canonical row must not yield a usable ID (fail closed).
 */
export function recomputeArtifactId(canonicalManifestText: string, blobHashesJsonText: string): string {
	if (canonicalJson(JSON.parse(canonicalManifestText) as unknown) !== canonicalManifestText) {
		throw new Error("recomputeArtifactId: canonical_manifest text is not canonical JSON");
	}
	if (canonicalJson(JSON.parse(blobHashesJsonText) as unknown) !== blobHashesJsonText) {
		throw new Error("recomputeArtifactId: blob_hashes text is not canonical JSON");
	}
	return sha256Hex(canonicalManifestText + blobHashesJsonText);
}
