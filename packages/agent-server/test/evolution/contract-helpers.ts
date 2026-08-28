import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { DeploymentEventInput } from "../../src/evolution/append-only-dao.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";

/**
 * M3-T8-1: cross-implementation contract test helpers.
 *
 * All helpers are deterministic, self-contained, and never import from
 * `packages/evaluation-kernel/src/*`. Kernel policy values are hard-coded to
 * the M0 snapshot; file-system scanning is used for import assertions.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Re-export for callers that want the full type. */
export type { DeploymentEventInput };

/**
 * Load or create a second dev audit signer in a sub-directory of `credsDir`,
 * distinct from the main signer that lives directly in `credsDir`.
 */
export function generateSecondAuditSigner(credsDir: string): { writer: DevAuditWriter; keyId: string } {
	const secondDir = join(credsDir, "second-signer");
	const writer = DevAuditWriter.loadOrCreate(secondDir);
	return { writer, keyId: writer.keyId };
}

export interface InjectJournalStateOptions {
	operation: string;
	payloadHash: string;
	state: "written" | "committed";
	createdAt?: number;
}

/**
 * Directly insert an `evolution_journal` row. Used by crash-recovery tests to
 * manufacture half-written or committed journal states without exercising the
 * DAO's append path.
 */
export function injectJournalState(db: Database.Database, options: InjectJournalStateOptions): number {
	const createdAt = options.createdAt ?? Date.now();
	const result = db
		.prepare("INSERT INTO evolution_journal (operation, payload_hash, state, created_at) VALUES (?, ?, ?, ?)")
		.run(options.operation, options.payloadHash, options.state, createdAt);
	return Number(result.lastInsertRowid);
}

/**
 * Remove the event with `seq === 2` from an otherwise contiguous event list and
 * repair the `previous_event_id` chain so the remaining events still chain
 * correctly. Returns a new array; does not mutate the input.
 */
export function constructSeqGap(events: DeploymentEventInput[]): DeploymentEventInput[] {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const removedIndex = sorted.findIndex((e) => e.seq === 2);
	if (removedIndex === -1) {
		throw new Error("constructSeqGap: no event with seq=2 found");
	}

	const remaining: DeploymentEventInput[] = [];
	let previousEventId: string | null = null;
	for (const event of sorted) {
		if (event.seq === 2) {
			continue;
		}
		remaining.push({
			...event,
			previousEventId: previousEventId,
		});
		previousEventId = event.eventId;
	}
	return remaining;
}

const KERNEL_PACKAGE_RE = /['"]@earendil-works\/evaluation-kernel(?:\/[^'"]*)?['"]/;
const KERNEL_RELATIVE_RE = /['"](?:\.\.\/)*evaluation-kernel\/src\/[^'"]*['"]/;

/**
 * Read a TypeScript file and return any import lines that reference the
 * evaluation-kernel package or relative paths into `packages/evaluation-kernel/src/`.
 */
export function scanForKernelImports(filePath: string): string[] {
	const text = readFileSync(filePath, "utf8");
	const lines = text.split(/\r?\n/);
	const hits: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("import") && !trimmed.includes("import(")) {
			continue;
		}
		if (KERNEL_PACKAGE_RE.test(trimmed) || KERNEL_RELATIVE_RE.test(trimmed)) {
			hits.push(line);
		}
	}
	return hits;
}

/**
 * Fail if `packages/agent/src/agent-loop.ts` has uncommitted changes relative to
 * HEAD. Must be invoked from the repo root (the helper changes directory to the
 * repo root before running git).
 */
export function assertAgentLoopUnchanged(): void {
	const repoRoot = findRepoRoot();
	const result = spawnSync("git", ["diff", "HEAD", "--", "packages/agent/src/agent-loop.ts"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`assertAgentLoopUnchanged: git diff failed: ${result.stderr}`);
	}
	if ((result.stdout ?? "").trim().length > 0) {
		throw new Error("assertAgentLoopUnchanged: packages/agent/src/agent-loop.ts has uncommitted changes");
	}
}

function findRepoRoot(): string {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: resolve(__dirname, "../.."),
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`findRepoRoot: git rev-parse failed: ${result.stderr}`);
	}
	return (result.stdout ?? "").trim();
}

const M0_IMMUTABLE_PATHS: readonly string[] = [
	"packages/evaluation-kernel/",
	"manifests/",
	"graders/",
	"preflight/",
	"dlp/",
	"budget/",
	"packages/agent-server/src/evolution/promotion-controller.ts",
	"packages/agent-server/src/evolution/bundle-builder.ts",
	"packages/agent-server/src/evolution/artifact-registry.ts",
	"packages/agent/src/agent-loop.ts",
];

const M0_CHAIN_MODE = "local_diagnostic";

/**
 * Return the M0 immutable path list and chain mode. Currently hard-coded to
 * match `packages/evaluation-kernel/src/policy.ts`; later tasks may read it
 * dynamically.
 */
export function loadM0Policy(): { immutablePaths: string[]; chainMode: string } {
	return {
		immutablePaths: [...M0_IMMUTABLE_PATHS],
		chainMode: M0_CHAIN_MODE,
	};
}

/**
 * Read committed rows from `evolution_journal`. Crash-recovery replay must
 * treat only `state='committed'` rows as durable; `written` rows are ignored.
 */
export function replayCommittedJournal(db: Database.Database): Array<{
	journal_id: number;
	operation: string;
	payload_hash: string;
	state: string;
	created_at: number;
}> {
	return db
		.prepare(
			"SELECT journal_id, operation, payload_hash, state, created_at FROM evolution_journal WHERE state = ? ORDER BY journal_id",
		)
		.all("committed") as Array<{
		journal_id: number;
		operation: string;
		payload_hash: string;
		state: string;
		created_at: number;
	}>;
}
