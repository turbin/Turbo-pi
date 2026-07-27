import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";

describe("ExperienceStore request traces", () => {
	it("upserts a trace in two phases (retrieval then completion)", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.recordRequestTrace({
			requestId: "req-1",
			ts: "2026-07-25T03:00:00.000Z",
			model: "deepseek-v4-flash",
			stream: true,
			retrievedCount: 2,
			retrievedIds: ["exp-1", "exp-2"],
			retrievedKinds: ["EVIDENCE:null", "ABILITY:Method"],
			hit: true,
		});
		await store.recordRequestTrace({
			requestId: "req-1",
			finishReason: "tool_calls",
			promptTokens: 812,
			completionTokens: 132,
			latencyMs: 3410,
		});
		const stats = await store.getHitRateStats(24, new Date("2026-07-25T04:00:00.000Z"));
		expect(stats.total).toBe(1);
		expect(stats.hits).toBe(1);
		expect(stats.byKind).toEqual([
			{ kind: "ABILITY:Method", cnt: 1 },
			{ kind: "EVIDENCE:null", cnt: 1 },
		]);
		expect(stats.recent[0]).toMatchObject({
			requestId: "req-1",
			finishReason: "tool_calls",
			promptTokens: 812,
			completionTokens: 132,
			latencyMs: 3410,
			hit: 1,
		});
	});

	it("computes hit_rate and filters rows outside the window", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const now = new Date("2026-07-25T12:00:00.000Z");
		const mk = (id: string, ts: string, hit: boolean) =>
			store.recordRequestTrace({
				requestId: id,
				ts,
				model: "m",
				stream: false,
				retrievedCount: hit ? 1 : 0,
				retrievedIds: hit ? ["e"] : [],
				retrievedKinds: hit ? ["EVIDENCE:null"] : [],
				hit,
			});
		await mk("in-1", "2026-07-25T11:00:00.000Z", true);
		await mk("in-2", "2026-07-25T10:00:00.000Z", true);
		await mk("in-3", "2026-07-25T09:00:00.000Z", false);
		await mk("out-1", "2026-07-20T09:00:00.000Z", true); // 5 days ago, outside 24h
		const stats = await store.getHitRateStats(24, now);
		expect(stats.total).toBe(3);
		expect(stats.hits).toBe(2);
		expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
		expect(stats.recent).toHaveLength(3);
	});

	it("records the error path", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.recordRequestTrace({
			requestId: "req-err",
			ts: "2026-07-25T03:00:00.000Z",
			model: "m",
			stream: false,
			retrievedCount: 0,
			retrievedIds: [],
			retrievedKinds: [],
			hit: false,
		});
		await store.recordRequestTrace({ requestId: "req-err", finishReason: "error", error: "gateway 502" });
		const stats = await store.getHitRateStats(24, new Date("2026-07-25T04:00:00.000Z"));
		expect(stats.recent[0]).toMatchObject({ requestId: "req-err", finishReason: "error", error: "gateway 502" });
	});

	it("aggregates daily series", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const mk = (id: string, ts: string, hit: boolean) =>
			store.recordRequestTrace({
				requestId: id,
				ts,
				model: "m",
				stream: false,
				retrievedCount: hit ? 1 : 0,
				retrievedIds: [],
				retrievedKinds: [],
				hit,
			});
		await mk("d1", "2026-07-23T10:00:00.000Z", true);
		await mk("d2", "2026-07-24T10:00:00.000Z", true);
		await mk("d3", "2026-07-24T11:00:00.000Z", false);
		const stats = await store.getHitRateStats(72, new Date("2026-07-25T12:00:00.000Z"));
		expect(stats.daily).toEqual([
			{ day: "2026-07-23", total: 1, hits: 1 },
			{ day: "2026-07-24", total: 2, hits: 1 },
		]);
	});
});
