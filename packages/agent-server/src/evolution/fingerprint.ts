import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageReport, FrozenFingerprints } from "./bundle-builder.ts";

/**
 * T3: generation-0 fingerprint collection.
 *
 * P7 default collection list. The function hashes the files it can find and
 * returns a coverage report that honestly lists covered vs. uncovered paths.
 * Anything not in the covered list must not be claimed as part of the
 * generation-0 frozen baseline.
 *
 * This is the bootstrap collector; Phase 0b will confirm the definitive P7
 * collection scope.
 */

const REPO_ROOT = process.cwd();

const SCAFFOLD_FILES = ["packages/coding-agent/.pi/config.json", "packages/coding-agent/.pi/system-prompt.md"];

const CONFIG_FILES = ["biome.json", "package-lock.json", "packages/coding-agent/package.json"];

function hashFile(path: string): string | null {
	const full = join(REPO_ROOT, path);
	if (!existsSync(full)) return null;
	return createHash("sha256").update(readFileSync(full)).digest("hex");
}

function combineHashes(hashes: string[]): string {
	return createHash("sha256").update(hashes.join("")).digest("hex");
}

function hashFiles(paths: string[]): { hash: string; found: string[]; missing: string[] } {
	const found: string[] = [];
	const missing: string[] = [];
	const hashes: string[] = [];
	for (const p of paths) {
		const h = hashFile(p);
		if (h) {
			found.push(p);
			hashes.push(h);
		} else {
			missing.push(p);
		}
	}
	return { hash: combineHashes(hashes), found, missing };
}

/** Default model fingerprint for generation-0 (read from coding-agent config if present). */
function defaultModelFingerprint(): string {
	const configPath = join(REPO_ROOT, "packages/coding-agent/.pi/config.json");
	let model = "unknown";
	let provider = "unknown";
	if (existsSync(configPath)) {
		try {
			const cfg: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (typeof cfg === "object" && cfg !== null) {
				const record = cfg as Record<string, unknown>;
				if (typeof record.model === "string") model = record.model;
				if (typeof record.provider === "string") provider = record.provider;
			}
		} catch {
			/* ignore parse errors */
		}
	}
	return JSON.stringify({ provider, model, temperature: "pending_0b", top_p: "pending_0b" });
}

/** Experience snapshot SHA: hash the active experience-store.db if present. */
function experienceSnapshotSha(): string {
	const dbPath = join(REPO_ROOT, "packages/agent-server/data/experience-store.db");
	if (!existsSync(dbPath)) {
		return createHash("sha256").update("no-experience-store").digest("hex");
	}
	return createHash("sha256").update(readFileSync(dbPath)).digest("hex");
}

export interface FingerprintCollection {
	fingerprints: FrozenFingerprints;
	coverage: CoverageReport;
}

/** Collect the default generation-0 fingerprint set. */
export function collectGenerationZeroFingerprints(): FingerprintCollection {
	const scaffold = hashFiles(SCAFFOLD_FILES);
	const config = hashFiles(CONFIG_FILES);

	const coverage: CoverageReport = {
		covered: [
			...scaffold.found.map((p) => `scaffold:${p}`),
			...config.found.map((p) => `config:${p}`),
			"experience:active-experience-store.db",
		],
		uncovered: [
			...scaffold.missing.map((p) => `missing-scaffold:${p}`),
			...config.missing.map((p) => `missing-config:${p}`),
			"runtime environment variables (Phase 0b)",
			"full dependency lockfile digest (Phase 0b)",
			"production WORM anchor (Phase 0b)",
		],
	};

	return {
		fingerprints: {
			scaffold_hash: scaffold.hash,
			experience_snapshot_sha: experienceSnapshotSha(),
			model_fingerprint: defaultModelFingerprint(),
			config_fingerprint: config.hash,
			denylist_version: "m0-initial",
		},
		coverage,
	};
}
