import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { storeEvidenceArtifact } from "../../src/evolution/evidence-artifact-builder.ts";
import { reconcileAll, reconcileTask } from "../../src/evolution/reconciliation.ts";

const CONTRACT = {
	artifactId: "a".repeat(64),
	scaffoldHash: "b".repeat(64),
	snapshotSha: "c".repeat(40),
};

const RESOLVED = {
	task_id: "task-1",
	slot: "gen0",
	resolved_at: 1700000000000,
	artifact_id: CONTRACT.artifactId,
	actual_provider_model: "faux/faux-model",
	env_snapshot: { cwd: "/tmp/workspace" },
};

function writeVersionContract(sessionDir: string): void {
	writeFileSync(join(sessionDir, "version-contract.json"), JSON.stringify({ ...CONTRACT, recordedAt: 1 }, null, "\t"));
}

function writeResolvedManifest(sessionDir: string, overrides: Record<string, unknown> = {}): void {
	const payload = { ...RESOLVED, ...overrides };
	writeFileSync(
		join(sessionDir, `resolved-manifest-gen0-${RESOLVED.resolved_at}.json`),
		JSON.stringify(payload, null, "\t"),
	);
}

describe("evidence reconciliation (P1-T20)", () => {
	let base: string;
	let sessionDir: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-reconcile-"));
		sessionDir = join(base, "session-task-1");
		mkdirSync(sessionDir, { recursive: true });
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	function storeEvidence(taskId: string): string {
		const stored = storeEvidenceArtifact(registry, {
			taskId,
			versionContract: CONTRACT,
			toolEvents: [],
			productManifest: [],
			graderOutcomes: [],
			userCorrections: [],
			escalationJoinKeys: [],
		});
		return stored.artifactId;
	}

	it("reports complete reconciliation when contract, manifest and evidence all exist", () => {
		writeVersionContract(sessionDir);
		writeResolvedManifest(sessionDir);
		const evidenceId = storeEvidence("task-1");

		const report = reconcileTask("task-1", { sessionDir, registry });

		expect(report.complete).toBe(true);
		expect(report.orphanRecords).toEqual([]);
		expect(report.evidenceArtifactIds).toEqual([evidenceId]);
		expect(report.versionContract?.artifactId).toBe(CONTRACT.artifactId);
		expect(report.resolvedManifest?.artifactId).toBe(CONTRACT.artifactId);
		expect(report.resolvedManifest?.resolvedId).toMatch(/^[0-9a-f]{64}$/);
		expect(report.resolvedManifest?.actualProviderModel).toBe("faux/faux-model");
		expect(report.resolvedManifest?.envSnapshot).toEqual({ cwd: "/tmp/workspace" });
	});

	it("detects an orphan resolved manifest when the version contract is missing", () => {
		writeResolvedManifest(sessionDir);
		storeEvidence("task-1");

		const report = reconcileTask("task-1", { sessionDir, registry });

		expect(report.complete).toBe(false);
		expect(report.versionContract).toBeUndefined();
		expect(report.resolvedManifest).toBeDefined();
		expect(report.orphanRecords).toHaveLength(1);
		expect(report.orphanRecords[0]).toContain("orphan_resolved_manifest");
	});

	it("detects an orphan version contract when the resolved manifest is missing", () => {
		writeVersionContract(sessionDir);
		storeEvidence("task-1");

		const report = reconcileTask("task-1", { sessionDir, registry });

		expect(report.complete).toBe(false);
		expect(report.versionContract).toBeDefined();
		expect(report.resolvedManifest).toBeUndefined();
		expect(report.orphanRecords).toHaveLength(1);
		expect(report.orphanRecords[0]).toContain("orphan_version_contract");
	});

	it("detects artifact_id mismatch between version contract and resolved manifest", () => {
		writeVersionContract(sessionDir);
		writeResolvedManifest(sessionDir, { artifact_id: "d".repeat(64) });
		storeEvidence("task-1");

		const report = reconcileTask("task-1", { sessionDir, registry });

		expect(report.complete).toBe(false);
		expect(report.orphanRecords).toHaveLength(1);
		expect(report.orphanRecords[0]).toContain("artifact_id_mismatch");
		expect(report.orphanRecords[0]).toContain(CONTRACT.artifactId);
		expect(report.orphanRecords[0]).toContain("d".repeat(64));
	});

	it("is incomplete when no evidence artifact references the task", () => {
		writeVersionContract(sessionDir);
		writeResolvedManifest(sessionDir);
		storeEvidence("other-task");

		const report = reconcileTask("task-1", { sessionDir, registry });

		expect(report.complete).toBe(false);
		expect(report.evidenceArtifactIds).toEqual([]);
	});

	it("reconcileAll scans a sessions directory and returns one report per session", () => {
		const sessionsDir = join(base, "sessions");
		mkdirSync(sessionsDir);
		const s1 = join(sessionsDir, "task-a");
		const s2 = join(sessionsDir, "task-b");
		mkdirSync(s1);
		mkdirSync(s2);
		writeVersionContract(s1);
		writeResolvedManifest(s1, { task_id: "task-a" });
		storeEvidence("task-a");
		writeVersionContract(s2);

		const reports = reconcileAll({ sessionsDir, registry });

		expect(reports.map((r) => r.taskId)).toEqual(["task-a", "task-b"]);
		const complete = reports.find((r) => r.taskId === "task-a");
		const orphan = reports.find((r) => r.taskId === "task-b");
		expect(complete?.complete).toBe(true);
		expect(orphan?.complete).toBe(false);
		expect(orphan?.orphanRecords[0]).toContain("orphan_version_contract");
	});
});
