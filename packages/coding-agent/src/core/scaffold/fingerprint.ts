/**
 * P3-T29: canonical JSON fingerprint for a scaffold configuration.
 *
 * The fingerprint is a content-addressed sha256 hex digest of the canonical
 * JSON serialization of the ScaffoldConfig. It is intentionally independent
 * of the agent-server artifact canonicalization so the coding-agent package
 * does not depend on the evolution control plane.
 */

import { createHash } from "node:crypto";
import type { ScaffoldConfig } from "./schema.ts";

function serializeValue(value: unknown): string {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number": {
			if (!Number.isFinite(value)) {
				throw new Error("scaffold fingerprint: non-finite number cannot be serialized");
			}
			if (Object.is(value, -0)) {
				return "0";
			}
			if (Number.isSafeInteger(value)) {
				return String(value);
			}
			return JSON.stringify(value);
		}
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
			throw new Error(`scaffold fingerprint: unsupported value type "${typeof value}"`);
	}
}

/** Return the canonical JSON serialization of a scaffold config. */
export function canonicalScaffoldJson(config: ScaffoldConfig): string {
	return serializeValue(config);
}

/** Return the sha256 hex fingerprint of a scaffold config. */
export function fingerprintScaffoldConfig(config: ScaffoldConfig): string {
	return createHash("sha256").update(canonicalScaffoldJson(config), "utf8").digest("hex");
}
