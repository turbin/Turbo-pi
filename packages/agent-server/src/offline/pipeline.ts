import { type SpawnOptions, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Offline pipeline (SPEC §4.2 step 3): spawn the three vendored Python handoff
 * packages as subprocesses to extract skills / SOPs / experience cards from
 * collected session trajectories.
 *
 * The Python packages live in `packages/agent-server/python/` (vendored from
 * the handoff bundle, plus thin CLI entry points matching the SPEC commands):
 *   - python -m skill_evolution.pipeline   --input trajectories.json --output skills.json
 *   - python -m sop_lifecycle              --input trajectories.json --output sops.json
 *   - python -m verification_selection.pipeline --input trajectories.json --output cards.json
 *
 * The subprocesses pick a real OpenAI-compatible endpoint when LLM_BASE_URL +
 * LLM_MODEL/TEACHER_MODEL are set, otherwise they fall back to deterministic
 * MockLLM implementations. Verification/canonicalize and ExperienceStore
 * promotion live in verifier.ts; this stage only runs extraction and stages
 * the intermediate JSON files in `outputDir`.
 *
 * `runDormantRescore` is the companion re-verification entry point (SPEC §5.2
 * / §6 Stage 3): it feeds dormant ETL candidates to
 * `verification_selection.pipeline --rescore` and returns their continuous
 * quality scores keyed by contentHash.
 */

export interface PipelineResult {
	skills: number;
	sops: number;
	cards: number;
}

export interface TrajectoryToolCall {
	messageNumber: number;
	tool: string;
	arguments: Record<string, unknown>;
	result: string;
}

export interface SessionTrajectory {
	taskId: string;
	task: string;
	text: string;
	toolCalls: TrajectoryToolCall[];
}

export interface OfflinePipelineOptions {
	/** Python interpreter. Default: env AGENT_SERVER_PYTHON, else "python3". */
	pythonBin?: string;
	/** Directory containing the vendored packages (used as PYTHONPATH). Default: env AGENT_SERVER_PYTHON_DIR, else <pkg>/python. */
	pythonDir?: string;
	/** Optional benchmark JSON for skill evolution (SPEC §4.2 step 2); omitted => skill stage outputs []. */
	benchmarkPath?: string;
	/** Per-subprocess timeout in ms. Default: 300_000. */
	timeoutMs?: number;
	/** Injectable for tests. Default: node:child_process spawn. */
	spawnFn?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_TAIL = 2000;

function defaultPythonDir(): string {
	// src/offline/pipeline.ts -> packages/agent-server/python
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "python");
}

export async function runOfflinePipeline(
	inputDir: string,
	outputDir: string,
	options: OfflinePipelineOptions = {},
): Promise<PipelineResult> {
	const pythonBin = options.pythonBin ?? process.env.AGENT_SERVER_PYTHON ?? "python3";
	const pythonDir = options.pythonDir ?? process.env.AGENT_SERVER_PYTHON_DIR ?? defaultPythonDir();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const spawnFn = options.spawnFn ?? spawn;

	const trajectories = collectTrajectories(inputDir);
	const tempDir = mkdtempSync(join(tmpdir(), "agent-server-pipeline-"));
	try {
		const trajPath = join(tempDir, "trajectories.json");
		writeFileSync(trajPath, JSON.stringify(trajectories));

		const skillsPath = join(tempDir, "skills.json");
		const sopsPath = join(tempDir, "sops.json");
		const cardsPath = join(tempDir, "cards.json");

		const env = {
			...process.env,
			PYTHONPATH: process.env.PYTHONPATH ? `${pythonDir}${delimiter}${process.env.PYTHONPATH}` : pythonDir,
		};
		const run = (module: string, args: string[]) => runPython(spawnFn, pythonBin, module, args, env, timeoutMs);

		const skillArgs = ["--input", trajPath, "--output", skillsPath];
		if (options.benchmarkPath) skillArgs.push("--benchmark", options.benchmarkPath);
		await run("skill_evolution.pipeline", skillArgs);
		await run("sop_lifecycle", ["--input", trajPath, "--output", sopsPath]);
		await run("verification_selection.pipeline", ["--input", trajPath, "--output", cardsPath]);

		const skills = readJsonArray(skillsPath);
		const sops = readJsonArray(sopsPath);
		const cards = readJsonArray(cardsPath);

		// Stage intermediates for the verifier/canonicalize step (Task 7).
		mkdirSync(outputDir, { recursive: true });
		copyFileSync(skillsPath, join(outputDir, "skills.json"));
		copyFileSync(sopsPath, join(outputDir, "sops.json"));
		copyFileSync(cardsPath, join(outputDir, "cards.json"));

		return { skills: skills.length, sops: sops.length, cards: cards.length };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/** One dormant ETL candidate for the Python `--rescore` CLI (wire format, snake_case). */
export interface DormantRescoreCandidate {
	/** Task context for the pairwise scorer; may be "". */
	task: string;
	/** Dormant EVIDENCE payload text. */
	text: string;
	/** Existing store contentHash (ETL hashes sha256(text)); passed through unchanged. */
	content_hash: string;
}

/**
 * Re-score dormant ETL candidates via
 * `python -m verification_selection.pipeline --rescore`. Returns a
 * contentHash -> quality map (quality in [0,1], same vs-reference scale as
 * the main pipeline). An empty candidate list short-circuits without
 * spawning Python.
 */
export async function runDormantRescore(
	candidates: DormantRescoreCandidate[],
	options: OfflinePipelineOptions = {},
): Promise<Map<string, number>> {
	const scores = new Map<string, number>();
	if (candidates.length === 0) return scores;

	const pythonBin = options.pythonBin ?? process.env.AGENT_SERVER_PYTHON ?? "python3";
	const pythonDir = options.pythonDir ?? process.env.AGENT_SERVER_PYTHON_DIR ?? defaultPythonDir();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const spawnFn = options.spawnFn ?? spawn;

	const tempDir = mkdtempSync(join(tmpdir(), "agent-server-rescore-"));
	try {
		const inputPath = join(tempDir, "candidates.json");
		const outputPath = join(tempDir, "scores.json");
		writeFileSync(inputPath, JSON.stringify(candidates));

		const env = {
			...process.env,
			PYTHONPATH: process.env.PYTHONPATH ? `${pythonDir}${delimiter}${process.env.PYTHONPATH}` : pythonDir,
		};
		await runPython(
			spawnFn,
			pythonBin,
			"verification_selection.pipeline",
			["--rescore", "--input", inputPath, "--output", outputPath],
			env,
			timeoutMs,
		);

		for (const entry of readJsonArray(outputPath)) {
			const e = entry as { content_hash?: unknown; quality?: unknown };
			if (typeof e.content_hash === "string" && typeof e.quality === "number") {
				scores.set(e.content_hash, e.quality);
			}
		}
		return scores;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Read every `*.jsonl` file in `inputDir` and reduce it to one trajectory per
 * file: first user text becomes `task`, all assistant/toolResult text is
 * concatenated into `text`, and pi-native toolCall parts are paired with their
 * toolResult messages into `toolCalls` (best effort; the custom proxy-handler
 * format carries no tool calls).
 */
export function collectTrajectories(inputDir: string): SessionTrajectory[] {
	const files = readdirSync(inputDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
	const trajectories: SessionTrajectory[] = [];
	for (const name of files) {
		const path = join(inputDir, name);
		const trajectory = parseSessionFile(path, name.replace(/\.jsonl$/, ""));
		if (trajectory.text || trajectory.toolCalls.length > 0) trajectories.push(trajectory);
	}
	return trajectories;
}

function parseSessionFile(path: string, taskId: string): SessionTrajectory {
	let task = "";
	const texts: string[] = [];
	const toolCalls: TrajectoryToolCall[] = [];
	const callById = new Map<string, TrajectoryToolCall>();

	const recordMessage = (message: Record<string, unknown>) => {
		const role = String(message.role ?? "");
		if (role === "user" && !task) {
			task = extractText(message.content);
			return;
		}
		if (role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				const p = part as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
				if (p?.type === "toolCall" && p.name) {
					const call: TrajectoryToolCall = {
						messageNumber: toolCalls.length + 1,
						tool: p.name,
						arguments: p.arguments ?? {},
						result: "",
					};
					toolCalls.push(call);
					if (p.id) callById.set(p.id, call);
				}
			}
		}
		if (role === "assistant" || role === "toolResult") {
			const text = extractText(message.content);
			if (text) texts.push(text);
			if (role === "toolResult") {
				const call = callById.get(String(message.toolCallId ?? ""));
				if (call && !call.result) call.result = text;
			}
		}
	};

	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // skip malformed lines instead of aborting the whole file
		}
		if (entry.type === "message") {
			// Pi-native: message payload is nested under `message`; tolerate flat.
			recordMessage((entry.message ?? entry) as Record<string, unknown>);
			continue;
		}
		if (entry.type === "request") {
			const data = entry.data as { body?: { context?: { messages?: unknown } } } | undefined;
			const contextMessages = data?.body?.context?.messages;
			if (!Array.isArray(contextMessages)) continue;
			for (const message of contextMessages) recordMessage(message as Record<string, unknown>);
		}
	}
	return { taskId, task, text: texts.join("\n"), toolCalls };
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				return p?.type === "text" && typeof p.text === "string" ? p.text : "";
			})
			.join("");
	}
	return "";
}

function readJsonArray(path: string): unknown[] {
	const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!Array.isArray(data)) throw new Error(`offline pipeline: expected a JSON array in ${path}`);
	return data;
}

function runPython(
	spawnFn: typeof spawn,
	pythonBin: string,
	module: string,
	args: string[],
	env: SpawnOptions["env"],
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawnFn(pythonBin, ["-m", module, ...args], { env, timeout: timeoutMs });
		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
			if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL);
		});
		proc.on("error", (err) => {
			reject(new Error(`offline pipeline: failed to spawn ${pythonBin} -m ${module}: ${err.message}`));
		});
		proc.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
			} else if (signal) {
				reject(
					new Error(
						`offline pipeline: python -m ${module} killed by ${signal} (timeout ${timeoutMs}ms): ${stderr}`,
					),
				);
			} else {
				reject(new Error(`offline pipeline: python -m ${module} exited ${code}: ${stderr}`));
			}
		});
	});
}
