#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openArtifactRegistry } from "./artifact-registry.ts";
import { buildGenerationZeroBundle } from "./bundle-builder.ts";
import { openEvolutionDb } from "./db.ts";
import { collectGenerationZeroFingerprints } from "./fingerprint.ts";

/**
 * T3: mechanical generation-0 bundle builder script.
 *
 * Usage (from repo root):
 *   npx tsx packages/agent-server/src/evolution/build-gen0.ts <dataDir> [contractId]
 *
 * Outputs a JSON report to stdout with the content-addressed artifact_id, the
 * canonical manifest, blob hashes, and the P7 coverage report. Any missing
 * fingerprint aborts with a non-zero exit code (fail closed).
 *
 * The script performs no LLM calls, no network requests, and no signing; those
 * are wired in T9 (integration with TEK and promotion controller).
 */

function usage(): never {
	console.error("usage: build-gen0.ts <dataDir> <contractId>");
	process.exit(2);
}

function main(): void {
	const dataDir = process.argv[2];
	const contractId = process.argv[3];
	if (!dataDir || !contractId) usage();

	mkdirSync(dataDir, { recursive: true });
	const { fingerprints, coverage } = collectGenerationZeroFingerprints();

	const db = openEvolutionDb(join(dataDir, "evolution.db"));
	const registry = openArtifactRegistry(db.db, join(dataDir, "blobs"));

	try {
		const { manifest, blobs, artifactId } = buildGenerationZeroBundle(registry, fingerprints, contractId);
		const report = {
			artifact_id: artifactId,
			contract_id: contractId,
			canonical_manifest: manifest,
			blob_hashes: blobs.map((b) => createHash("sha256").update(b).digest("hex")),
			coverage,
		};
		console.log(JSON.stringify(report, null, 2));
	} finally {
		registry.close();
	}
}

main();
