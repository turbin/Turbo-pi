// biome-ignore assist/source/organizeImports: scaffold-root.ts must load before cli.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearScaffoldFiles, restoreCwd, rootDir, writeScaffoldFiles } from "./scaffold-root.ts";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { parseArgs, type ReconciliationReport, runCli, runGen0Rebuild } from "../../src/evolution/cli.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { RuntimeResolver } from "../../src/evolution/runtime-resolver.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "gen0-rebuild-"));
}

describe("gen0-rebuild CLI", () => {
	let dataDir: string;
	let previousCredentialsDir: string | undefined;
	let previousSocketPath: string | undefined;

	beforeEach(() => {
		dataDir = tempDir();
		previousCredentialsDir = process.env.TEK_CREDENTIALS_DIR;
		previousSocketPath = process.env.TEK_SOCKET_PATH;
		delete process.env.TEK_CREDENTIALS_DIR;
		delete process.env.TEK_SOCKET_PATH;
		writeScaffoldFiles();
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
		process.env.TEK_CREDENTIALS_DIR = previousCredentialsDir;
		process.env.TEK_SOCKET_PATH = previousSocketPath;
		writeScaffoldFiles();
		vi.unstubAllGlobals();
	});

	afterAll(() => {
		restoreCwd();
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("parses defaults", () => {
		const result = parseArgs(["gen0-rebuild", dataDir]);
		expect(result.command).toBe("gen0-rebuild");
		expect(result.options.dataDir).toBe(dataDir);
		expect(result.options.slot).toBe("gen0");
		expect(result.options.taskId).toBe("gen0-task");
	});

	it("parses explicit slot and task id", () => {
		const result = parseArgs(["gen0-rebuild", dataDir, "--slot", "active", "--task-id", "t9-task"]);
		expect(result.options.slot).toBe("active");
		expect(result.options.taskId).toBe("t9-task");
	});

	it("returns a full reconciliation report with all required fields", async () => {
		const report = await runGen0Rebuild(dataDir, { dataDir, slot: "gen0", taskId: "gen0-task" });
		assertReportShape(report);
		expect(report.drift_flag).toBe(false);
		expect(report.chain_mode).toBe("local_diagnostic");
	});

	it("runs successfully with valid args and prints JSON to stdout", async () => {
		const result = await runCli(["gen0-rebuild", dataDir, "--slot", "gen0", "--task-id", "t9"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");

		const report = JSON.parse(result.stdout) as ReconciliationReport;
		assertReportShape(report);
		expect(report.chain_mode).toBe("local_diagnostic");
	});

	it("creates dataDir if it does not exist", async () => {
		const missing = join(dataDir, "fresh");
		const result = await runCli(["gen0-rebuild", missing]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("sets default TEK environment variables under dataDir", async () => {
		await runCli(["gen0-rebuild", dataDir]);
		expect(process.env.TEK_CREDENTIALS_DIR).toBe(join(dataDir, "tek", "credentials"));
		expect(process.env.TEK_SOCKET_PATH).toBe(join(dataDir, "tek", "socket"));
	});

	it("exits with code 2 when dataDir argument is missing", async () => {
		const result = await runCli(["gen0-rebuild"]);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toMatchObject({ error: expect.stringContaining("<dataDir>"), code: 2 });
	});

	it("exits with code 1 and flags specific missing fingerprint inputs", async () => {
		clearScaffoldFiles();
		const result = await runCli(["gen0-rebuild", dataDir]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		const parsed = JSON.parse(result.stderr) as { error: string; code: number };
		expect(parsed.code).toBe(1);
		expect(parsed.error).toContain("missing required fingerprint inputs");
		expect(parsed.error).toMatch(/missing-scaffold:/);
	});

	it("reports every required field as a non-empty value", async () => {
		const result = await runCli(["gen0-rebuild", dataDir]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout) as ReconciliationReport;
		assertReportShape(report);
		expect(report.artifact_id).toMatch(/^[0-9a-f]{64}$/);
		expect(report.deployment_event_id).toMatch(/^[0-9a-f]{64}$/);
		expect(report.resolved_manifest_id).toMatch(/^[0-9a-f]{64}$/);
		expect(report.scaffold_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(report.experience_snapshot_sha).toMatch(/^[0-9a-f]{64}$/);
		expect(report.task_manifest_sha).toMatch(/^[0-9a-f]{64}$/);
		expect(report.grader_sha).toMatch(/^[0-9a-f]{64}$/);
		expect(report.budget).toMatchObject({
			tokensCap: expect.any(Number),
			costCapMicros: expect.any(Number),
			wallTimeCapMs: expect.any(Number),
		});
	});

	it("is deterministic for the same dataDir: artifact_id and deployment_event_id are stable across runs", async () => {
		const first = await runCli(["gen0-rebuild", dataDir, "--slot", "gen0", "--task-id", "gen0-task"]);
		expect(first.code).toBe(0);
		const report1 = JSON.parse(first.stdout) as ReconciliationReport;

		const second = await runCli(["gen0-rebuild", dataDir, "--slot", "gen0", "--task-id", "gen0-task"]);
		expect(second.code).toBe(0);
		const report2 = JSON.parse(second.stdout) as ReconciliationReport;

		expect(report2.artifact_id).toBe(report1.artifact_id);
		expect(report2.deployment_event_id).toBe(report1.deployment_event_id);
		expect(report2.chain_mode).toBe("local_diagnostic");
	});

	it("uses deterministic deployment event ids across fresh dataDirs", async () => {
		// Deployment events are anchored at occurred_at=0 so the event id chain
		// is stable as long as the inputs (slot, task, fingerprints, contract) are.
		const dir1 = tempDir();
		const dir2 = tempDir();
		try {
			const first = await runCli(["gen0-rebuild", dir1, "--slot", "gen0", "--task-id", "gen0-task"]);
			expect(first.code).toBe(0);
			const report1 = JSON.parse(first.stdout) as ReconciliationReport;

			const second = await runCli(["gen0-rebuild", dir2, "--slot", "gen0", "--task-id", "gen0-task"]);
			expect(second.code).toBe(0);
			const report2 = JSON.parse(second.stdout) as ReconciliationReport;

			expect(report2.artifact_id).toBe(report1.artifact_id);
			expect(report2.deployment_event_id).toBe(report1.deployment_event_id);
			expect(report2.chain_mode).toBe("local_diagnostic");
		} finally {
			rmSync(dir1, { recursive: true, force: true });
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("does not make any HTTP requests", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetchSpy);

		const result = await runCli(["gen0-rebuild", dataDir]);
		expect(result.code).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("produces a bundle that RuntimeResolver can load from the same dataDir", async () => {
		const result = await runCli(["gen0-rebuild", dataDir, "--slot", "gen0", "--task-id", "gen0-task"]);
		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout) as ReconciliationReport;

		const evo = openEvolutionDb(join(dataDir, "evolution.db"));
		const registry = openArtifactRegistry(evo.db, join(dataDir, "blobs"));
		const resolver = new RuntimeResolver(evo.db, registry);
		try {
			const resolved = resolver.resolveSlot("gen0");
			expect(resolved.event.artifact_id).toBe(report.artifact_id);
			expect(resolved.bundle.manifest.scaffold_hash).toBe(report.scaffold_hash);
			expect(resolved.bundle.blobs.length).toBeGreaterThan(0);
		} finally {
			resolver.close();
			registry.close();
			evo.close();
		}
	});
});

function assertReportShape(report: ReconciliationReport): void {
	expect(typeof report.artifact_id).toBe("string");
	expect(typeof report.scaffold_hash).toBe("string");
	expect(typeof report.experience_snapshot_sha).toBe("string");
	expect(typeof report.task_manifest_sha).toBe("string");
	expect(typeof report.grader_sha).toBe("string");
	expect(typeof report.budget).toBe("object");
	expect(typeof report.deployment_event_id).toBe("string");
	expect(typeof report.resolved_manifest_id).toBe("string");
	expect(report.chain_mode).toBe("local_diagnostic");
	expect(typeof report.drift_flag).toBe("boolean");
	expect(typeof report.coverage).toBe("object");
}
