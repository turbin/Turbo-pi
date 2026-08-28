// biome-ignore assist/source/organizeImports: scaffold-root.ts must load before cli.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restoreCwd, rootDir, writeScaffoldFiles } from "./scaffold-root.ts";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { type ReconciliationReport as Gen0RebuildReport, runCli } from "../../src/evolution/cli.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { type EvidenceArtifactInput, storeEvidenceArtifact } from "../../src/evolution/evidence-artifact-builder.ts";
import { reconcileTask } from "../../src/evolution/reconciliation.ts";

/**
 * P1-T21: Phase 1 end-to-end integration test.
 *
 * Verifies that random sampled tasks reconcile across the full chain
 *   task → request → model run → session → artifacts → grader
 * with zero orphan records:
 *   1. `gen0-rebuild` builds the gen0 baseline (bundle, attestation,
 *      deployment chain, resolved manifest) in a temp dataDir;
 *   2. a simulated coding-agent session writes the sidecar files
 *      (`version-contract.json`, `resolved-manifest-gen0-<ts>.json`) the
 *      runtime would have written for the sampled task;
 *   3. a synthetic evidence artifact aggregating tool events, product
 *      manifest, grader outcomes, user corrections and escalation join keys
 *      is stored via the T18 builder (carrying `task:<taskId>` evidence_refs);
 *   4. `reconcileTask` (T20) joins all three record families and must report
 *      `complete: true` with no orphans;
 *   5. a negative case removes the version contract and must surface the
 *      orphan resolved manifest;
 *   6. `verify-phase0b` (P0b-T12) still exits 0 after reconciliation, linking
 *      the Phase 1 chain back to the Phase 0b parameter registry gate.
 *
 * Sidecar files are mocked instead of launching a real coding-agent session;
 * their shapes mirror the T20 contract in reconciliation.ts.
 */

const CANDIDATE_TASK_IDS = [
	"task-alpha",
	"task-bravo",
	"task-charlie",
	"task-delta",
	"task-echo",
	"task-foxtrot",
	"task-golf",
	"task-hotel",
];

const SAMPLE_SIZE = 3;
const SAMPLE_SEED = 20260828;
const RESOLVED_AT = 1_700_000_000_000;

/** Deterministic seeded PRNG (mulberry32) so the sampled set is stable across runs. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher-Yates shuffle with the seeded PRNG; returns `count` sampled ids, sorted. */
function sampleTaskIds(pool: string[], count: number, seed: number): string[] {
	const rng = mulberry32(seed);
	const shuffled = [...pool];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = shuffled[i];
		shuffled[i] = shuffled[j];
		shuffled[j] = tmp;
	}
	return shuffled.slice(0, count).sort();
}

/** Writes the two session sidecar files a coding-agent run would produce for the gen0 slot. */
function simulateSession(sessionsDir: string, taskId: string, gen0: Gen0RebuildReport): string {
	const sessionDir = join(sessionsDir, taskId);
	mkdirSync(sessionDir, { recursive: true });

	writeFileSync(
		join(sessionDir, "version-contract.json"),
		JSON.stringify(
			{
				artifactId: gen0.artifact_id,
				scaffoldHash: gen0.scaffold_hash,
				snapshotSha: gen0.experience_snapshot_sha,
			},
			null,
			"\t",
		),
	);

	writeFileSync(
		join(sessionDir, `resolved-manifest-gen0-${RESOLVED_AT}.json`),
		JSON.stringify(
			{
				task_id: taskId,
				slot: "gen0",
				resolved_at: RESOLVED_AT,
				artifact_id: gen0.artifact_id,
				actual_provider_model: "faux/faux-model",
				env_snapshot: { cwd: "/tmp/workspace", node: "v25.9.0" },
			},
			null,
			"\t",
		),
	);

	return sessionDir;
}

/** Full-chain synthetic evidence: tool events, product manifest, grader outcomes, corrections, join keys. */
function evidenceInput(taskId: string, gen0: Gen0RebuildReport): EvidenceArtifactInput {
	return {
		taskId,
		versionContract: {
			artifactId: gen0.artifact_id,
			scaffoldHash: gen0.scaffold_hash,
			snapshotSha: gen0.experience_snapshot_sha,
		},
		toolEvents: [
			{
				toolName: "bash",
				argsHash: "1".repeat(64),
				resultHash: "2".repeat(64),
				durationMs: 42,
				timestamp: RESOLVED_AT + 1,
			},
			{
				toolName: "write",
				argsHash: "3".repeat(64),
				resultHash: "4".repeat(64),
				durationMs: 7,
				error: "none",
				timestamp: RESOLVED_AT + 2,
			},
		],
		productManifest: [
			{ path: "output/result.txt", sizeBytes: 128, sha256: "5".repeat(64), mtimeMs: RESOLVED_AT + 3 },
		],
		graderOutcomes: [
			{
				taskId,
				outcome: "success",
				graderSha: gen0.grader_sha,
				score: 1,
				notes: "all checks passed",
				timestamp: new Date(RESOLVED_AT + 4).toISOString(),
			},
		],
		userCorrections: [
			{
				taskId,
				correctionType: "explicit",
				content: "rename the output file",
				timestamp: new Date(RESOLVED_AT + 5).toISOString(),
			},
		],
		escalationJoinKeys: [{ gatewaySequence: 0, qualitySignalsSha: "6".repeat(64) }],
	};
}

describe("phase1 end-to-end integration (P1-T21)", () => {
	let dataDir: string;
	let sessionsDir: string;
	let registry: ArtifactRegistry;
	let gen0: Gen0RebuildReport;
	let previousCredentialsDir: string | undefined;
	let previousSocketPath: string | undefined;

	beforeAll(async () => {
		previousCredentialsDir = process.env.TEK_CREDENTIALS_DIR;
		previousSocketPath = process.env.TEK_SOCKET_PATH;
		delete process.env.TEK_CREDENTIALS_DIR;
		delete process.env.TEK_SOCKET_PATH;
		writeScaffoldFiles();

		dataDir = mkdtempSync(join(tmpdir(), "phase1-e2e-data-"));
		sessionsDir = mkdtempSync(join(tmpdir(), "phase1-e2e-sessions-"));

		// Step 1: gen0 baseline (task → request → model run → resolved manifest).
		const rebuild = await runCli(["gen0-rebuild", dataDir, "--slot", "gen0", "--task-id", "gen0-task"]);
		expect(rebuild.code).toBe(0);
		expect(rebuild.stderr).toBe("");
		gen0 = JSON.parse(rebuild.stdout) as Gen0RebuildReport;

		const evo = openEvolutionDb(join(dataDir, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(dataDir, "blobs"));
	}, 120_000);

	afterAll(() => {
		try {
			registry.close();
		} catch {
			/* ignore double-close */
		}
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(sessionsDir, { recursive: true, force: true });
		process.env.TEK_CREDENTIALS_DIR = previousCredentialsDir;
		process.env.TEK_SOCKET_PATH = previousSocketPath;
		restoreCwd();
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("reconciles random sampled tasks end-to-end with zero orphan records", () => {
		const sampled = sampleTaskIds(CANDIDATE_TASK_IDS, SAMPLE_SIZE, SAMPLE_SEED);
		expect(sampled).toHaveLength(SAMPLE_SIZE);
		expect(new Set(sampled).size).toBe(SAMPLE_SIZE);

		for (const taskId of sampled) {
			// Steps 2-3: simulated session sidecars + synthetic evidence artifact.
			const sessionDir = simulateSession(sessionsDir, taskId, gen0);
			const stored = storeEvidenceArtifact(registry, evidenceInput(taskId, gen0));

			// Step 4: reconciliation across session files + evolution.db.
			const report = reconcileTask(taskId, { sessionDir, registry });

			expect(report.taskId).toBe(taskId);
			expect(report.complete).toBe(true);
			expect(report.orphanRecords).toEqual([]);
			expect(report.evidenceArtifactIds).toEqual([stored.artifactId]);
			expect(report.versionContract?.artifactId).toBe(gen0.artifact_id);
			expect(report.versionContract?.scaffoldHash).toBe(gen0.scaffold_hash);
			expect(report.resolvedManifest?.artifactId).toBe(gen0.artifact_id);
			expect(report.resolvedManifest?.resolvedId).toMatch(/^[0-9a-f]{64}$/);
			expect(report.resolvedManifest?.actualProviderModel).toBe("faux/faux-model");
		}
	});

	it("detects an orphan record when the version contract is missing", () => {
		const taskId = "task-orphan-negative";
		const sessionDir = join(sessionsDir, taskId);
		mkdirSync(sessionDir, { recursive: true });

		// Only the resolved manifest is written; version-contract.json never appears.
		writeFileSync(
			join(sessionDir, `resolved-manifest-gen0-${RESOLVED_AT}.json`),
			JSON.stringify(
				{
					task_id: taskId,
					slot: "gen0",
					resolved_at: RESOLVED_AT,
					artifact_id: gen0.artifact_id,
					actual_provider_model: "faux/faux-model",
					env_snapshot: { cwd: "/tmp/workspace" },
				},
				null,
				"\t",
			),
		);
		storeEvidenceArtifact(registry, evidenceInput(taskId, gen0));

		const report = reconcileTask(taskId, { sessionDir, registry });

		expect(report.complete).toBe(false);
		expect(report.versionContract).toBeUndefined();
		expect(report.resolvedManifest).toBeDefined();
		expect(report.orphanRecords).toHaveLength(1);
		expect(report.orphanRecords[0]).toContain("orphan_resolved_manifest");
	});

	it("verify-phase0b exits 0 after reconciliation (Phase 0b link)", async () => {
		// Step 6: the Phase 0b parameter registry gate still passes against the
		// same dataDir the gen0 baseline and evidence artifacts live in.
		const result = await runCli(["verify-phase0b", dataDir]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const report = JSON.parse(result.stdout) as {
			ok: boolean;
			missing: string[];
			invalid: unknown[];
			expired: string[];
		};
		expect(report.ok).toBe(true);
		expect(report.missing).toEqual([]);
		expect(report.invalid).toEqual([]);
		expect(report.expired).toEqual([]);
	});
});
