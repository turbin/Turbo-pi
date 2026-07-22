import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { writeCheckpoint } from "../../src/offline/checkpoint.ts";
import { cmdRun, cmdStatus, type RunEvolutionDeps } from "../../src/offline/run-evolution.ts";
import { type DailyEvolutionOptions, runDailyEvolution } from "../../src/offline/scheduler.ts";

function makeStore(): ExperienceStore {
	const store = new ExperienceStore(":memory:");
	void store.initSchema();
	return store;
}

function makeDeps(overrides: Partial<RunEvolutionDeps> = {}): RunEvolutionDeps {
	const store = overrides.store ?? makeStore();
	return {
		store,
		runDailyEvolutionFn: runDailyEvolution,
		writeCheckpointFn: writeCheckpoint,
		sleepFn: async (_ms: number) => {},
		now: () => 0,
		log: vi.fn(),
		logError: vi.fn(),
		...overrides,
	};
}

describe("run-evolution --status", () => {
	let dir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-status-"));
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns never_run when no checkpoint exists", async () => {
		const deps = makeDeps({ store });
		const result = await cmdStatus(deps);
		expect(result.status).toBe("never_run");
	});

	it("returns the last evolution checkpoint", async () => {
		const ckptId = await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 1700000000000,
			metric: 12,
			snapshot: JSON.stringify({ etlInserted: 100, pipeline: "ok", promoted: 12 }),
		});
		const deps = makeDeps({ store });
		const result = await cmdStatus(deps);
		expect(result.status).toBe("found");
		expect(result.checkpoint!.id).toBe(ckptId);
		expect(result.checkpoint!.metric).toBe(12);
		expect(result.checkpoint!.epoch).toBe(new Date(1700000000000).toISOString());
		expect((result.checkpoint!.snapshot as any).promoted).toBe(12);
	});

	it("returns the latest when multiple checkpoints exist", async () => {
		await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 1700000000000,
			metric: 5,
			snapshot: JSON.stringify({ promoted: 5 }),
		});
		await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 1700000001000,
			metric: 15,
			snapshot: JSON.stringify({ promoted: 15 }),
		});
		const result = await cmdStatus(makeDeps({ store }));
		expect(result.status).toBe("found");
		expect(result.checkpoint!.metric).toBe(15);
	});
});

describe("run-evolution cmdRun", () => {
	let dir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-run-"));
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a failure checkpoint and rethrows on error", async () => {
		const error = new Error("ETL exploded");
		const runDailyEvolutionFn = vi.fn().mockRejectedValue(error);
		const deps = makeDeps({ store, runDailyEvolutionFn });

		await expect(cmdRun(deps)).rejects.toThrow("ETL exploded");

		// Verify failure checkpoint was written
		const latest = await store.getLatestCheckpoint("evolution");
		expect(latest).not.toBeNull();
		expect(latest!.metric).toBe(0);
		const snapshot = JSON.parse(latest!.snapshot);
		expect(snapshot.error).toBe("ETL exploded");
	});

	it("writes a success checkpoint via runDailyEvolution", async () => {
		const runDailyEvolutionFn = vi
			.fn()
			.mockImplementation(async (store: ExperienceStore, _opts?: DailyEvolutionOptions) => {
				return writeCheckpoint(store, {
					kind: "evolution",
					epoch: 1700000000000,
					metric: 8,
					snapshot: JSON.stringify({ etlInserted: 50, promoted: 8 }),
				});
			});
		const deps = makeDeps({ store, runDailyEvolutionFn });

		const ckptId = await cmdRun(deps);
		expect(ckptId).toBeTruthy();
		expect(runDailyEvolutionFn).toHaveBeenCalledOnce();

		const latest = await store.getLatestCheckpoint("evolution");
		expect(latest).not.toBeNull();
		expect(latest!.metric).toBe(8);
	});
});
