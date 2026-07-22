import type { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTrajectories, runDormantRescore, runOfflinePipeline } from "../../src/offline/pipeline.ts";

type SpawnFn = typeof spawn;

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJsonl(dir: string, name: string, entries: (Record<string, unknown> | string)[]): string {
	const path = join(dir, name);
	const lines = entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function piNativeSession(): Record<string, unknown>[] {
	return [
		{ type: "session", version: 3, id: "s-1", timestamp: "2026-07-20T00:00:00Z", cwd: "/tmp" },
		{
			type: "message",
			id: "m-1",
			parentId: null,
			timestamp: "2026-07-20T00:00:01Z",
			message: { role: "user", content: "run the tests and fix the failure", timestamp: 1 },
		},
		{
			type: "message",
			id: "m-2",
			parentId: "m-1",
			timestamp: "2026-07-20T00:00:02Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will run the test suite first." },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "npm test" } },
				],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "m-3",
			parentId: "m-2",
			timestamp: "2026-07-20T00:00:03Z",
			message: {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "bash",
				content: [{ type: "text", text: "42 tests passed, 0 failures." }],
				timestamp: 3,
			},
		},
	];
}

interface FakeSpawnFailure {
	module: string;
	code: number | null;
	stderr: string;
	/** Set when the process was killed by a signal (e.g. spawn timeout SIGTERM) instead of exiting. */
	signal?: string;
}

/**
 * Fake spawn: pretends to be `python -m <module>`; writes the canned JSON array
 * for the module to its `--output` path and closes with code 0, or fails for
 * the module named in `failure`.
 */
function makeFakeSpawn(outputs: Record<string, unknown[]>, failure?: FakeSpawnFailure): SpawnFn {
	const fn = (_command: string, args: readonly string[], _options: unknown) => {
		const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
		proc.stderr = new EventEmitter();
		const module = String(args[1]);
		const outIdx = args.indexOf("--output");
		const outPath = outIdx >= 0 ? String(args[outIdx + 1]) : undefined;
		process.nextTick(() => {
			if (failure && failure.module === module) {
				proc.stderr.emit("data", failure.stderr);
				proc.emit("close", failure.code, failure.signal ?? null);
				return;
			}
			if (outPath && outputs[module]) writeFileSync(outPath, JSON.stringify(outputs[module]));
			proc.emit("close", 0, null);
		});
		return proc;
	};
	return fn as unknown as SpawnFn;
}

describe("collectTrajectories", () => {
	it("parses a pi-native session JSONL and pairs toolCall parts with toolResults", () => {
		const dir = makeTempDir("pipeline-collect-");
		writeJsonl(dir, "session-a.jsonl", piNativeSession());

		const trajectories = collectTrajectories(dir);
		expect(trajectories).toHaveLength(1);

		const t = trajectories[0];
		expect(t.taskId).toBe("session-a");
		expect(t.task).toBe("run the tests and fix the failure");
		expect(t.text).toContain("I will run the test suite first.");
		expect(t.text).toContain("42 tests passed, 0 failures.");

		expect(t.toolCalls).toHaveLength(1);
		expect(t.toolCalls[0]).toEqual({
			messageNumber: 1,
			tool: "bash",
			arguments: { command: "npm test" },
			result: "42 tests passed, 0 failures.",
		});
	});

	it("tolerates flat message entries and the custom request format", () => {
		const dir = makeTempDir("pipeline-collect-flat-");
		writeJsonl(dir, "flat.jsonl", [
			{ type: "message", role: "user", content: "flat user task" },
			{ type: "message", role: "assistant", content: "flat assistant reply" },
		]);
		writeJsonl(dir, "request.jsonl", [
			{
				type: "request",
				data: {
					body: {
						context: {
							messages: [
								{ role: "user", content: "request user task" },
								{ role: "assistant", content: [{ type: "text", text: "request assistant reply" }] },
							],
						},
					},
				},
			},
		]);

		const trajectories = collectTrajectories(dir);
		expect(trajectories).toHaveLength(2);
		const flat = trajectories.find((t) => t.taskId === "flat");
		expect(flat?.task).toBe("flat user task");
		expect(flat?.text).toContain("flat assistant reply");
		const request = trajectories.find((t) => t.taskId === "request");
		expect(request?.task).toBe("request user task");
		expect(request?.text).toContain("request assistant reply");
	});

	it("counts the reply once when stream_event customs duplicate a reconstructed assistant message", () => {
		const dir = makeTempDir("pipeline-collect-dedup-");
		writeJsonl(dir, "dup.jsonl", [
			{ type: "session", version: 3, id: "s-3", timestamp: "2026-07-21T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-21T00:00:01Z",
				message: { role: "user", content: "deploy the service", timestamp: 1 },
			},
			{
				type: "custom",
				id: "c-1",
				parentId: "m-1",
				timestamp: "2026-07-21T00:00:02Z",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "Deployment finished without errors." },
			},
			{
				type: "message",
				id: "m-2",
				parentId: "c-1",
				timestamp: "2026-07-21T00:00:03Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Deployment finished without errors." }],
					timestamp: 2,
				},
			},
		]);

		const trajectories = collectTrajectories(dir);
		expect(trajectories).toHaveLength(1);
		const occurrences = trajectories[0].text.split("Deployment finished without errors.").length - 1;
		expect(occurrences).toBe(1);
	});

	it("skips malformed lines and files with no content, and ignores non-jsonl files", () => {
		const dir = makeTempDir("pipeline-collect-robust-");
		writeJsonl(dir, "good.jsonl", [
			"{not json",
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-20T00:00:00Z",
				message: { role: "assistant", content: "survives the malformed neighbour line", timestamp: 1 },
			},
			"",
		]);
		writeJsonl(dir, "empty.jsonl", [{ type: "session", version: 3, id: "s-2", timestamp: "2026-07-20T00:00:00Z" }]);
		writeFileSync(join(dir, "notes.txt"), "not a session file");

		const trajectories = collectTrajectories(dir);
		expect(trajectories).toHaveLength(1);
		expect(trajectories[0].taskId).toBe("good");
		expect(trajectories[0].text).toContain("survives the malformed neighbour line");
	});
});

describe("runOfflinePipeline", () => {
	it("runs the three Python stages and stages skills/sops/cards into outputDir", async () => {
		const inputDir = makeTempDir("pipeline-run-in-");
		const outputDir = join(makeTempDir("pipeline-run-out-"), "out");
		writeJsonl(inputDir, "session-a.jsonl", piNativeSession());

		const outputs = {
			"skill_evolution.pipeline": [{ name: "skill-1" }, { name: "skill-2" }],
			sop_lifecycle: [{ name: "sop-1" }],
			"verification_selection.pipeline": [{ name: "card-1" }, { name: "card-2" }, { name: "card-3" }],
		};
		const result = await runOfflinePipeline(inputDir, outputDir, { spawnFn: makeFakeSpawn(outputs) });

		expect(result).toEqual({ skills: 2, sops: 1, cards: 3 });
		for (const [file, module] of [
			["skills.json", "skill_evolution.pipeline"],
			["sops.json", "sop_lifecycle"],
			["cards.json", "verification_selection.pipeline"],
		] as const) {
			const staged = join(outputDir, file);
			expect(existsSync(staged)).toBe(true);
			expect(JSON.parse(readFileSync(staged, "utf-8"))).toEqual(outputs[module]);
		}
	});

	it("rejects with the stderr tail when a stage exits non-zero", async () => {
		const inputDir = makeTempDir("pipeline-fail-in-");
		const outputDir = join(makeTempDir("pipeline-fail-out-"), "out");
		writeJsonl(inputDir, "session-a.jsonl", piNativeSession());

		const spawnFn = makeFakeSpawn(
			{ "skill_evolution.pipeline": [] },
			{ module: "sop_lifecycle", code: 1, stderr: "Traceback: boom in sop lifecycle" },
		);
		await expect(runOfflinePipeline(inputDir, outputDir, { spawnFn })).rejects.toThrow(
			/python -m sop_lifecycle exited 1: Traceback: boom in sop lifecycle/,
		);
	});

	it("rejects with the signal and timeout when a stage is killed", async () => {
		const inputDir = makeTempDir("pipeline-kill-in-");
		const outputDir = join(makeTempDir("pipeline-kill-out-"), "out");
		writeJsonl(inputDir, "session-a.jsonl", piNativeSession());

		const spawnFn = makeFakeSpawn(
			{ "skill_evolution.pipeline": [] },
			{ module: "sop_lifecycle", code: null, signal: "SIGTERM", stderr: "" },
		);
		await expect(runOfflinePipeline(inputDir, outputDir, { spawnFn, timeoutMs: 1234 })).rejects.toThrow(
			/python -m sop_lifecycle killed by SIGTERM \(timeout 1234ms\)/,
		);
	});

	it("rejects when a stage writes a non-array output", async () => {
		const inputDir = makeTempDir("pipeline-badjson-in-");
		const outputDir = join(makeTempDir("pipeline-badjson-out-"), "out");
		writeJsonl(inputDir, "session-a.jsonl", piNativeSession());

		// sop_lifecycle intentionally absent: the wrapper writes a non-array instead.
		const outputs = {
			"skill_evolution.pipeline": [],
			"verification_selection.pipeline": [],
		};
		const fn = ((command: string, args: readonly string[], options: unknown) => {
			const proc = makeFakeSpawn(outputs)(command, args, options as Parameters<SpawnFn>[2]);
			const module = String(args[1]);
			if (module === "sop_lifecycle") {
				const outIdx = args.indexOf("--output");
				writeFileSync(String(args[outIdx + 1]), JSON.stringify({ not: "an array" }));
			}
			return proc;
		}) as unknown as SpawnFn;
		await expect(runOfflinePipeline(inputDir, outputDir, { spawnFn: fn })).rejects.toThrow(/expected a JSON array/);
	});
});

const hasPython3 = spawnSync("python3", ["-c", "import sys"], { stdio: "ignore" }).status === 0;
const llmEnvKeys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"] as const;

describe("runDormantRescore", () => {
	it("spawns the rescore CLI and maps content_hash to quality", async () => {
		const candidates = [
			{ task: "fix the flaky test", text: "run the tests and verify the fix", content_hash: "hash-a" },
			{ task: "", text: "guessed the answer directly", content_hash: "hash-b" },
		];
		let seenArgs: readonly string[] = [];
		let seenCandidates: unknown;
		const spawnFn = ((_command: string, args: readonly string[], _options: unknown) => {
			seenArgs = args;
			const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
			proc.stderr = new EventEmitter();
			process.nextTick(() => {
				const inIdx = args.indexOf("--input");
				const outIdx = args.indexOf("--output");
				seenCandidates = JSON.parse(readFileSync(String(args[inIdx + 1]), "utf-8"));
				writeFileSync(
					String(args[outIdx + 1]),
					JSON.stringify([
						{ content_hash: "hash-a", quality: 0.9 },
						{ content_hash: "hash-b", quality: 0.1 },
					]),
				);
				proc.emit("close", 0, null);
			});
			return proc;
		}) as unknown as SpawnFn;

		const scores = await runDormantRescore(candidates, { spawnFn });
		expect(seenArgs.slice(0, 3)).toEqual(["-m", "verification_selection.pipeline", "--rescore"]);
		expect(seenCandidates).toEqual(candidates);
		expect([...scores.entries()].sort()).toEqual([
			["hash-a", 0.9],
			["hash-b", 0.1],
		]);
	});

	it("returns an empty map for no candidates without spawning Python", async () => {
		const spawnFn = (() => {
			throw new Error("must not spawn");
		}) as unknown as SpawnFn;
		const scores = await runDormantRescore([], { spawnFn });
		expect(scores.size).toBe(0);
	});
});

describe.runIf(hasPython3)("runOfflinePipeline (real vendored Python, MockLLM fallback)", () => {
	const savedEnv = new Map<string, string | undefined>();

	afterEach(() => {
		for (const key of llmEnvKeys) {
			const saved = savedEnv.get(key);
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
		savedEnv.clear();
	});

	it("extracts skills/sops/cards end-to-end without network access", async () => {
		for (const key of llmEnvKeys) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		const inputDir = makeTempDir("pipeline-e2e-in-");
		const outputDir = join(makeTempDir("pipeline-e2e-out-"), "out");
		writeJsonl(inputDir, "session-a.jsonl", piNativeSession());

		const result = await runOfflinePipeline(inputDir, outputDir, { timeoutMs: 120_000 });

		expect(result.skills).toBeGreaterThanOrEqual(0);
		expect(result.sops).toBeGreaterThanOrEqual(0);
		expect(result.cards).toBeGreaterThanOrEqual(0);
		for (const file of ["skills.json", "sops.json", "cards.json"]) {
			const staged = join(outputDir, file);
			expect(existsSync(staged)).toBe(true);
			expect(Array.isArray(JSON.parse(readFileSync(staged, "utf-8")))).toBe(true);
		}
	}, 120_000);

	it("re-scores dormant candidates end-to-end with the MockLLM fallback", async () => {
		for (const key of llmEnvKeys) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		const scores = await runDormantRescore(
			[
				{
					task: "fix the flaky test",
					text: "Run the tests, verify the fix with a checklist and edge case coverage, then rerun to confirm.",
					content_hash: "hash-good",
				},
				{
					task: "",
					text: "Guess the answer directly and skip all checks; the run ended in error.",
					content_hash: "hash-bad",
				},
			],
			{ timeoutMs: 120_000 },
		);

		expect(scores.size).toBe(2);
		const good = scores.get("hash-good");
		const bad = scores.get("hash-bad");
		expect(good).toBeDefined();
		expect(bad).toBeDefined();
		for (const quality of [good, bad] as number[]) {
			expect(quality).toBeGreaterThanOrEqual(0);
			expect(quality).toBeLessThanOrEqual(1);
		}
		// The mock verifier scores the verifying trajectory above the guessing one.
		expect(good).toBeGreaterThan(bad ?? 1);
	}, 120_000);
});
