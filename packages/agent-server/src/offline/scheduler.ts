import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExperienceStore } from "../experience-store.ts";
import { writeCheckpoint } from "./checkpoint.ts";
import { etlSessionFiles } from "./etl.ts";
import { type OfflinePipelineOptions, runDormantRescore, runOfflinePipeline } from "./pipeline.ts";
import { promoteStagedOutputs, type VerifyItem, verifyAndCanonicalize } from "./verifier.ts";

/**
 * Offline scheduler (SPEC §4.2 / §5.2): one full daily evolution run.
 *
 *   1. ETL session JSONL files -> dormant EVIDENCE candidates
 *   2. runOfflinePipeline      -> staged skills/sops/cards in outputDir
 *   3. promoteStagedOutputs    -> verified entries become active
 *   4. dormant re-verification -> dormant EVIDENCE rows are re-scored by the
 *      Python verification_selection verifier (SPEC §6 Stage 3) and promoted
 *      in place when quality >= 0.5
 *   5. dormant cleanup         -> rows past the TTL (and the oldest excess
 *      over the cap) are marked 'removed' to bound dormant growth
 *   6. writeCheckpoint         -> "evolution" checkpoint (only on success)
 *
 * Dormant lifecycle: ETL candidates enter dormant at quality 0; each run
 * re-scores a bounded batch (oldest first). Rows scoring below threshold
 * stay dormant and are retried on later runs until the TTL or cap removes
 * them — that, not deletion on first failure, is the intended lifecycle.
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
	/** Extra options forwarded to runOfflinePipeline and runDormantRescore. */
	pipelineOptions?: OfflinePipelineOptions;
	/**
	 * Run directory for scoring checkpoints (最小断点, 2026-08-14): passed to
	 * the pipeline and rescore stages as --run-dir so interrupted runs can be
	 * resumed (`run-evolution --resume <dir>`) without re-scoring completed
	 * groups. Default: none (no checkpointing, pre-2026-08-14 behavior).
	 */
	runDir?: string;
	/** Max dormant EVIDENCE rows re-scored per run (oldest first). Default: 200. */
	rescoreLimit?: number;
	/** TTL for dormant rows in days; older rows are marked 'removed'. Default: env AGENT_SERVER_DORMANT_TTL_DAYS, else 30. */
	dormantTtlDays?: number;
	/** Max dormant rows kept after the TTL pass; the oldest excess is marked 'removed'. Default: 10000. */
	dormantCap?: number;
	/** Epoch source. Default: Date.now. */
	now?: () => number;
	/** Injectable for tests. Default: etlSessionFiles. */
	etlFn?: typeof etlSessionFiles;
	/** Injectable for tests. Default: runOfflinePipeline. */
	pipelineFn?: typeof runOfflinePipeline;
	/** Injectable for tests. Default: promoteStagedOutputs. */
	promoteFn?: typeof promoteStagedOutputs;
	/** Injectable for tests. Default: runDormantRescore. */
	rescoreFn?: typeof runDormantRescore;
}

const DEFAULT_INPUT_DIR = "./var/sessions";
const DEFAULT_OUTPUT_DIR = "./var/evolution";
const DEFAULT_RESCORE_LIMIT = 200;
const DEFAULT_DORMANT_TTL_DAYS = 30;
const DEFAULT_DORMANT_CAP = 10_000;
const DAY_MS = 86_400_000;

function defaultDormantTtlDays(): number {
	const env = Number(process.env.AGENT_SERVER_DORMANT_TTL_DAYS);
	return Number.isFinite(env) && env > 0 ? env : DEFAULT_DORMANT_TTL_DAYS;
}

/** Run one offline evolution cycle and return the written checkpoint id. */
export async function runDailyEvolution(store: ExperienceStore, options: DailyEvolutionOptions = {}): Promise<string> {
	const inputDir = options.inputDir ?? DEFAULT_INPUT_DIR;
	const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
	const now = options.now ?? Date.now;
	const etlFn = options.etlFn ?? etlSessionFiles;
	const pipelineFn = options.pipelineFn ?? runOfflinePipeline;
	const promoteFn = options.promoteFn ?? promoteStagedOutputs;
	const rescoreFn = options.rescoreFn ?? runDormantRescore;

	// Tolerate a fresh install with no sessions directory yet.
	mkdirSync(inputDir, { recursive: true });
	const sessionFiles = readdirSync(inputDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(inputDir, name));

	const etlInserted = await etlFn(sessionFiles, store);
	const benchmarkPath =
		options.pipelineOptions?.benchmarkPath ?? options.benchmarkPath ?? process.env.AGENT_SERVER_BENCHMARK;
	const pipeline = await pipelineFn(inputDir, outputDir, {
		...options.pipelineOptions,
		benchmarkPath,
		runDir: options.runDir,
	});
	const promoted = await promoteFn(outputDir, store);

	// Stage 4: re-verify dormant ETL candidates (SPEC §6 Stage 3). Scores below
	// the promotion threshold leave the row dormant for a later run.
	// F2 (T3) 复升排除：带 rescore_excluded_batches 标记的 dormant 行（被实战
	// 证据降级、由人工通道确认）跳过自评复评 N 批——阻断"自评复升→再注入→
	// 再失败"循环；每运行一批计数递减，N 批后恢复复评资格。
	const rescoreLimit = options.rescoreLimit ?? DEFAULT_RESCORE_LIMIT;
	const dormantRows = (await store.listDormant("EVIDENCE", rescoreLimit)).filter(
		(row) =>
			row.rescoreExcludedBatches <= 0 && typeof row.payload.text === "string" && (row.payload.text as string).trim(),
	);
	let rescored = 0;
	let promotedFromDormant = 0;
	if (dormantRows.length > 0) {
		const scores = await rescoreFn(
			dormantRows.map((row) => ({
				task: typeof row.payload.task === "string" ? row.payload.task : "",
				text: String(row.payload.text),
				content_hash: row.contentHash,
			})),
			{ ...options.pipelineOptions, runDir: options.runDir },
		);
		rescored = scores.size;
		const items: VerifyItem[] = [];
		for (const row of dormantRows) {
			const quality = scores.get(row.contentHash);
			if (quality === undefined) continue; // unscored rows stay dormant
			items.push({
				type: "EVIDENCE",
				title: row.title,
				quality,
				payload: row.payload,
				contentHash: row.contentHash,
				sourceSession: row.sourceSession,
				sourceEntryId: row.sourceEntryId,
			});
		}
		promotedFromDormant = await verifyAndCanonicalize(items, store);
	}

	// Stage 5: bound dormant growth (TTL first, then the oldest excess over the cap).
	const dormantTtlDays = options.dormantTtlDays ?? defaultDormantTtlDays();
	const dormantCap = options.dormantCap ?? DEFAULT_DORMANT_CAP;
	const cutoffIso = new Date(now() - dormantTtlDays * DAY_MS).toISOString();
	const removedDormant = await store.removeDormantBefore(cutoffIso, dormantCap);

	// F2 (T3): 复升排除计数每批递减（无论该行本轮是否被选中）。
	const decrementedExclusions = await store.decrementRescoreExclusions();

	return writeCheckpoint(store, {
		kind: "evolution",
		epoch: now(),
		metric: promoted + promotedFromDormant,
		snapshot: JSON.stringify({
			etlInserted,
			pipeline,
			promoted,
			rescored,
			promotedFromDormant,
			removedDormant,
			decrementedExclusions,
		}),
	});
}
