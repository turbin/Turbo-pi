import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
 *   npx tsx src/offline/run-evolution.ts --resume var/offline/runs/<ts>  # resume interrupted run
 *
 * Every run scores trajectories through verification_selection; the scoring
 * artifacts land in var/offline/runs/<ts>/ (最小断点, 2026-08-14). `--resume
 * <run_dir>` reuses that run's artifacts: input-hash matching groups are
 * skipped, only unfinished scoring runs again.
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
	/** Root for per-run scoring-checkpoint dirs (var/offline/runs/<ts>). Injectable for tests. */
	runDirRoot: string;
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
		runDirRoot: "./var/offline/runs",
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

/** Options for cmdRun: resume an interrupted run from its scoring-checkpoint dir. */
export interface CmdRunOptions {
	/** Reuse this run dir's scoring artifacts (--resume); a fresh dir is created otherwise. */
	resumeDir?: string;
}

/** Run one evolution cycle; on failure write a failure checkpoint then rethrow. */
export async function cmdRun(deps: RunEvolutionDeps, options: CmdRunOptions = {}): Promise<string> {
	try {
		// Honor AGENT_SERVER_SESSION_DIR (same convention as server.ts) so the
		// container deployment, which mounts sessions at /data/sessions, ETLs the
		// mounted files instead of an empty ./var/sessions.
		const inputDir = process.env.AGENT_SERVER_SESSION_DIR;
		// 最小断点（2026-08-14）：每次运行一个 run 目录（var/offline/runs/<ts>）
		// 承载打分断点产物；--resume 复用给定目录（跳过哈希匹配的已完成打分）。
		const runDir =
			options.resumeDir ?? join(deps.runDirRoot, new Date(deps.now()).toISOString().replace(/[:.]/g, "-"));
		mkdirSync(runDir, { recursive: true });
		const ckptId = await deps.runDailyEvolutionFn(deps.store, {
			...(inputDir ? { inputDir } : {}),
			runDir,
		});
		deps.log(`evolution checkpoint: ${ckptId}`);
		deps.log(`scoring checkpoint dir: ${runDir}`);
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
export async function cmdLoop(deps: RunEvolutionDeps, options: CmdRunOptions = {}): Promise<never> {
	const intervalHours = Number(process.env.AGENT_SERVER_EVOLUTION_INTERVAL_HOURS) || DEFAULT_LOOP_INTERVAL_HOURS;
	const intervalMs = intervalHours * HOURLY_MS;
	deps.log(`[loop] interval=${intervalHours}h, starting first run`);
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await cmdRun(deps, options);
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

	// --resume <run_dir>: resume an interrupted run from its scoring-checkpoint dir.
	const resumeIdx = args.indexOf("--resume");
	const resumeDir = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
	if (resumeIdx >= 0 && (!resumeDir || resumeDir.startsWith("--"))) {
		deps.logError("usage: --resume <run_dir> (e.g. --resume var/offline/runs/2026-08-14T03-00-00-000Z)");
		process.exit(2);
	}

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
		cmdLoop(deps, resumeDir ? { resumeDir } : {}).catch((err) => {
			deps.logError(`[loop] fatal: ${String(err)}`);
			process.exit(2);
		});
	} else {
		cmdRun(deps, resumeDir ? { resumeDir } : {})
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	}
}
