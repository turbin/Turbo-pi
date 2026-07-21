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

		// Promoted experiences are active in the store.
		expect(await store.listActive("SKILL", 10)).toHaveLength(1);
		expect(await store.listActive("SOP", 10)).toHaveLength(1);
		expect((await store.listActive("EVIDENCE", 10)).some((e) => e.title === "isolate before retry")).toBe(true);

		// The written checkpoint is the latest of its kind.
		expect((await latestCheckpoint(store, "evolution"))?.id).toBe(checkpointId);
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
});
