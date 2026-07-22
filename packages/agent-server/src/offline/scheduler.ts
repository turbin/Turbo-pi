import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExperienceStore } from "../experience-store.ts";
import { writeCheckpoint } from "./checkpoint.ts";
import { etlSessionFiles } from "./etl.ts";
import { type OfflinePipelineOptions, runOfflinePipeline } from "./pipeline.ts";
import { promoteStagedOutputs } from "./verifier.ts";

/**
 * Offline scheduler (SPEC §4.2 / §5.2): one full daily evolution run.
 *
 *   1. ETL session JSONL files -> dormant EVIDENCE candidates
 *   2. runOfflinePipeline      -> staged skills/sops/cards in outputDir
 *   3. promoteStagedOutputs    -> verified entries become active
 *   4. writeCheckpoint         -> "evolution" checkpoint (only on success)
 *
 * Triggering is external (cron or manual, SPEC §4.2: 每日一次或手动触发); this
 * module is intentionally not wired into server startup. On failure the error
 * propagates and no checkpoint is written, so the previous checkpoint still
 * describes the active set (SPEC §9).
 *
 * Dirs and stage functions are injectable for tests, following the
 * options-injection pattern of pipeline.ts.
 */

export interface DailyEvolutionOptions {
	/** Directory with pi session JSONL files. Default: ./var/sessions (cwd-relative). */
	inputDir?: string;
	/** Directory for staged pipeline outputs. Default: ./var/evolution (cwd-relative). */
	outputDir?: string;
	/**
	 * Training task set for the skill evolution stage (SPEC §4.2 step 2), a
	 * benchmark JSON as documented in benchmark/benchmark.example.json.
	 * Default: env AGENT_SERVER_BENCHMARK; omitted => the skill stage outputs [].
	 * An explicit pipelineOptions.benchmarkPath wins over this.
	 */
	benchmarkPath?: string;
	/** Extra options forwarded to runOfflinePipeline. */
	pipelineOptions?: OfflinePipelineOptions;
	/** Epoch source. Default: Date.now. */
	now?: () => number;
	/** Injectable for tests. Default: etlSessionFiles. */
	etlFn?: typeof etlSessionFiles;
	/** Injectable for tests. Default: runOfflinePipeline. */
	pipelineFn?: typeof runOfflinePipeline;
	/** Injectable for tests. Default: promoteStagedOutputs. */
	promoteFn?: typeof promoteStagedOutputs;
}

const DEFAULT_INPUT_DIR = "./var/sessions";
const DEFAULT_OUTPUT_DIR = "./var/evolution";

/** Run one offline evolution cycle and return the written checkpoint id. */
export async function runDailyEvolution(store: ExperienceStore, options: DailyEvolutionOptions = {}): Promise<string> {
	const inputDir = options.inputDir ?? DEFAULT_INPUT_DIR;
	const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
	const now = options.now ?? Date.now;
	const etlFn = options.etlFn ?? etlSessionFiles;
	const pipelineFn = options.pipelineFn ?? runOfflinePipeline;
	const promoteFn = options.promoteFn ?? promoteStagedOutputs;

	// Tolerate a fresh install with no sessions directory yet.
	mkdirSync(inputDir, { recursive: true });
	const sessionFiles = readdirSync(inputDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(inputDir, name));

	const etlInserted = await etlFn(sessionFiles, store);
	const benchmarkPath =
		options.pipelineOptions?.benchmarkPath ?? options.benchmarkPath ?? process.env.AGENT_SERVER_BENCHMARK;
	const pipeline = await pipelineFn(inputDir, outputDir, { ...options.pipelineOptions, benchmarkPath });
	const promoted = await promoteFn(outputDir, store);

	return writeCheckpoint(store, {
		kind: "evolution",
		epoch: now(),
		metric: promoted,
		snapshot: JSON.stringify({ etlInserted, pipeline, promoted }),
	});
}
