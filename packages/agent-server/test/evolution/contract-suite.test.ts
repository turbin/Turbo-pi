import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import type { ArtifactManifest } from "../../src/evolution/artifact-schema.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { canonicalJson, computeArtifactId, sha256Hex } from "../../src/evolution/canonical.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { PromotionController } from "../../src/evolution/promotion-controller.ts";
import {
	assertAgentLoopUnchanged,
	constructSeqGap,
	generateSecondAuditSigner,
	injectJournalState,
	loadM0Policy,
	replayCommittedJournal,
	scanForKernelImports,
} from "./contract-helpers.ts";

/**
 * M3-T8-2 through M3-T8-6: cross-implementation contract suite.
 *
 * This file lives under packages/agent-server/test/ and therefore does NOT
 * import any module from packages/evaluation-kernel/src/*. TEK is exercised by
 * spawning its main process and speaking raw NDJSON over its Unix socket.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEK_MAIN_PATH = fileURLToPath(new URL("../../../evaluation-kernel/src/main.ts", import.meta.url));
const TEK_PACKAGE_ROOT = fileURLToPath(new URL("../../../evaluation-kernel", import.meta.url));
const PROMOTION_CONTROLLER_PATH = fileURLToPath(
	new URL("../../src/evolution/promotion-controller.ts", import.meta.url),
);

const IPC_VERSION = 1;

interface TekErrorLike {
	code: string;
	message: string;
	field?: string;
}

interface TekHealth {
	status: string;
	ipcVersion: number;
	signerKeyId: string;
	chainMode: string;
}

interface TekBundleVerification {
	verified: boolean;
	checks: {
		blobs: boolean;
		manifestId: boolean;
		m0Denylist: boolean;
		signature: boolean;
	};
	failReason?: string;
}

interface TekVerificationResult {
	valid: boolean;
	reason?: string;
}

interface TekM0PolicySnapshot {
	policyVersion: string;
	denylistSha: string;
	immutablePaths: string[];
	chainMode: string;
}

interface SpawnedTek {
	child: ChildProcess;
	socketPath: string;
	token: string;
	credsDir: string;
	keyId: string;
}

function hashHex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

function makeManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
	return {
		kind: "composite",
		parent_ids: [],
		operator: "draft",
		scope: ["M0-clean-scope"],
		evidence_refs: ["doc/design/plans/2026-08-28-self-evolving-phase0a-architecture.md"],
		scaffold_hash: hashHex("scaffold-v1"),
		model_fingerprint: canonicalJson({ model: "faux", sampling: "canonical" }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: [hashHex("blob-1"), hashHex("blob-2")],
		...overrides,
	};
}

function encodeFrame(payload: unknown): string {
	return `${JSON.stringify(payload)}\n`;
}

function tekRequest(socketPath: string, token: string, method: string, params: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket: Socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new Error(`TEK request '${method}' timed out`));
		}, 10_000);

		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				encodeFrame({
					ipcVersion: IPC_VERSION,
					token,
					id: randomUUID(),
					method,
					params,
				}),
			);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.end();
			let response: unknown;
			try {
				response = JSON.parse(buffer.slice(0, newline));
			} catch {
				reject(new Error("malformed JSON response from TEK"));
				return;
			}
			const frame = response as Partial<{ ok: boolean; result: unknown; error: TekErrorLike }>;
			if (frame.ok === true && "result" in frame) {
				resolve(frame.result);
			} else if (frame.ok === false && frame.error !== undefined) {
				const err = new Error(`${frame.error.code}: ${frame.error.message}`);
				(err as Error & { code: string }).code = frame.error.code;
				(err as Error & { field?: string }).field = frame.error.field;
				reject(err);
			} else {
				reject(new Error("malformed response frame from TEK"));
			}
		});
		socket.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		socket.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error("TEK closed the connection without a response"));
		});
	});
}

function waitForReady(child: ChildProcess, socketPath: string, timeoutMs = 20_000): Promise<void> {
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

async function spawnTek(): Promise<SpawnedTek> {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-t8-"));
	const credsDir = join(dir, "tek-creds");
	const socketPath = join(dir, "tek.sock");
	const token = randomBytes(32).toString("hex");
	const child = spawn(process.execPath, ["--import", "tsx", TEK_MAIN_PATH], {
		cwd: TEK_PACKAGE_ROOT,
		env: { ...process.env, TEK_CREDENTIALS_DIR: credsDir, TEK_SOCKET_PATH: socketPath, TEK_AUTH_TOKEN: token },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForReady(child, socketPath);
	const health = (await tekRequest(socketPath, token, "health", {})) as TekHealth;
	return { child, socketPath, token, credsDir, keyId: health.signerKeyId };
}

async function closeTek(tek: SpawnedTek): Promise<void> {
	if (tek.child && tek.child.exitCode === null) {
		tek.child.kill("SIGTERM");
		await new Promise((resolve) => tek.child.once("exit", resolve));
	}
	rmSync(dirname(tek.socketPath), { recursive: true, force: true });
}

describe("M3-T8 cross-implementation contract suite", () => {
	let tek: SpawnedTek;

	beforeAll(async () => {
		tek = await spawnTek();
	});

	afterAll(async () => {
		await closeTek(tek);
	});

	describe("consistency", () => {
		it("agent-server computeArtifactId matches TEK verifyBundle manifestId check", async () => {
			const manifest = makeManifest();
			const artifactId = computeArtifactId(manifest);
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyBundle", {
				artifactId,
				blobShas: manifest.blob_hashes,
				manifest: canonicalJson(manifest),
			})) as TekBundleVerification;
			expect(result.checks.manifestId).toBe(true);
			expect(result.checks.blobs).toBe(true);
			expect(result.checks.m0Denylist).toBe(true);
			expect(result.checks.signature).toBe(false);
			expect(result.verified).toBe(false);
			expect(result.failReason).toBe("signature_invalid");
		});

		it("TEK strips a dummy bundle_signature and still computes the same artifact_id", async () => {
			const manifest = makeManifest();
			const artifactId = computeArtifactId(manifest);
			const signedManifest = {
				...manifest,
				bundle_signature: { signer_key_id: "dev-dummy", signature: "a".repeat(32) },
			};
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyBundle", {
				artifactId,
				blobShas: manifest.blob_hashes,
				manifest: canonicalJson(signedManifest),
			})) as TekBundleVerification;
			expect(result.checks.manifestId).toBe(true);
			expect(result.checks.blobs).toBe(true);
			expect(result.checks.m0Denylist).toBe(true);
			expect(result.checks.signature).toBe(false);
			expect(result.failReason).toBe("signature_invalid");
		});
	});

	describe("signature", () => {
		function buildAttestationPayload(signerKeyId: string): string {
			return canonicalJson({
				contractId: hashHex("contract-1"),
				artifactId: hashHex("artifact-1"),
				workspaceTreeSha: hashHex("workspace-tree-1"),
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
				signerKeyId,
				chainMode: "local_diagnostic",
			});
		}

		it("rejects an attestation forged with a second audit signer (unknown_key)", async () => {
			const second = generateSecondAuditSigner(tek.credsDir);
			const payload = buildAttestationPayload(second.keyId);
			const attestationId = sha256Hex(payload);
			const { signature } = second.writer.signString(payload);
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyAttestation", {
				attestationId,
				payload,
				signature,
				signerKeyId: second.keyId,
			})) as TekVerificationResult;
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("unknown_key");
		});

		it("rejects a tampered attestation payload (chain_break)", async () => {
			const contractId = hashHex("contract-1");
			const attestation = (await tekRequest(tek.socketPath, tek.token, "signAttestation", {
				contractId,
				artifactId: hashHex("artifact-1"),
				workspaceTreeSha: hashHex("workspace-tree-1"),
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
			})) as { attestationId: string; payload: string; signature: string; signerKeyId: string; chainMode: string };
			const tamperedPayload = attestation.payload.replace('"success":1', '"success":2');
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyAttestation", {
				attestationId: attestation.attestationId,
				payload: tamperedPayload,
				signature: attestation.signature,
				signerKeyId: attestation.signerKeyId,
			})) as TekVerificationResult;
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("chain_break");
		});

		it("rejects a mismatched signer key id (bad_signature)", async () => {
			const attestation = (await tekRequest(tek.socketPath, tek.token, "signAttestation", {
				contractId: hashHex("contract-2"),
				artifactId: hashHex("artifact-2"),
				workspaceTreeSha: hashHex("workspace-tree-2"),
				metrics: {
					success: 1,
					deliveryCompleteness: 1,
					disaster: 0,
					toolFailures: 0,
					realTokens: 10,
					costMicros: 5,
				},
				traceRef: "trace-wrong-key",
				failureClassification: "unknown",
				verdict: "pass",
			})) as { attestationId: string; payload: string; signature: string; signerKeyId: string };
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyAttestation", {
				attestationId: attestation.attestationId,
				payload: attestation.payload,
				signature: attestation.signature,
				signerKeyId: "dev-wrong-key-id",
			})) as TekVerificationResult;
			expect(result.valid).toBe(false);
			expect(result.reason).toBe("bad_signature");
		});

		it("TEK getM0Policy returns chain_mode local_diagnostic", async () => {
			const policy = (await tekRequest(tek.socketPath, tek.token, "getM0Policy", {})) as TekM0PolicySnapshot;
			expect(policy.chainMode).toBe("local_diagnostic");
		});
	});

	describe("chain", () => {
		let base: string;
		let controller: PromotionController;
		let artifactId: string;

		beforeEach(() => {
			base = mkdtempSync(join(tmpdir(), "evo-chain-"));
			const db = openEvolutionDb(join(base, "evolution.db"));
			const registry = openArtifactRegistry(db.db, join(base, "blobs"));
			const auditWriter = DevAuditWriter.loadOrCreate(join(base, "creds"));
			controller = new PromotionController(db.db, auditWriter);

			const blob = Buffer.from("chain-test-blob");
			const manifest: ArtifactManifest = {
				kind: "experience_snapshot",
				parent_ids: [],
				operator: "draft",
				scope: ["test"],
				evidence_refs: [],
				scaffold_hash: createHash("sha256").update("scaffold").digest("hex"),
				model_fingerprint: JSON.stringify({ model: "faux" }),
				data_class: "diagnostic_ops",
				retention_policy_ref: "pending_0b",
				blob_hashes: [createHash("sha256").update(blob).digest("hex")],
			};
			artifactId = registry.storeArtifact(manifest, [blob]);
		});

		afterEach(() => {
			controller.close();
			rmSync(base, { recursive: true, force: true });
		});

		function emit(slot: string, type: string, prevId: string | null, seq: number): string {
			return controller.emitDeploymentEvent({
				slot,
				eventType: type as import("../../src/evolution/schema.ts").EventType,
				artifactId,
				previousEventId: prevId,
				seq,
				operator: "test",
				reason: "test",
				occurredAt: Date.now(),
			});
		}

		it("detects a seq gap and resolves to an unknown fail-closed state", () => {
			const id1 = emit("slot-gap", "shadow", null, 1);
			emit("slot-gap", "canary_pending_approval", id1, 3);
			const state = controller.resolveSlotState("slot-gap");
			expect(state.gapDetected).toBe(true);
			expect(state.eventType).toBe("unknown");
			expect(state.eventId).toBeNull();
			expect(state.seq).toBeNull();
		});

		it("rejects a previous_event_id mismatch", () => {
			emit("slot-prev", "shadow", null, 1);
			expect(() => emit("slot-prev", "canary_pending_approval", "bogus-id", 2)).toThrow(
				/previous_event_id mismatch/,
			);
		});

		it("rejects a duplicate seq globally", () => {
			emit("slot-dup-a", "shadow", null, 1);
			expect(() => emit("slot-dup-b", "shadow", null, 1)).toThrow(/seq already exists/);
		});

		it("rejects a transition from __start__ directly to active", () => {
			expect(() => emit("slot-start", "active", null, 1)).toThrow(/invalid state transition/);
		});

		it("constructSeqGap repairs the chain of a gapped event list", () => {
			const events = [
				makeEvent("e1", 1, null),
				makeEvent("e2", 2, "e1"),
				makeEvent("e3", 3, "e2"),
				makeEvent("e4", 4, "e3"),
			];
			const gapped = constructSeqGap(events);
			expect(gapped.map((e) => e.seq)).toEqual([1, 3, 4]);
			expect(gapped[0].previousEventId).toBeNull();
			expect(gapped[1].previousEventId).toBe("e1");
			expect(gapped[2].previousEventId).toBe("e3");
		});
	});

	describe("crash", () => {
		let base: string;
		let db: ReturnType<typeof openEvolutionDb>;

		beforeEach(() => {
			base = mkdtempSync(join(tmpdir(), "evo-crash-"));
			db = openEvolutionDb(join(base, "evolution.db"));
		});

		afterEach(() => {
			db.close();
			rmSync(base, { recursive: true, force: true });
		});

		it("does not treat a written journal row as committed", () => {
			injectJournalState(db.db, {
				operation: "half-write",
				payloadHash: hashHex("payload"),
				state: "written",
				createdAt: 1_700_000_000_000,
			});
			const committed = replayCommittedJournal(db.db);
			expect(committed).toHaveLength(0);
		});

		it("treats a committed journal row as committed/idempotent", () => {
			injectJournalState(db.db, {
				operation: " durable-op",
				payloadHash: hashHex("payload"),
				state: "committed",
				createdAt: 1_700_000_000_001,
			});
			const committed = replayCommittedJournal(db.db);
			expect(committed).toHaveLength(1);
			expect(committed[0].operation).toBe(" durable-op");
			expect(committed[0].payload_hash).toBe(hashHex("payload"));
			expect(committed[0].state).toBe("committed");
		});
	});

	describe("permission", () => {
		it("promotion-controller.ts does not import from the evaluation-kernel", () => {
			expect(scanForKernelImports(PROMOTION_CONTROLLER_PATH)).toEqual([]);
		});

		it("agent-loop.ts has no uncommitted changes", () => {
			expect(() => assertAgentLoopUnchanged()).not.toThrow();
		});

		it("TEK rejects a manifest whose scope contains an M0 immutable path", async () => {
			const manifest = makeManifest({
				scope: ["packages/evaluation-kernel/src/ipc-server.ts"],
			});
			const artifactId = computeArtifactId(manifest);
			const result = (await tekRequest(tek.socketPath, tek.token, "verifyBundle", {
				artifactId,
				blobShas: manifest.blob_hashes,
				manifest: canonicalJson(manifest),
			})) as TekBundleVerification;
			expect(result.checks.m0Denylist).toBe(false);
			expect(result.verified).toBe(false);
			expect(result.failReason).toBe("denylist_hit");
		});

		it("loadM0Policy and TEK getM0Policy both carry chain_mode local_diagnostic", async () => {
			const localPolicy = loadM0Policy();
			expect(localPolicy.chainMode).toBe("local_diagnostic");
			const tekPolicy = (await tekRequest(tek.socketPath, tek.token, "getM0Policy", {})) as TekM0PolicySnapshot;
			expect(tekPolicy.chainMode).toBe("local_diagnostic");
		});
	});
});

function makeEvent(
	eventId: string,
	seq: number,
	previousEventId: string | null,
	overrides?: Partial<import("../../src/evolution/append-only-dao.ts").DeploymentEventInput>,
): import("../../src/evolution/append-only-dao.ts").DeploymentEventInput {
	return {
		eventId,
		seq,
		slot: "test-slot",
		eventType: "shadow",
		artifactId: `artifact-${seq}`,
		previousEventId,
		previousArtifactId: null,
		operator: "draft",
		reason: "test",
		keyId: "dev-audit-test",
		signature: "sig",
		occurredAt: 1_700_000_000_000 + seq,
		...overrides,
	};
}
