import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import {
	CANDIDATE_ABI_VERSION,
	type CandidateCapability,
	type CandidateExtensionManifest,
} from "../../src/evolution/candidate-abi/manifest.ts";
import {
	buildSourcePatchArtifact,
	type SourcePatchArtifactInput,
	storeSourcePatchArtifact,
} from "../../src/evolution/candidate-abi/source-patch-builder.ts";
import {
	applySourcePatch,
	CandidateIsolationError,
	type ExecResult,
	type ExecRunner,
	evaluateCandidate,
	LocalSubprocessRunner,
} from "../../src/evolution/candidate-isolation-runner.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";

function makeRunner(result: ExecResult): ExecRunner {
	return {
		async run() {
			return result;
		},
	};
}

function makePatchInput(overrides: Partial<SourcePatchArtifactInput> = {}): SourcePatchArtifactInput {
	const manifest: CandidateExtensionManifest = {
		abiVersion: CANDIDATE_ABI_VERSION,
		name: "test-candidate",
		description: "test candidate",
		generatedFrom: { taskId: "task-1", clusterId: "cluster-1", evidenceArtifactId: "ev-1" },
		capabilities: ["declarative/system-guideline"] as CandidateCapability[],
		declarations: { systemGuidelines: ["Always check cwd before reading files."] },
	};
	const diff = `--- /dev/null
+++ .pi/candidate-extensions/cluster-1/policy.json
@@ -0,0 +1 @@
+{"systemGuidelines":["Always check cwd before reading files."]}
`;
	return {
		candidateManifest: manifest,
		diff,
		parentIds: [],
		evidenceRefs: ["task:task-1", "cluster:cluster-1"],
		scaffoldHash: "a".repeat(64),
		modelFingerprint: JSON.stringify({ model: "test" }),
		...overrides,
	};
}

describe("applySourcePatch", () => {
	it("creates a new file inside the worktree", () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-"));
		try {
			const diff = `--- /dev/null
+++ .pi/candidate-extensions/cluster-1/policy.json
@@ -0,0 +1 @@
+{"systemGuidelines":["hello"]}
`;
			const result = applySourcePatch(worktree, diff, [".pi/candidate-extensions/"]);
			expect(result.appliedFiles).toEqual([".pi/candidate-extensions/cluster-1/policy.json"]);
			expect(readFileSync(join(worktree, ".pi/candidate-extensions/cluster-1/policy.json"), "utf8")).toBe(
				'{"systemGuidelines":["hello"]}',
			);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("rejects paths outside the whitelist", () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-"));
		try {
			const diff = `--- /dev/null
+++ packages/agent-server/src/evolution/schema.ts
@@ -0,0 +1 @@
+evil
`;
			expect(() => applySourcePatch(worktree, diff, [".pi/candidate-extensions/"])).toThrow(CandidateIsolationError);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("rejects modifications to existing files", () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-"));
		try {
			const diff = `--- a/.pi/candidate-extensions/foo.json
+++ b/.pi/candidate-extensions/foo.json
@@ -1 +1 @@
+bar
`;
			expect(() => applySourcePatch(worktree, diff, [".pi/candidate-extensions/"])).toThrow(CandidateIsolationError);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});
});

describe("evaluateCandidate", () => {
	let base: string;
	let registry: ArtifactRegistry;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "iso-eval-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	it("returns a passing report when validation succeeds", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-wt-"));
		const stored = storeSourcePatchArtifact(registry, makePatchInput());

		const report = await evaluateCandidate({
			sourcePatchArtifactId: stored.artifactId,
			registry,
			worktreeRoot: worktree,
			validationCommand: ["true"],
			execRunner: makeRunner({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }),
		});

		expect(report.passed).toBe(true);
		expect(report.appliedFiles).toHaveLength(1);
		expect(report.candidateManifest.name).toBe("test-candidate");
		expect(report.validationResult.exitCode).toBe(0);

		rmSync(worktree, { recursive: true, force: true });
	});

	it("returns a failing report when validation fails", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-wt-"));
		const stored = storeSourcePatchArtifact(registry, makePatchInput());

		const report = await evaluateCandidate({
			sourcePatchArtifactId: stored.artifactId,
			registry,
			worktreeRoot: worktree,
			validationCommand: ["false"],
			execRunner: makeRunner({ exitCode: 1, stdout: "", stderr: "nope", durationMs: 1 }),
		});

		expect(report.passed).toBe(false);
		expect(report.validationResult.stderr).toBe("nope");

		rmSync(worktree, { recursive: true, force: true });
	});

	it("throws when the artifact is not a source_patch", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "iso-wt-"));
		const built = buildSourcePatchArtifact(makePatchInput());
		const wrongManifest = { ...built.manifest, kind: "composite" as const };
		const wrongId = registry.storeArtifact(wrongManifest, built.blobs);

		await expect(
			evaluateCandidate({
				sourcePatchArtifactId: wrongId,
				registry,
				worktreeRoot: worktree,
				validationCommand: ["true"],
				execRunner: makeRunner({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
			}),
		).rejects.toThrow(CandidateIsolationError);

		rmSync(worktree, { recursive: true, force: true });
	});
});

describe("LocalSubprocessRunner", () => {
	it("captures stdout and exit code from a successful command", async () => {
		const runner = new LocalSubprocessRunner();
		const result = await runner.run(["node", "-e", "console.log('hello')"], { cwd: process.cwd() });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("captures stderr and non-zero exit code from a failing command", async () => {
		const runner = new LocalSubprocessRunner();
		const result = await runner.run(["node", "-e", "console.error('fail'); process.exit(2)"], { cwd: process.cwd() });
		expect(result.exitCode).toBe(2);
		expect(result.stderr.trim()).toBe("fail");
	});

	it("rejects an empty command", async () => {
		const runner = new LocalSubprocessRunner();
		await expect(runner.run([], { cwd: process.cwd() })).rejects.toThrow(CandidateIsolationError);
	});
});
