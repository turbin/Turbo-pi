import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VERSION_CONTRACT } from "../../../src/core/evolution/version-contract.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createHarness } from "../harness.ts";

const VALID_ARTIFACT_ID = "0".repeat(64);
const VALID_SCAFFOLD_HASH = "a".repeat(64);
const VALID_SNAPSHOT_SHA = "f".repeat(64);

describe("AgentSession version contract", () => {
	let originalArtifactId: string | undefined;
	let originalScaffoldHash: string | undefined;
	let originalSnapshotSha: string | undefined;

	beforeEach(() => {
		originalArtifactId = process.env.PI_GEN0_ARTIFACT_ID;
		originalScaffoldHash = process.env.PI_GEN0_SCAFFOLD_HASH;
		originalSnapshotSha = process.env.PI_GEN0_SNAPSHOT_SHA;
		delete process.env.PI_GEN0_ARTIFACT_ID;
		delete process.env.PI_GEN0_SCAFFOLD_HASH;
		delete process.env.PI_GEN0_SNAPSHOT_SHA;
	});

	afterEach(() => {
		if (originalArtifactId !== undefined) {
			process.env.PI_GEN0_ARTIFACT_ID = originalArtifactId;
		} else {
			delete process.env.PI_GEN0_ARTIFACT_ID;
		}
		if (originalScaffoldHash !== undefined) {
			process.env.PI_GEN0_SCAFFOLD_HASH = originalScaffoldHash;
		} else {
			delete process.env.PI_GEN0_SCAFFOLD_HASH;
		}
		if (originalSnapshotSha !== undefined) {
			process.env.PI_GEN0_SNAPSHOT_SHA = originalSnapshotSha;
		} else {
			delete process.env.PI_GEN0_SNAPSHOT_SHA;
		}
	});

	function readVersionContractFile(sessionDir: string): {
		artifactId: string;
		scaffoldHash: string;
		snapshotSha: string;
		recordedAt: number;
	} {
		return JSON.parse(readFileSync(join(sessionDir, "version-contract.json"), "utf8"));
	}

	it("persists version-contract.json in the session directory on session creation", async () => {
		const harness = await createHarness({ sessionDir: "sessions" });
		try {
			const sessionDir = harness.sessionManager.getSessionDir();
			const filePath = join(sessionDir, "version-contract.json");
			expect(existsSync(filePath)).toBe(true);

			const payload = readVersionContractFile(sessionDir);
			expect(payload.artifactId).toBe(DEFAULT_VERSION_CONTRACT.artifactId);
			expect(payload.scaffoldHash).toBe(DEFAULT_VERSION_CONTRACT.scaffoldHash);
			expect(payload.snapshotSha).toBe(DEFAULT_VERSION_CONTRACT.snapshotSha);
			expect(typeof payload.recordedAt).toBe("number");
		} finally {
			harness.cleanup();
		}
	});

	it("persists the env-provided contract to version-contract.json", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const harness = await createHarness({ sessionDir: "sessions" });
		try {
			const payload = readVersionContractFile(harness.sessionManager.getSessionDir());
			expect(payload.artifactId).toBe(VALID_ARTIFACT_ID);
			expect(payload.scaffoldHash).toBe(VALID_SCAFFOLD_HASH);
			expect(payload.snapshotSha).toBe(VALID_SNAPSHOT_SHA);
		} finally {
			harness.cleanup();
		}
	});

	it("does not write version-contract.json for in-memory sessions", async () => {
		const harness = await createHarness();
		try {
			expect(existsSync(join(harness.tempDir, "version-contract.json"))).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("sessionVersionContract() returns the same values as the persisted file", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const harness = await createHarness({ sessionDir: "sessions" });
		try {
			const contract = harness.session.sessionVersionContract();
			expect(contract).toEqual(harness.session.versionContract);
			const payload = readVersionContractFile(harness.sessionManager.getSessionDir());
			expect(payload.artifactId).toBe(contract.artifactId);
			expect(payload.scaffoldHash).toBe(contract.scaffoldHash);
			expect(payload.snapshotSha).toBe(contract.snapshotSha);
		} finally {
			harness.cleanup();
		}
	});

	it("updates version-contract.json on reload", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const harness = await createHarness({ sessionDir: "sessions" });
		try {
			const before = readVersionContractFile(harness.sessionManager.getSessionDir());

			const nowSpy = vi.spyOn(Date, "now").mockReturnValue(before.recordedAt + 1000);
			try {
				await harness.session.reload();
			} finally {
				nowSpy.mockRestore();
			}

			const after = readVersionContractFile(harness.sessionManager.getSessionDir());
			expect(after.recordedAt).toBe(before.recordedAt + 1000);
			expect(after.artifactId).toBe(VALID_ARTIFACT_ID);
			expect(after.scaffoldHash).toBe(VALID_SCAFFOLD_HASH);
			expect(after.snapshotSha).toBe(VALID_SNAPSHOT_SHA);
		} finally {
			harness.cleanup();
		}
	});

	it("uses the default contract when env vars are absent", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.versionContract).toEqual(DEFAULT_VERSION_CONTRACT);
		} finally {
			harness.cleanup();
		}
	});

	it("loads the contract from env vars when present", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const harness = await createHarness();
		try {
			expect(harness.session.versionContract).toEqual({
				artifactId: VALID_ARTIFACT_ID,
				scaffoldHash: VALID_SCAFFOLD_HASH,
				snapshotSha: VALID_SNAPSHOT_SHA,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("exposes the version contract on the extension context", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		let capturedCtx: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						capturedCtx = ctx;
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({});
			expect(capturedCtx).toBeDefined();
			expect(capturedCtx!.versionContract).toEqual({
				artifactId: VALID_ARTIFACT_ID,
				scaffoldHash: VALID_SCAFFOLD_HASH,
				snapshotSha: VALID_SNAPSHOT_SHA,
			});
		} finally {
			harness.cleanup();
		}
	});

	function findResolvedManifestFiles(sessionDir: string): string[] {
		if (!sessionDir) return [];
		return readdirSync(sessionDir).filter(
			(name) => name.startsWith("resolved-manifest-gen0-") && name.endsWith(".json"),
		);
	}

	it("writes the resolved manifest to the session directory on reload", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const harness = await createHarness({ sessionDir: "sessions" });

		try {
			await harness.session.reload();
			const files = findResolvedManifestFiles(harness.sessionManager.getSessionDir());
			expect(files).toHaveLength(1);

			const payload = JSON.parse(readFileSync(`${harness.sessionManager.getSessionDir()}/${files[0]}`, "utf8"));
			expect(payload.task_id).toBe(harness.session.sessionId);
			expect(payload.slot).toBe("gen0");
			expect(typeof payload.resolved_at).toBe("number");
			expect(payload.artifact_id).toBe(VALID_ARTIFACT_ID);
			expect(payload.actual_provider_model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
			expect(payload.env_snapshot).toEqual({ cwd: harness.tempDir });
		} finally {
			harness.cleanup();
		}
	});

	it("accepts the default contract artifact_id 'pending_0b'", async () => {
		const harness = await createHarness({ sessionDir: "sessions" });

		try {
			await harness.session.reload();
			const files = findResolvedManifestFiles(harness.sessionManager.getSessionDir());
			expect(files).toHaveLength(1);

			const payload = JSON.parse(readFileSync(`${harness.sessionManager.getSessionDir()}/${files[0]}`, "utf8"));
			expect(payload.artifact_id).toBe("pending_0b");
			expect(payload.task_id).toBe(harness.session.sessionId);
			expect(payload.slot).toBe("gen0");
			expect(typeof payload.resolved_at).toBe("number");
			expect(payload.actual_provider_model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
			expect(payload.env_snapshot).toEqual({ cwd: harness.tempDir });
		} finally {
			harness.cleanup();
		}
	});

	it("throws and skips writing when required fields are missing", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await createHarness({ sessionDir: "sessions" });

		try {
			(harness.session.agent.state as { model: unknown }).model = undefined;
			expect(() =>
				(harness.session as unknown as { _recordResolvedManifest: () => void })._recordResolvedManifest(),
			).toThrow("actual_provider_model");

			await harness.session.reload();
			expect(errorSpy).toHaveBeenCalled();
			const calls = errorSpy.mock.calls.filter((call) =>
				typeof call[0] === "string" ? call[0].includes("[resolved-manifest]") : false,
			);
			expect(calls).toHaveLength(1);
			expect(findResolvedManifestFiles(harness.sessionManager.getSessionDir())).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
			harness.cleanup();
		}
	});

	it("throws and skips writing when artifact_id is invalid", async () => {
		process.env.PI_GEN0_ARTIFACT_ID = "not-a-valid-artifact-id";
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await createHarness({ sessionDir: "sessions" });

		try {
			await harness.session.reload();
			expect(errorSpy).toHaveBeenCalled();
			const calls = errorSpy.mock.calls.filter((call) =>
				typeof call[0] === "string" ? call[0].includes("[resolved-manifest]") : false,
			);
			expect(calls).toHaveLength(1);
			expect(findResolvedManifestFiles(harness.sessionManager.getSessionDir())).toHaveLength(0);
		} finally {
			errorSpy.mockRestore();
			harness.cleanup();
		}
	});
});
