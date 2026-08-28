import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { canonicalJson, computeArtifactId, sha256Hex } from "../src/canonical.ts";
import { TekClient } from "../src/ipc/client.ts";
import { IPC_VERSION, type PinTaskContractRequest, type SignAttestationRequest } from "../src/ipc/contract.ts";
import { buildContractPayload } from "../src/methods/pin-task-contract.ts";
import { buildAttestationPayload } from "../src/methods/sign-attestation.ts";
import { CHAIN_MODE, denylistSha, M0_POLICY_VERSION } from "../src/policy.ts";
import { DevSigner, SIGNER_KEY_FILE } from "../src/signer.ts";

const MAIN_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const SHA = (s: string): string => sha256Hex(s);

// main.ts 未导出该常量（导入会执行进程入口），测试内保持同一字面量
const AUTH_TOKEN_FILE = "auth.token";

// --- fixtures ---------------------------------------------------------------

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "composite",
		parent_ids: [],
		operator: "draft",
		scope: [],
		evidence_refs: ["doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md"],
		scaffold_hash: SHA("scaffold-v1"),
		model_fingerprint: canonicalJson({ model: "faux", sampling: "canonical" }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [SHA("blob-1"), SHA("blob-2")],
		...overrides,
	};
}

/** Attach a bundle signature (covers the canonical manifest) using the given signer. */
function signBundle(manifest: Record<string, unknown>, signer: DevSigner): Record<string, unknown> {
	const { signature } = signer.signString(canonicalJson(manifest));
	return { ...manifest, bundle_signature: { signer_key_id: signer.keyId, signature } };
}

function validContractRequest(): PinTaskContractRequest {
	return {
		taskManifestSha: SHA("task-manifest-v1"),
		graderSha: SHA("grader-v1"),
		preflightId: `preflight-${SHA("preflight-v1")}`,
		budget: { tokensCap: 1_000_000, costCapMicros: 10_000_000, wallTimeCapMs: 3_600_000 },
		denylistRef: `denylist-${SHA("denylist-v1")}`,
	};
}

function waitForReady(child: ChildProcess, socketPath: string, timeoutMs = 20000): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let settled = false;
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const timer = setInterval(() => {
			if (settled) return;
			if (existsSync(socketPath)) {
				settled = true;
				clearInterval(timer);
				resolve();
			} else if (Date.now() - startedAt > timeoutMs) {
				settled = true;
				clearInterval(timer);
				reject(new Error(`TEK process not ready; stdout: ${stdout}`));
			}
		}, 100);
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			reject(new Error(`TEK process exited early (code ${code}); stdout: ${stdout}`));
		});
	});
}

// --- process-level suite ----------------------------------------------------

describe("TEK process-level IPC (spawned kernel)", () => {
	let dir: string;
	let credsDir: string;
	let socketPath: string;
	let token: string;
	let child: ChildProcess;
	let signer: DevSigner;
	let client: TekClient;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "tek-test-"));
		credsDir = join(dir, "credentials");
		socketPath = join(dir, "tek.sock");
		token = "test-token-0123456789abcdef";
		child = spawn(process.execPath, ["--import", "tsx", MAIN_PATH], {
			cwd: PACKAGE_ROOT,
			env: { ...process.env, TEK_CREDENTIALS_DIR: credsDir, TEK_SOCKET_PATH: socketPath, TEK_AUTH_TOKEN: token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForReady(child, socketPath);
		signer = DevSigner.loadOrCreate(credsDir);
		client = new TekClient({ socketPath, token });
	});

	afterAll(async () => {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		}
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("health: ok status, ipcVersion match, dev- key id, local_diagnostic chain mode", async () => {
		const health = await client.health();
		expect(health.status).toBe("ok");
		expect(health.ipcVersion).toBe(IPC_VERSION);
		expect(health.signerKeyId.startsWith("dev-")).toBe(true);
		expect(health.chainMode).toBe("local_diagnostic");
	});

	test("unauthenticated call is rejected (unauthorized) and per-call auth keeps working", async () => {
		const badClient = new TekClient({ socketPath, token: "wrong-token" });
		await expect(badClient.health()).rejects.toMatchObject({ code: "unauthorized" });
		// per-call authentication: a subsequent call with the correct token still succeeds
		await expect(client.health()).resolves.toMatchObject({ status: "ok" });
	});

	test("unknown method is rejected (unknown_method)", async () => {
		await expect(client.request("runGrader", {})).rejects.toMatchObject({ code: "unknown_method" });
	});

	test("ipcVersion mismatch is rejected (ipc_version_mismatch)", async () => {
		const mismatchedClient = new TekClient({ socketPath, token, ipcVersion: 999 });
		await expect(mismatchedClient.health()).rejects.toMatchObject({ code: "ipc_version_mismatch" });
	});

	test("pinTaskContract rejects any missing required field with missing_field", async () => {
		const base = validContractRequest();
		const required = ["taskManifestSha", "graderSha", "preflightId", "budget", "denylistRef"] as const;
		for (const key of required) {
			const rest = { ...base };
			delete rest[key];
			await expect(client.pinTaskContract(rest)).rejects.toMatchObject({ code: "missing_field", field: key });
		}
		// budget subfields are required too
		const { budget: _budget, ...noBudget } = base;
		await expect(
			client.pinTaskContract({
				...noBudget,
				budget: { tokensCap: 1, costCapMicros: 1 },
			} as unknown as PinTaskContractRequest),
		).rejects.toMatchObject({ code: "missing_field", field: "budget.wallTimeCapMs" });
	});

	test("pinTaskContract rejects malformed sha/preflightId/denylistRef references (fail closed)", async () => {
		const base = validContractRequest();
		await expect(client.pinTaskContract({ ...base, taskManifestSha: "not-a-sha" })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(client.pinTaskContract({ ...base, preflightId: "preflight-zzz" })).rejects.toMatchObject({
			code: "invalid_request",
		});
		await expect(client.pinTaskContract({ ...base, denylistRef: "whatever" })).rejects.toMatchObject({
			code: "invalid_request",
		});
	});

	test("pinTaskContract signs a deterministic contract carrying preflightId/denylistRef (A10)", async () => {
		const req = validContractRequest();
		const contract = await client.pinTaskContract(req);
		expect(contract.chainMode).toBe("local_diagnostic");
		expect(contract.signerKeyId).toBe(signer.keyId);
		expect(contract.contractId).toBe(sha256Hex(contract.payload));
		// payload is canonical and rebuildable from the request
		expect(contract.payload).toBe(buildContractPayload(req, CHAIN_MODE, M0_POLICY_VERSION));
		const parsed = JSON.parse(contract.payload) as Record<string, unknown>;
		expect(parsed.taskManifestSha).toBe(req.taskManifestSha);
		expect(parsed.graderSha).toBe(req.graderSha);
		expect(parsed.preflightId).toBe(req.preflightId);
		expect(parsed.denylistRef).toBe(req.denylistRef);
		expect(parsed.budget).toEqual(req.budget);
		expect(parsed.chainMode).toBe("local_diagnostic");
		expect(signer.verifyString(contract.payload, contract.signature, contract.signerKeyId)).toBe(true);
	});

	test("verifyBundle: a signed, M0-clean bundle passes all four checks", async () => {
		const manifest = signBundle(makeManifest(), signer);
		const artifactId = computeArtifactId(manifest);
		const result = await client.verifyBundle({
			artifactId,
			blobShas: manifest.blob_hashes as string[],
			manifest: JSON.stringify(manifest),
		});
		expect(result.verified).toBe(true);
		expect(result.checks).toEqual({ blobs: true, manifestId: true, m0Denylist: true, signature: true });
	});

	test("verifyBundle: blob hash mismatch fails the blobs check (hash_mismatch)", async () => {
		const manifest = signBundle(makeManifest(), signer);
		const result = await client.verifyBundle({
			artifactId: computeArtifactId(manifest),
			blobShas: [SHA("tampered-blob"), SHA("blob-2")],
			manifest: JSON.stringify(manifest),
		});
		expect(result.verified).toBe(false);
		expect(result.checks.blobs).toBe(false);
		expect(result.failReason).toBe("hash_mismatch");
	});

	test("verifyBundle: wrong artifactId fails the manifestId check (id_mismatch)", async () => {
		const manifest = signBundle(makeManifest(), signer);
		const result = await client.verifyBundle({
			artifactId: SHA("wrong-artifact-id"),
			blobShas: manifest.blob_hashes as string[],
			manifest: JSON.stringify(manifest),
		});
		expect(result.verified).toBe(false);
		expect(result.checks.manifestId).toBe(false);
		expect(result.failReason).toBe("id_mismatch");
	});

	test("verifyBundle: M0 path in scope fails the m0Denylist check (denylist_hit)", async () => {
		const manifest = signBundle(makeManifest({ scope: ["packages/evaluation-kernel/src/ipc-server.ts"] }), signer);
		const result = await client.verifyBundle({
			artifactId: computeArtifactId(manifest),
			blobShas: manifest.blob_hashes as string[],
			manifest: JSON.stringify(manifest),
		});
		expect(result.verified).toBe(false);
		expect(result.checks.m0Denylist).toBe(false);
		expect(result.failReason).toBe("denylist_hit");
	});

	test("verifyBundle: invalid bundle signature fails the signature check (signature_invalid)", async () => {
		const manifest = signBundle(makeManifest(), signer);
		const original = (manifest.bundle_signature as { signature: string }).signature;
		const tampered = {
			...manifest,
			bundle_signature: {
				signer_key_id: signer.keyId,
				signature: `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`,
			},
		};
		const result = await client.verifyBundle({
			artifactId: computeArtifactId(manifest),
			blobShas: manifest.blob_hashes as string[],
			manifest: JSON.stringify(tampered),
		});
		expect(result.verified).toBe(false);
		expect(result.checks.signature).toBe(false);
		expect(result.failReason).toBe("signature_invalid");
	});

	test("signAttestation output verifies via verifyAttestation (A9)", async () => {
		const contract = await client.pinTaskContract(validContractRequest());
		const attestation = await client.signAttestation({
			contractId: contract.contractId,
			artifactId: SHA("artifact-1"),
			workspaceTreeSha: SHA("workspace-tree"),
			metrics: {
				success: 1,
				deliveryCompleteness: 1,
				disaster: 0,
				toolFailures: 0,
				realTokens: 1234,
				costMicros: 567,
			},
			traceRef: "trace-0001",
			failureClassification: "unknown",
			verdict: "pass",
		});
		expect(attestation.attestationId).toBe(sha256Hex(attestation.payload));
		expect(attestation.signerKeyId).toBe(signer.keyId);
		expect(attestation.chainMode).toBe("local_diagnostic");
		const result = await client.verifyAttestation({
			attestationId: attestation.attestationId,
			payload: attestation.payload,
			signature: attestation.signature,
			signerKeyId: attestation.signerKeyId,
		});
		expect(result).toEqual({ valid: true, reason: "ok" });
	});

	test("signAttestation: gen0 without baselineArtifactId is legal (NULL baseline)", async () => {
		const contract = await client.pinTaskContract(validContractRequest());
		const attestation = await client.signAttestation({
			contractId: contract.contractId,
			artifactId: SHA("artifact-gen0"),
			workspaceTreeSha: SHA("workspace-tree"),
			metrics: {
				success: 1,
				deliveryCompleteness: 1,
				disaster: 0,
				toolFailures: 0,
				realTokens: 100,
				costMicros: 50,
			},
			traceRef: "trace-gen0",
			failureClassification: "unknown",
			verdict: "pass",
		});
		expect(JSON.parse(attestation.payload)).not.toHaveProperty("baselineArtifactId");
		const result = await client.verifyAttestation({
			attestationId: attestation.attestationId,
			payload: attestation.payload,
			signature: attestation.signature,
			signerKeyId: attestation.signerKeyId,
		});
		expect(result.valid).toBe(true);
	});

	test("verifyAttestation rejects a signature made with a wrong key (unknown_key)", async () => {
		const contract = await client.pinTaskContract(validContractRequest());
		const req: SignAttestationRequest = {
			contractId: contract.contractId,
			artifactId: SHA("artifact-1"),
			workspaceTreeSha: SHA("workspace-tree"),
			metrics: { success: 1, deliveryCompleteness: 1, disaster: 0, toolFailures: 0, realTokens: 10, costMicros: 5 },
			traceRef: "trace-forged",
			failureClassification: "unknown",
			verdict: "pass",
		};
		const wrongKeyDir = join(dir, "credentials-wrong");
		const wrongSigner = DevSigner.loadOrCreate(wrongKeyDir);
		expect(wrongSigner.keyId.startsWith("dev-")).toBe(true);
		expect(wrongSigner.keyId).not.toBe(signer.keyId);
		const payload = buildAttestationPayload(req, wrongSigner.keyId, CHAIN_MODE);
		const { signature } = wrongSigner.signString(payload);
		const result = await client.verifyAttestation({
			attestationId: sha256Hex(payload),
			payload,
			signature,
			signerKeyId: wrongSigner.keyId,
		});
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("unknown_key");
	});

	test("verifyAttestation rejects a tampered payload (chain_break)", async () => {
		const contract = await client.pinTaskContract(validContractRequest());
		const attestation = await client.signAttestation({
			contractId: contract.contractId,
			artifactId: SHA("artifact-1"),
			workspaceTreeSha: SHA("workspace-tree"),
			metrics: {
				success: 1,
				deliveryCompleteness: 1,
				disaster: 0,
				toolFailures: 0,
				realTokens: 100,
				costMicros: 50,
			},
			traceRef: "trace-tampered",
			failureClassification: "unknown",
			verdict: "pass",
		});
		const tamperedPayload = attestation.payload.replace('"success":1', '"success":2');
		const result = await client.verifyAttestation({
			attestationId: attestation.attestationId,
			payload: tamperedPayload,
			signature: attestation.signature,
			signerKeyId: attestation.signerKeyId,
		});
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("chain_break");
		// unparseable payload is also rejected, not treated as success
		const garbage = await client.verifyAttestation({
			attestationId: attestation.attestationId,
			payload: "{not-json",
			signature: attestation.signature,
			signerKeyId: attestation.signerKeyId,
		});
		expect(garbage.valid).toBe(false);
	});

	test("verifyAttestation rejects a forged signature under the right key id (bad_signature)", async () => {
		const contract = await client.pinTaskContract(validContractRequest());
		const attestation = await client.signAttestation({
			contractId: contract.contractId,
			artifactId: SHA("artifact-1"),
			workspaceTreeSha: SHA("workspace-tree"),
			metrics: {
				success: 1,
				deliveryCompleteness: 1,
				disaster: 0,
				toolFailures: 0,
				realTokens: 100,
				costMicros: 50,
			},
			traceRef: "trace-forged",
			failureClassification: "unknown",
			verdict: "pass",
		});
		const result = await client.verifyAttestation({
			attestationId: attestation.attestationId,
			payload: attestation.payload,
			signature: Buffer.from("forged-signature").toString("base64"),
			signerKeyId: attestation.signerKeyId,
		});
		expect(result.valid).toBe(false);
		expect(result.reason).toBe("bad_signature");
	});

	test("getM0Policy returns denylistSha and immutablePaths", async () => {
		const policy = await client.getM0Policy();
		expect(policy.chainMode).toBe("local_diagnostic");
		expect(policy.policyVersion).toBe(M0_POLICY_VERSION);
		expect(policy.denylistSha).toMatch(/^[0-9a-f]{64}$/);
		expect(policy.denylistSha).toBe(denylistSha());
		expect(policy.immutablePaths.length).toBeGreaterThan(0);
		expect(policy.immutablePaths).toContain("packages/evaluation-kernel/");
	});

	test("A4 local degraded check: credentials dir 0700, key file 0600, socket 0600", () => {
		// 本地 macOS 无法真实切换 OS 身份；此处以权限位 + socket mode 0600 降级验证 A4 的可验证部分。
		// 真实 uid 隔离（pi-tek vs pi-evo/pi-run）由 CI Linux 容器覆盖，见 T8。
		console.log("[A4] local degraded check (uid isolation is CI/Linux-only)");
		expect(statSync(credsDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(credsDir, SIGNER_KEY_FILE)).mode & 0o777).toBe(0o600);
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
	});

	test("signed contract and attestation are deterministic (same request, same payload)", async () => {
		const req = validContractRequest();
		const first = await client.pinTaskContract(req);
		const second = await client.pinTaskContract(req);
		expect(second.payload).toBe(first.payload);
		expect(second.contractId).toBe(first.contractId);
		expect(second.signature).toBe(first.signature);
	});

	test("restart without TEK_AUTH_TOKEN: second launch reuses persisted auth.token (B3)", async () => {
		const restartCredsDir = join(dir, "restart-creds");
		const restartSocket = join(dir, "restart-tek.sock");
		const restartEnv: Record<string, string> = {
			...process.env,
			TEK_CREDENTIALS_DIR: restartCredsDir,
			TEK_SOCKET_PATH: restartSocket,
		};
		delete restartEnv.TEK_AUTH_TOKEN; // 本用例必须无注入 token
		const spawnKernel = (): ChildProcess =>
			spawn(process.execPath, ["--import", "tsx", MAIN_PATH], {
				cwd: PACKAGE_ROOT,
				env: restartEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});

		// 第一次启动：无注入 token，进程生成并持久化 auth.token（mode 0600）
		const first = spawnKernel();
		try {
			await waitForReady(first, restartSocket);
		} catch (err) {
			first.kill("SIGKILL");
			throw err;
		}
		const tokenPath = join(restartCredsDir, AUTH_TOKEN_FILE);
		expect(existsSync(tokenPath)).toBe(true);
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
		const persistedToken = readFileSync(tokenPath, "utf8");
		expect(persistedToken).toMatch(/^[0-9a-f]{64}$/);
		const firstClient = new TekClient({ socketPath: restartSocket, token: persistedToken });
		const firstHealth = await firstClient.health();
		expect(firstHealth.status).toBe("ok");
		expect(firstHealth.signerKeyId.startsWith("dev-")).toBe(true);

		// 关闭第一个实例（SIGTERM → 优雅停机，exit 0）
		first.kill("SIGTERM");
		await new Promise((resolve) => first.once("exit", resolve));
		expect(first.exitCode).toBe(0);

		// 第二次启动：同一凭据目录，仍无注入 token —— 复用同一 token，不得 EEXIST 崩溃
		const second = spawnKernel();
		try {
			await waitForReady(second, restartSocket);
		} catch (err) {
			second.kill("SIGKILL");
			throw err;
		}
		expect(readFileSync(tokenPath, "utf8")).toBe(persistedToken); // token 一致
		const secondClient = new TekClient({ socketPath: restartSocket, token: persistedToken });
		const secondHealth = await secondClient.health();
		expect(secondHealth.status).toBe("ok");
		expect(secondHealth.signerKeyId).toBe(firstHealth.signerKeyId); // 凭据目录整体复用

		second.kill("SIGTERM");
		await new Promise((resolve) => second.once("exit", resolve));
		expect(second.exitCode).toBe(0);
	});
});
