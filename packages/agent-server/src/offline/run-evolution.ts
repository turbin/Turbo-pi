import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ExperienceStore } from "../experience-store.ts";
import { writeCheckpoint } from "./checkpoint.ts";
import { runDailyEvolution } from "./scheduler.ts";

/**
 * CLI entry point for the offline evolution pipeline.
 *
 * Usage (from packages/agent-server):
 *   npx tsx src/offline/run-evolution.ts              # one-shot evolution run
 *   npx tsx src/offline/run-evolution.ts --status     # show last checkpoint
 *   npx tsx src/offline/run-evolution.ts --loop       # sidecar loop mode
 *
 * Config via env:
 *   EXPERIENCE_STORE_PATH    → experience.db path (default ./var/experience.db)
 *   AGENT_SERVER_BENCHMARK   → benchmark JSON path for pipeline
 *   AGENT_SERVER_EVOLUTION_INTERVAL_HOURS → loop sleep (default 24)
 *
 * Exit codes:
 *   0   → run succeeded and checkpoint written
 *   1   → run failed (failure checkpoint written before exit)
 *   2   → usage error (missing args, bad flags)
 *
 * Triggering is external (cron / manual) — this CLI is intentionally not wired
 * into server startup (SPEC §4.2 / P1 decision).
 */
const HOURLY_MS = 3_600_000;
const DEFAULT_LOOP_INTERVAL_HOURS = 24;

// ---------------------------------------------------------------------------
// Injected deps (overridable for tests)
// ---------------------------------------------------------------------------

export interface RunEvolutionDeps {
	store: ExperienceStore;
	runDailyEvolutionFn: typeof runDailyEvolution;
	writeCheckpointFn: typeof writeCheckpoint;
	sleepFn: (ms: number) => Promise<void>;
	now: () => number;
	log: (msg: string) => void;
	logError: (msg: string) => void;
}

function defaultDeps(): RunEvolutionDeps {
	const storePath = process.env.EXPERIENCE_STORE_PATH ?? "./var/experience.db";
	mkdirSync(dirname(storePath), { recursive: true });
	const store = new ExperienceStore(storePath);
	void store.initSchema();
	return {
		store,
		runDailyEvolutionFn: runDailyEvolution,
		writeCheckpointFn: writeCheckpoint,
		sleepFn: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: Date.now,
		log: console.log,
		logError: console.error,
	};
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

export interface StatusOutput {
	status: "found" | "never_run";
	checkpoint?: {
		id: string;
		epoch: string;
		metric: number;
		snapshot: unknown;
	};
}

/** Read the latest evolution checkpoint and format it for CLI display. */
export async function cmdStatus(deps: RunEvolutionDeps): Promise<StatusOutput> {
	const latest = await deps.store.getLatestCheckpoint("evolution");
	if (!latest) {
		return { status: "never_run" };
	}
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(latest.snapshot);
	} catch {
		snapshot = latest.snapshot;
	}
	return {
		status: "found",
		checkpoint: {
			id: latest.id,
			epoch: new Date(latest.epoch).toISOString(),
			metric: latest.metric,
			snapshot,
		},
	};
}

/** Run one evolution cycle; on failure write a failure checkpoint then rethrow. */
export async function cmdRun(deps: RunEvolutionDeps): Promise<string> {
	try {
		// Honor AGENT_SERVER_SESSION_DIR (same convention as server.ts) so the
		// container deployment, which mounts sessions at /data/sessions, ETLs the
		// mounted files instead of an empty ./var/sessions.
		const inputDir = process.env.AGENT_SERVER_SESSION_DIR;
		const ckptId = await deps.runDailyEvolutionFn(deps.store, inputDir ? { inputDir } : {});
		deps.log(`evolution checkpoint: ${ckptId}`);
		return ckptId;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		deps.logError(`evolution failed: ${message}`);
		// Write failure checkpoint so "never run" and "ran but failed" are
		// distinguishable via /api/evolution/status or --status.
		const failCkptId = await deps.writeCheckpointFn(deps.store, {
			kind: "evolution",
			epoch: deps.now(),
			metric: 0,
			snapshot: JSON.stringify({ error: message }),
		});
		deps.log(`failure checkpoint: ${failCkptId}`);
		throw err;
	}
}

/** Loop mode: run → sleep → repeat. A single failure does not exit the loop. */
export async function cmdLoop(deps: RunEvolutionDeps): Promise<never> {
	const intervalHours = Number(process.env.AGENT_SERVER_EVOLUTION_INTERVAL_HOURS) || DEFAULT_LOOP_INTERVAL_HOURS;
	const intervalMs = intervalHours * HOURLY_MS;
	deps.log(`[loop] interval=${intervalHours}h, starting first run`);
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await cmdRun(deps);
		} catch {
			// Already logged + checkpointed by cmdRun; continue the loop.
		}
		deps.log(`[loop] sleeping ${intervalHours}h until next run`);
		await deps.sleepFn(intervalMs);
	}
}

// ---------------------------------------------------------------------------
// CLI dispatch (process.argv parsing, following src/offline/benchmark.ts)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const args = process.argv.slice(2);
	const deps = defaultDeps();

	if (args.includes("--status")) {
		cmdStatus(deps)
			.then((out) => {
				if (out.status === "never_run") {
					deps.log("no evolution checkpoint found — never run");
				} else {
					deps.log(JSON.stringify(out.checkpoint, null, 2));
				}
				process.exit(0);
			})
			.catch((err) => {
				deps.logError(String(err));
				process.exit(2);
			});
	} else if (args.includes("--loop")) {
		cmdLoop(deps).catch((err) => {
			deps.logError(`[loop] fatal: ${String(err)}`);
			process.exit(2);
		});
	} else {
		cmdRun(deps)
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	}
}
