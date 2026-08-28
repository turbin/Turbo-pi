import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { AppendOnlyDao } from "./append-only-dao.ts";
import { openArtifactRegistry } from "./artifact-registry.ts";
import { DevAuditWriter } from "./audit-writer.ts";
import { buildGenerationZeroBundle } from "./bundle-builder.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { openEvolutionDb } from "./db.ts";
import { collectGenerationZeroFingerprints } from "./fingerprint.ts";
import {
	type EvolutionParameter,
	loadParameters,
	type ParameterId,
	REQUIRED_PARAMETER_IDS,
	validateParameter,
	validateRegistry,
} from "./parameters.ts";
import { PromotionController } from "./promotion-controller.ts";
import { ResolvedRecorder } from "./record-resolved.ts";
import { RuntimeResolver } from "./runtime-resolver.ts";

interface Budget {
	tokensCap: number;
	costCapMicros: number;
	wallTimeCapMs: number;
}

/**
 * Skeleton CLI for the T9 `gen0-rebuild` non-interactive command.
 *
 * Usage:
 *   npx tsx packages/agent-server/src/evolution/cli.ts gen0-rebuild <dataDir> [--slot <slot>] [--task-id <taskId>]
 *   npx tsx packages/agent-server/src/evolution/cli.ts verify-phase0b <dataDir>
 *
 * Defaults:
 *   --slot gen0
 *   --task-id gen0-task
 *
 * Sets up environment defaults under <dataDir>:
 *   TEK_CREDENTIALS_DIR → <dataDir>/tek/credentials
 *   TEK_SOCKET_PATH     → <dataDir>/tek/socket
 *
 * Exit codes:
 *   0 → success
 *   1 → contract/build failure
 *   2 → usage error
 *
 * Decision: T9 gen0 first-event emits `shadow` first, then `active` for the
 * gen0 slot. This skeleton does not touch `promotion-controller.ts`.
 */

export interface Gen0RebuildOptions {
	dataDir: string;
	slot: string;
	taskId: string;
}

export interface ReconciliationReport {
	artifact_id: string;
	scaffold_hash: string;
	experience_snapshot_sha: string;
	task_manifest_sha: string;
	grader_sha: string;
	budget: object;
	deployment_event_id: string;
	resolved_manifest_id: string;
	chain_mode: "local_diagnostic";
	drift_flag: boolean;
	coverage: object;
}

export class UsageError extends Error {
	readonly exitCode = 2;
}

export class ContractError extends Error {
	readonly exitCode = 1;
}

export function parseArgs(argv: string[]): { command: string; options: Gen0RebuildOptions } {
	if (argv.length === 0) {
		throw new UsageError("missing command");
	}

	const [command, dataDir, ...rest] = argv;
	if (command !== "gen0-rebuild" && command !== "verify-phase0b") {
		throw new UsageError(`unknown command: ${command}`);
	}
	if (!dataDir) {
		throw new UsageError("missing <dataDir>");
	}

	const options: Gen0RebuildOptions = {
		dataDir,
		slot: "gen0",
		taskId: "gen0-task",
	};

	if (command === "verify-phase0b") {
		if (rest.length > 0) {
			throw new UsageError(`verify-phase0b accepts no flags: ${rest[0]}`);
		}
		return { command, options };
	}

	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		const next = rest[i + 1];

		if (flag === "--slot") {
			if (!next || next.startsWith("--")) {
				throw new UsageError("--slot requires a value");
			}
			options.slot = next;
			i++;
		} else if (flag === "--task-id") {
			if (!next || next.startsWith("--")) {
				throw new UsageError("--task-id requires a value");
			}
			options.taskId = next;
			i++;
		} else {
			throw new UsageError(`unknown flag: ${flag}`);
		}
	}

	return { command, options };
}

const IPC_VERSION = 1;
const TEK_READY_TIMEOUT_MS = 20_000;
const TEK_REQUEST_TIMEOUT_MS = 10_000;

function ensureDir(path: string, mode?: number): void {
	mkdirSync(path, { recursive: true, mode });
}

function hashBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function computeTekMainPath(): string {
	const currentFile = fileURLToPath(import.meta.url);
	return join(dirname(currentFile), "..", "..", "..", "..", "packages", "evaluation-kernel", "src", "main.ts");
}

function computeTekPackageRoot(): string {
	return dirname(computeTekMainPath());
}

function waitForTekReady(child: ChildProcess, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let settled = false;
		let stdout = "";

		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		const timer = setInterval(() => {
			if (settled) return;
			if (existsSync(socketPath)) {
				settled = true;
				clearInterval(timer);
				resolve();
			} else if (Date.now() - startedAt > TEK_READY_TIMEOUT_MS) {
				settled = true;
				clearInterval(timer);
				reject(new ContractError(`TEK process not ready; stdout: ${stdout}; stderr: ${stderr}`));
			}
		}, 100);

		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			reject(new ContractError(`TEK process exited early (code ${code}); stdout: ${stdout}; stderr: ${stderr}`));
		});
	});
}

function stopTek(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
		child.kill("SIGTERM");
	});
}

interface TekResponseFrame {
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string; field?: string };
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
			reject(new ContractError(`TEK request '${method}' timed out`));
		}, TEK_REQUEST_TIMEOUT_MS);

		socket.setEncoding("utf8");
		socket.on("connect", () => {
			const frame = JSON.stringify({
				ipcVersion: IPC_VERSION,
				token,
				id: randomUUID(),
				method,
				params,
			});
			socket.write(`${frame}\n`);
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
				reject(new ContractError("malformed response from TEK"));
				return;
			}

			const frame = response as Partial<TekResponseFrame>;
			if (frame.ok === true && "result" in frame) {
				resolve(frame.result);
			} else if (frame.ok === false && frame.error !== undefined) {
				reject(new ContractError(`TEK ${frame.error.code}: ${frame.error.message}`));
			} else {
				reject(new ContractError("malformed response frame from TEK"));
			}
		});

		socket.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new ContractError(`TEK connection error: ${err.message}`));
		});

		socket.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new ContractError("TEK closed the connection without a response"));
		});
	});
}

function deterministicContractRequest(): {
	request: { taskManifestSha: string; graderSha: string; preflightId: string; denylistRef: string; budget: Budget };
	taskManifestSha: string;
	graderSha: string;
} {
	const taskManifestSha = sha256Hex("gen0-task-manifest");
	const graderSha = sha256Hex("gen0-grader");
	const preflightId = `preflight-${sha256Hex("gen0-preflight")}`;
	const denylistRef = `denylist-${sha256Hex("gen0-denylist")}`;
	const budget: Budget = {
		tokensCap: 1_000_000,
		costCapMicros: 10_000_000,
		wallTimeCapMs: 3_600_000,
	};
	return { request: { taskManifestSha, graderSha, preflightId, budget, denylistRef }, taskManifestSha, graderSha };
}

function deterministicAttestationRequest(contractId: string, artifactId: string) {
	return {
		contractId,
		artifactId,
		workspaceTreeSha: sha256Hex("gen0-workspace-tree"),
		metrics: {
			success: 1,
			deliveryCompleteness: 1,
			disaster: 0,
			toolFailures: 0,
			realTokens: 0,
			costMicros: 0,
		},
		traceRef: "gen0-rebuild-trace",
		failureClassification: "none",
		verdict: "pass" as const,
	};
}

export async function runGen0Rebuild(dataDir: string, options: Gen0RebuildOptions): Promise<ReconciliationReport> {
	ensureDir(dataDir);

	const collection = collectGenerationZeroFingerprints();
	const missingInputs = collection.coverage.uncovered.filter(
		(entry) => entry.startsWith("missing-scaffold:") || entry.startsWith("missing-config:"),
	);
	if (missingInputs.length > 0) {
		throw new ContractError(`missing required fingerprint inputs: ${missingInputs.join(", ")}`);
	}

	const dbPath = join(dataDir, "evolution.db");
	const blobsDir = join(dataDir, "blobs");
	const tekCredsDir = join(dataDir, "tek", "credentials");
	const auditCredsDir = join(dataDir, "audit", "credentials");
	const socketPath = join(dataDir, "tek", "socket");

	process.env.TEK_CREDENTIALS_DIR ??= tekCredsDir;
	process.env.TEK_SOCKET_PATH ??= socketPath;

	ensureDir(tekCredsDir, 0o700);
	ensureDir(auditCredsDir, 0o700);

	const token = randomBytes(32).toString("hex");
	const tekMain = computeTekMainPath();
	const child = spawn(process.execPath, ["--import", "tsx", tekMain], {
		cwd: computeTekPackageRoot(),
		env: {
			...process.env,
			TEK_CREDENTIALS_DIR: tekCredsDir,
			TEK_SOCKET_PATH: socketPath,
			TEK_AUTH_TOKEN: token,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let evo: ReturnType<typeof openEvolutionDb> | undefined;
	let registry: ReturnType<typeof openArtifactRegistry> | undefined;

	try {
		await waitForTekReady(child, socketPath);

		evo = openEvolutionDb(dbPath);
		const db = evo.db;
		registry = openArtifactRegistry(db, blobsDir);
		const auditWriter = DevAuditWriter.loadOrCreate(auditCredsDir);

		const contractRequest = deterministicContractRequest();
		const contract = (await tekRequest(socketPath, token, "pinTaskContract", contractRequest.request)) as {
			contractId: string;
			payload: string;
			signerKeyId: string;
			signature: string;
			chainMode: "local_diagnostic" | "worm_anchored";
		};

		const bundle = buildGenerationZeroBundle(registry, collection.fingerprints, contract.contractId);

		const contractPayload = JSON.parse(contract.payload) as Record<string, unknown>;
		const taskManifestSha = String(contractPayload.taskManifestSha ?? "");
		const graderSha = String(contractPayload.graderSha ?? "");

		let provider = "unknown";
		let model = "unknown";
		try {
			const parsed = JSON.parse(collection.fingerprints.model_fingerprint) as Record<string, unknown>;
			if (typeof parsed.provider === "string") provider = parsed.provider;
			if (typeof parsed.model === "string") model = parsed.model;
		} catch {
			/* keep defaults */
		}

		const existingAttestation = db
			.prepare("SELECT attestation_id FROM evaluation_attestations WHERE contract_id = ? AND artifact_id = ?")
			.get(contract.contractId, bundle.artifactId) as { attestation_id: string } | undefined;

		if (!existingAttestation) {
			const attestationReq = deterministicAttestationRequest(contract.contractId, bundle.artifactId);
			const signedAttestation = (await tekRequest(socketPath, token, "signAttestation", attestationReq)) as {
				attestationId: string;
				payload: string;
				signerKeyId: string;
				signature: string;
				chainMode: "local_diagnostic" | "worm_anchored";
			};

			const dao = new AppendOnlyDao(db);
			dao.appendAttestation({
				attestationId: signedAttestation.attestationId,
				artifactId: bundle.artifactId,
				contractId: contract.contractId,
				baselineArtifactId: null,
				taskManifestSha,
				graderSha,
				workspaceTreeSha: attestationReq.workspaceTreeSha,
				environmentFingerprint: collection.fingerprints.experience_snapshot_sha,
				providerModel: provider,
				samplingContract: collection.fingerprints.model_fingerprint,
				metricsHash: sha256Hex(canonicalJson(attestationReq.metrics)),
				verdict: attestationReq.verdict,
				realTokens: attestationReq.metrics.realTokens,
				costMicros: attestationReq.metrics.costMicros,
				traceRef: attestationReq.traceRef,
				failureClassification: attestationReq.failureClassification,
				signerKeyId: signedAttestation.signerKeyId,
				signature: signedAttestation.signature,
				attestedAt: Date.now(),
			});
		}

		const controller = new PromotionController(db, auditWriter);
		const slotState = controller.resolveSlotState(options.slot);
		let activeEventId: string;
		if (slotState.eventType === "active" && slotState.eventId) {
			activeEventId = slotState.eventId;
		} else {
			const occurredAt = 0; // deterministic anchor for gen0 rebuild event IDs
			const eventIds: string[] = [];
			const chain: Array<{
				eventType: "shadow" | "canary_pending_approval" | "canary" | "active_pending_approval" | "active";
				reason: string;
			}> = [
				{ eventType: "shadow", reason: "gen0 shadow deployment" },
				{ eventType: "canary_pending_approval", reason: "gen0 canary pending approval" },
				{ eventType: "canary", reason: "gen0 canary deployment" },
				{ eventType: "active_pending_approval", reason: "gen0 active pending approval" },
				{ eventType: "active", reason: "gen0 active deployment" },
			];

			for (let i = 0; i < chain.length; i++) {
				const step = chain[i];
				const previousEventId = i === 0 ? null : eventIds[i - 1];
				const previousArtifactId = i === 0 ? null : bundle.artifactId;
				eventIds.push(
					controller.emitDeploymentEvent({
						seq: i + 1,
						slot: options.slot,
						eventType: step.eventType,
						artifactId: bundle.artifactId,
						previousEventId,
						previousArtifactId,
						operator: "draft",
						reason: step.reason,
						occurredAt: occurredAt + i,
					}),
				);
			}
			activeEventId = eventIds[eventIds.length - 1];
		}

		const resolver = new RuntimeResolver(db, registry);
		const resolved = resolver.resolveSlot(options.slot);

		const recorder = new ResolvedRecorder(db);
		const resolvedId = recorder.recordResolvedManifest({
			taskId: options.taskId,
			slot: options.slot,
			artifactId: resolved.event.artifact_id,
			deploymentEventId: resolved.event.event_id,
			resolvedBlobShas: resolved.bundle.blobs.map(hashBuffer),
			resolvedScaffoldHash: resolved.bundle.manifest.scaffold_hash,
			actualProviderModel: provider,
			actualApiIdentifier: model,
			envSnapshotHash: collection.fingerprints.experience_snapshot_sha,
			driftFlag: "none",
			resolvedAt: Date.now(),
		});

		const reconciliation = recorder.reconcileSlot(options.taskId, options.slot);

		return {
			artifact_id: bundle.artifactId,
			scaffold_hash: collection.fingerprints.scaffold_hash,
			experience_snapshot_sha: collection.fingerprints.experience_snapshot_sha,
			task_manifest_sha: taskManifestSha,
			grader_sha: graderSha,
			budget: contractRequest.request.budget,
			deployment_event_id: activeEventId,
			resolved_manifest_id: resolvedId,
			chain_mode: "local_diagnostic",
			drift_flag: reconciliation.driftFlag !== "none",
			coverage: collection.coverage,
		};
	} finally {
		try {
			evo?.close();
		} catch {
			/* ignore double-close */
		}
		try {
			registry?.close();
		} catch {
			/* ignore double-close */
		}
		await stopTek(child);
	}
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * P0b-T12: `verify-phase0b <dataDir>` report. Validation never requires TEK
 * or network access; it only reads the local parameter registry.
 */
export interface Phase0bVerifyReport {
	ok: boolean;
	missing: string[];
	invalid: Array<{ id: string; errors: string[] }>;
	expired: string[];
}

interface ParameterRow {
	id: string;
	name: string;
	owner: string;
	value: string;
	rationale: string;
	version: string;
	expires_at: string;
	fail_closed_default: string;
	status: string;
}

/**
 * Load the parameter registry from `<dataDir>/evolution.db` when it contains
 * an `evolution_parameters` table; otherwise fall back to the built-in
 * P1–P10 defaults. The db is opened read-only and never migrated.
 */
function loadPhase0bParameters(dataDir: string): EvolutionParameter[] {
	const dbPath = join(dataDir, "evolution.db");
	if (!existsSync(dbPath)) {
		return loadParameters();
	}
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const table = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_parameters'")
			.get();
		if (!table) {
			return loadParameters();
		}
		const rows = db
			.prepare(
				"SELECT id, name, owner, value, rationale, version, expires_at, fail_closed_default, status FROM evolution_parameters",
			)
			.all() as ParameterRow[];
		return rows.map((row) => ({
			id: String(row.id ?? "") as ParameterId,
			name: String(row.name ?? ""),
			owner: String(row.owner ?? ""),
			value: String(row.value ?? ""),
			rationale: String(row.rationale ?? ""),
			version: String(row.version ?? ""),
			expiresAt: String(row.expires_at ?? ""),
			failClosedDefault: String(row.fail_closed_default ?? ""),
			status: String(row.status ?? "") as EvolutionParameter["status"],
		}));
	} finally {
		db.close();
	}
}

/** Run Phase 0b registry validation and return the machine-readable report. */
export function runVerifyPhase0b(dataDir: string, now: Date = new Date()): Phase0bVerifyReport {
	const params = loadPhase0bParameters(dataDir);
	const nowMs = now.getTime();

	const missing: string[] = [];
	for (const id of REQUIRED_PARAMETER_IDS) {
		if (!params.some((p) => p.id === id)) {
			missing.push(id);
		}
	}

	const invalid: Array<{ id: string; errors: string[] }> = [];
	const expired: string[] = [];
	const seen = new Set<string>();
	for (const param of params) {
		const errors: string[] = [];
		if (seen.has(param.id)) {
			errors.push(`duplicate parameter id ${param.id}`);
		}
		seen.add(param.id);
		const result = validateParameter(param);
		if (!result.ok) {
			errors.push(...result.errors);
		}
		if (errors.length > 0) {
			invalid.push({ id: param.id, errors });
		}
		const expiresAt = Date.parse(param.expiresAt);
		if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) {
			expired.push(param.id);
		}
	}

	// `validateRegistry` stays the single source of truth for the verdict.
	const verdict = validateRegistry(params, { now });
	return { ok: verdict.ok, missing, invalid, expired };
}

export async function runCli(argv: string[]): Promise<CliResult> {
	try {
		const { command, options } = parseArgs(argv);

		if (command === "verify-phase0b") {
			const report = runVerifyPhase0b(options.dataDir);
			const stdout = JSON.stringify(report, null, 2);
			console.log(stdout);
			return { code: report.ok ? 0 : 1, stdout, stderr: "" };
		}

		const report = await runGen0Rebuild(options.dataDir, options);
		const stdout = JSON.stringify(report, null, 2);
		console.log(stdout);
		return { code: 0, stdout, stderr: "" };
	} catch (err) {
		const code = err instanceof UsageError ? 2 : 1;
		const message = err instanceof Error ? err.message : String(err);
		const stderr = JSON.stringify({ error: message, code }, null, 2);
		console.error(stderr);
		return { code, stdout: "", stderr };
	}
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	runCli(process.argv.slice(2)).then((result) => process.exit(result.code));
}
