import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { latestCheckpoint, readCheckpoint, writeCheckpoint } from "../../src/offline/checkpoint.ts";
import type { PipelineResult } from "../../src/offline/pipeline.ts";
import { runDailyEvolution } from "../../src/offline/scheduler.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-scheduler-test-"));
	tempDirs.push(dir);
	return dir;
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

function writeSessionFile(dir: string): void {
	const entries = [
		{ type: "session", version: 3, id: "s-1", timestamp: "2026-07-21T00:00:00Z", cwd: "/tmp" },
		{
			type: "message",
			id: "m-1",
			parentId: null,
			timestamp: "2026-07-21T00:00:01Z",
			message: { role: "user", content: "fix the flaky offline test", timestamp: 1 },
		},
		{
			type: "message",
			id: "m-2",
			parentId: "m-1",
			timestamp: "2026-07-21T00:00:02Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Always isolate the failing case before retrying the run." }],
				timestamp: 2,
			},
		},
	];
	writeFileSync(join(dir, "session-a.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

const STAGED_SKILLS = [{ name: "skill-isolate", summary: "isolate first", utility: 0.9, content: "# Isolate" }];
const STAGED_SOPS = [{ name: "fix_and_test", code: "def fix_and_test(): ...", docstring: "fix then test", schema: {} }];
const STAGED_CARDS = [
	{
		taskId: "t-1",
		quality: 0.8,
		card: {
			name: "isolate before retry",
			trigger: "Use when a step is flaky",
			procedure: "1) isolate 2) retry",
			boundary: "Must not apply to deterministic failures",
			role: "Method",
			evidence: { task_id: "t-1", verifier_score: 0.8 },
		},
	},
	{
		taskId: "t-2",
		quality: 0.1,
		card: {
			name: "low quality card",
			trigger: "Use when q",
			procedure: "1) w",
			boundary: "Must not e",
			role: "Guard",
			evidence: { task_id: "t-2", verifier_score: 0.1 },
		},
	},
];

/** Fake pipeline: stages canned JSON arrays into outputDir like the real one. */
function makeFakePipeline(result: PipelineResult) {
	return async (_inputDir: string, outputDir: string): Promise<PipelineResult> => {
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "skills.json"), JSON.stringify(STAGED_SKILLS));
		writeFileSync(join(outputDir, "sops.json"), JSON.stringify(STAGED_SOPS));
		writeFileSync(join(outputDir, "cards.json"), JSON.stringify(STAGED_CARDS));
		return result;
	};
}

/** No-op rescore: keeps dormant rows dormant without spawning Python. */
const noRescore = async () => new Map<string, number>();

describe("runDailyEvolution", () => {
	it("runs ETL, pipeline and promotion, then writes an evolution checkpoint", async () => {
		const sessionDir = makeTempDir();
		writeSessionFile(sessionDir);
		const outputDir = join(makeTempDir(), "evolution");

		const store = await makeStore();
		const now = 1_800_000_000_000;
		const checkpointId = await runDailyEvolution(store, {
			inputDir: sessionDir,
			outputDir,
			now: () => now,
			pipelineFn: makeFakePipeline({ skills: 1, sops: 1, cards: 2 }),
			rescoreFn: noRescore,
		});
		expect(checkpointId).toBeDefined();

		const checkpoint = await readCheckpoint(store, checkpointId);
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.kind).toBe("evolution");
		expect(checkpoint?.epoch).toBe(now);
		// skill (0.9) + sop (pre-vetted) + one card (0.8); the 0.1 card is gated out.
		expect(checkpoint?.metric).toBe(3);

		const snapshot = JSON.parse(checkpoint?.snapshot ?? "{}") as {
			etlInserted: number;
			pipeline: PipelineResult;
			promoted: number;
		};
		expect(snapshot.pipeline).toEqual({ skills: 1, sops: 1, cards: 2 });
		expect(snapshot.promoted).toBe(3);
		expect(snapshot.etlInserted).toBeGreaterThanOrEqual(1);

		// Promoted experiences are active in the store. The promoted card is
		// role Method, so it is stored as ABILITY, not EVIDENCE.
		expect(await store.listActive("SKILL", 10)).toHaveLength(1);
		expect(await store.listActive("SOP", 10)).toHaveLength(1);
		expect((await store.listActive("ABILITY", 10)).some((e) => e.title === "isolate before retry")).toBe(true);

		// The written checkpoint is the latest of its kind.
		expect((await latestCheckpoint(store, "evolution"))?.id).toBe(checkpointId);
	});

	it("forwards benchmarkPath to the pipeline (option > env), defaulting to undefined", async () => {
		const sessionDir = makeTempDir();
		writeSessionFile(sessionDir);
		const outputDir = join(makeTempDir(), "evolution");
		const store = await makeStore();

		const seen: (string | undefined)[] = [];
		const pipelineFn = async (_inputDir: string, outDir: string, opts?: { benchmarkPath?: string }) => {
			seen.push(opts?.benchmarkPath);
			return makeFakePipeline({ skills: 1, sops: 1, cards: 2 })(_inputDir, outDir);
		};

		process.env.AGENT_SERVER_BENCHMARK = "/tmp/env-benchmark.json";
		// Distinct epochs: checkpoint ids are deterministic per (kind, epoch).
		let epoch = 1_800_000_000_000;
		const now = () => ++epoch;
		try {
			// Explicit option wins over the env var.
			await runDailyEvolution(store, {
				inputDir: sessionDir,
				outputDir,
				benchmarkPath: "/tmp/opt-benchmark.json",
				pipelineFn,
				rescoreFn: noRescore,
				now,
			});
			// Env var is the fallback.
			await runDailyEvolution(store, { inputDir: sessionDir, outputDir, pipelineFn, rescoreFn: noRescore, now });
			// pipelineOptions.benchmarkPath wins over both.
			await runDailyEvolution(store, {
				inputDir: sessionDir,
				outputDir,
				benchmarkPath: "/tmp/opt-benchmark.json",
				pipelineOptions: { benchmarkPath: "/tmp/explicit-benchmark.json" },
				pipelineFn,
				rescoreFn: noRescore,
				now,
			});
		} finally {
			delete process.env.AGENT_SERVER_BENCHMARK;
		}
		// No option and no env: undefined is forwarded (skill stage outputs []).
		await runDailyEvolution(store, { inputDir: sessionDir, outputDir, pipelineFn, rescoreFn: noRescore, now });

		expect(seen).toEqual([
			"/tmp/opt-benchmark.json",
			"/tmp/env-benchmark.json",
			"/tmp/explicit-benchmark.json",
			undefined,
		]);
	});

	it("leaves no checkpoint behind when the pipeline fails", async () => {
		const sessionDir = makeTempDir();
		writeSessionFile(sessionDir);
		const outputDir = join(makeTempDir(), "evolution");
		const store = await makeStore();

		const pipelineFn = async (): Promise<PipelineResult> => {
			throw new Error("python -m sop_lifecycle exited 1: boom");
		};
		await expect(runDailyEvolution(store, { inputDir: sessionDir, outputDir, pipelineFn })).rejects.toThrow(
			/sop_lifecycle exited 1/,
		);
		expect(await latestCheckpoint(store, "evolution")).toBeNull();
	});

	it("accepts a missing input directory (fresh install) as an empty run", async () => {
		const base = makeTempDir();
		const store = await makeStore();
		const checkpointId = await runDailyEvolution(store, {
			inputDir: join(base, "does-not-exist-yet"),
			outputDir: join(base, "evolution"),
			pipelineFn: makeFakePipeline({ skills: 1, sops: 1, cards: 2 }),
		});
		const checkpoint = await readCheckpoint(store, checkpointId);
		const snapshot = JSON.parse(checkpoint?.snapshot ?? "{}") as { etlInserted: number };
		expect(snapshot.etlInserted).toBe(0);
	});

	it("re-verifies dormant ETL candidates: >= 0.5 promotes in place, below stays dormant", async () => {
		const sessionDir = makeTempDir();
		const outputDir = join(makeTempDir(), "evolution");
		const store = await makeStore();
		const createdAt = new Date().toISOString();
		await store.insert({
			id: "ev-high",
			type: "EVIDENCE",
			title: "high candidate",
			payload: { text: "high quality candidate text" },
			quality: 0,
			status: "dormant",
			sourceSession: "s-1",
			sourceEntryId: "e-1",
			contentHash: "hash-high",
			createdAt,
		});
		await store.insert({
			id: "ev-low",
			type: "EVIDENCE",
			title: "low candidate",
			payload: { text: "low quality candidate text" },
			quality: 0,
			status: "dormant",
			sourceSession: "s-1",
			sourceEntryId: "e-2",
			contentHash: "hash-low",
			createdAt,
		});

		const rescoreFn = async (candidates: { content_hash: string }[]) => {
			expect(candidates.map((c) => c.content_hash).sort()).toEqual(["hash-high", "hash-low"]);
			return new Map([
				["hash-high", 0.9],
				["hash-low", 0.1],
			]);
		};
		const emptyPipeline = async (_inputDir: string, outDir: string): Promise<PipelineResult> => {
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "skills.json"), "[]");
			writeFileSync(join(outDir, "sops.json"), "[]");
			writeFileSync(join(outDir, "cards.json"), "[]");
			return { skills: 0, sops: 0, cards: 0 };
		};

		const checkpointId = await runDailyEvolution(store, {
			inputDir: sessionDir,
			outputDir,
			pipelineFn: emptyPipeline,
			rescoreFn,
		});

		const high = await store.getById("ev-high");
		expect(high?.status).toBe("active");
		expect(high?.quality).toBe(0.9);
		const low = await store.getById("ev-low");
		expect(low?.status).toBe("dormant");
		expect(low?.quality).toBe(0);

		const checkpoint = await readCheckpoint(store, checkpointId);
		const snapshot = JSON.parse(checkpoint?.snapshot ?? "{}") as {
			rescored: number;
			promotedFromDormant: number;
			removedDormant: number;
		};
		expect(snapshot.rescored).toBe(2);
		expect(snapshot.promotedFromDormant).toBe(1);
		expect(snapshot.removedDormant).toBe(0);
		// Headline metric counts staged promotions + dormant promotions.
		expect(checkpoint?.metric).toBe(1);
	});

	it("marks dormant rows past the TTL as removed after the rescore step", async () => {
		const sessionDir = makeTempDir();
		const outputDir = join(makeTempDir(), "evolution");
		const store = await makeStore();
		const now = 1_800_000_000_000;
		await store.insert({
			id: "ev-old",
			type: "EVIDENCE",
			title: "stale candidate",
			payload: { text: "stale candidate text" },
			quality: 0,
			status: "dormant",
			sourceSession: "s-1",
			sourceEntryId: "e-1",
			contentHash: "hash-old",
			createdAt: new Date(now - 40 * 86_400_000).toISOString(), // 40 days old, TTL is 30
		});

		const checkpointId = await runDailyEvolution(store, {
			inputDir: sessionDir,
			outputDir,
			now: () => now,
			pipelineFn: makeFakePipeline({ skills: 1, sops: 1, cards: 2 }),
			rescoreFn: noRescore, // unscored: stays dormant, then the TTL pass removes it
		});

		expect((await store.getById("ev-old"))?.status).toBe("removed");
		const checkpoint = await readCheckpoint(store, checkpointId);
		const snapshot = JSON.parse(checkpoint?.snapshot ?? "{}") as { removedDormant: number };
		expect(snapshot.removedDormant).toBe(1);
	});

	it("skips the rescore step silently when there are no dormant rows", async () => {
		const sessionDir = makeTempDir();
		const outputDir = join(makeTempDir(), "evolution");
		const store = await makeStore();
		let called = false;
		const rescoreFn = async () => {
			called = true;
			return new Map<string, number>();
		};
		const checkpointId = await runDailyEvolution(store, {
			inputDir: sessionDir,
			outputDir,
			pipelineFn: makeFakePipeline({ skills: 1, sops: 1, cards: 2 }),
			rescoreFn,
		});
		expect(called).toBe(false);
		const checkpoint = await readCheckpoint(store, checkpointId);
		const snapshot = JSON.parse(checkpoint?.snapshot ?? "{}") as { rescored: number; promotedFromDormant: number };
		expect(snapshot.rescored).toBe(0);
		expect(snapshot.promotedFromDormant).toBe(0);
	});
});

describe("writeCheckpoint / readCheckpoint", () => {
	it("round-trips kind, epoch, metric and snapshot", async () => {
		const store = await makeStore();
		const id = await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 42,
			metric: 7,
			snapshot: JSON.stringify({ promoted: 7 }),
		});
		const checkpoint = await readCheckpoint(store, id);
		expect(checkpoint?.id).toBe(id);
		expect(checkpoint?.kind).toBe("evolution");
		expect(checkpoint?.epoch).toBe(42);
		expect(checkpoint?.metric).toBe(7);
		expect(JSON.parse(checkpoint?.snapshot ?? "")).toEqual({ promoted: 7 });
	});

	it("latestCheckpoint returns the row with the highest epoch for the kind", async () => {
		const store = await makeStore();
		await writeCheckpoint(store, { kind: "evolution", epoch: 100, metric: 1, snapshot: "{}" });
		const newer = await writeCheckpoint(store, { kind: "evolution", epoch: 200, metric: 2, snapshot: "{}" });
		await writeCheckpoint(store, { kind: "other", epoch: 300, metric: 3, snapshot: "{}" });
		expect((await latestCheckpoint(store, "evolution"))?.id).toBe(newer);
		expect(await readCheckpoint(store, "ckpt-does-not-exist")).toBeNull();
	});

	it("separates hash inputs so concatenated values cannot collide", async () => {
		const store = await makeStore();
		// Without separators both hash "ev123" ("ev"+12+"3" == "ev1"+2+"3").
		const a = await writeCheckpoint(store, { kind: "ev", epoch: 12, metric: 0, snapshot: "3" });
		const b = await writeCheckpoint(store, { kind: "ev1", epoch: 2, metric: 0, snapshot: "3" });
		expect(a).not.toBe(b);
	});

	it("treats re-writing the same checkpoint id as a no-op success (retry-safe)", async () => {
		const store = await makeStore();
		const input = { kind: "evolution", epoch: 42, metric: 7, snapshot: JSON.stringify({ promoted: 7 }) };
		const id = await writeCheckpoint(store, input);
		const retry = await writeCheckpoint(store, input);
		expect(retry).toBe(id);
		const checkpoint = await readCheckpoint(store, id);
		expect(checkpoint?.epoch).toBe(42);
		expect(checkpoint?.metric).toBe(7);
	});
});
