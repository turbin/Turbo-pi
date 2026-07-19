import { beforeAll, describe, expect, it } from "vitest";
import { type MockBenchmarkMetrics, runMockBenchmark } from "../src/mock-benchmark.ts";

describe("runMockBenchmark", () => {
	let metrics: MockBenchmarkMetrics;

	beforeAll(async () => {
		metrics = await runMockBenchmark();
	});

	it("reports evidence_recall@12", async () => {
		expect(metrics.evidence_recall_at_12).toBeGreaterThan(0);
	});

	it("recalls every seeded evidence entry through the full P0 pipeline", () => {
		expect(metrics.evidence_recall_at_12).toBe(1);
	});

	it("measures replay token overhead and pool size", () => {
		expect(metrics.replay_token_overhead).toBeGreaterThan(0);
		expect(metrics.pool_size).toBeGreaterThan(0);
	});

	it("verifies toolCall validation end-to-end", () => {
		expect(metrics.toolcall_pass_rate).toBe(1);
	});
});
