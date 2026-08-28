import { describe, expect, it } from "vitest";
import {
	checkMeasurementCredibility,
	gateShadowPromotion,
	MAX_MEASUREMENT_AGE_MS,
	type MeasurementGateInput,
} from "../../src/evolution/measurement-gate.ts";
import type { ReplayMetrics, ReplayResult, SnapshotMetrics } from "../../src/evolution/replay-validator.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const BASELINE_ID = "a".repeat(64);
const CANDIDATE_ID = "b".repeat(64);

function snapshotMetrics(overrides: Partial<SnapshotMetrics> = {}): SnapshotMetrics {
	return {
		entryCount: 2,
		meanQuality: 0.7,
		minQuality: 0.6,
		qualityDistribution: { "0.6-0.8": 2 },
		distinctContentHashes: 2,
		...overrides,
	};
}

function replayMetrics(overrides: Partial<ReplayMetrics> = {}): ReplayMetrics {
	return {
		candidate: snapshotMetrics(),
		baseline: snapshotMetrics(),
		contentHashOverlap: 1,
		lostContentHashes: 0,
		meanQualityDelta: 0,
		minQualityDelta: 0,
		invalidEntries: 0,
		...overrides,
	};
}

function replayResult(overrides: Partial<ReplayResult> = {}): ReplayResult {
	return {
		candidateId: CANDIDATE_ID,
		baselineId: BASELINE_ID,
		metrics: replayMetrics(),
		verdict: "pass",
		timestamp: NOW,
		...overrides,
	};
}

function gateInput(overrides: Partial<MeasurementGateInput> = {}): MeasurementGateInput {
	return {
		replayResult: replayResult(),
		baselineId: BASELINE_ID,
		candidateId: CANDIDATE_ID,
		...overrides,
	};
}

describe("measurement gate (P2-T27)", () => {
	it("trusts a complete, recent measurement for distinct artifacts", () => {
		const result = checkMeasurementCredibility(gateInput(), { now: NOW });

		expect(result.trusted).toBe(true);
		expect(result.reasons).toEqual([]);
	});

	it("is untrusted when required metrics fields are missing", () => {
		const input = gateInput({ replayResult: replayResult({ metrics: replayMetrics({ candidate: null }) }) });

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.startsWith("E0:") && r.includes("candidate"))).toBe(true);
	});

	it("is untrusted when snapshot metrics are structurally incomplete", () => {
		const broken = snapshotMetrics({ entryCount: Number.NaN, qualityDistribution: { "0.6-0.8": -1 } });
		const input = gateInput({
			replayResult: replayResult({ metrics: replayMetrics({ baseline: broken }) }),
		});

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.includes("entryCount"))).toBe(true);
		expect(result.reasons.some((r) => r.includes("qualityDistribution"))).toBe(true);
	});

	it("is untrusted when the replay result references different artifacts", () => {
		const input = gateInput({ replayResult: replayResult({ candidateId: "c".repeat(64) }) });

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.startsWith("E0:") && r.includes("candidateId"))).toBe(true);
	});

	it("is untrusted when candidate and baseline are the same artifact", () => {
		const input = gateInput({
			baselineId: CANDIDATE_ID,
			replayResult: replayResult({ baselineId: CANDIDATE_ID }),
		});

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.startsWith("E1:") && r.includes("same artifact"))).toBe(true);
	});

	it("is untrusted when metrics contain invalid entries", () => {
		const input = gateInput({ replayResult: replayResult({ metrics: replayMetrics({ invalidEntries: 2 }) }) });

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.startsWith("E1:") && r.includes("invalid entries"))).toBe(true);
	});

	it("is untrusted when the timestamp is older than 24 hours", () => {
		const stale = new Date(Date.parse(NOW) - MAX_MEASUREMENT_AGE_MS - 1).toISOString();
		const input = gateInput({ replayResult: replayResult({ timestamp: stale }) });

		const result = checkMeasurementCredibility(input, { now: NOW });

		expect(result.trusted).toBe(false);
		expect(result.reasons.some((r) => r.startsWith("E1:") && r.includes("older than 24 hours"))).toBe(true);
	});

	it("is untrusted for unparseable or future timestamps", () => {
		const unparseable = checkMeasurementCredibility(
			gateInput({ replayResult: replayResult({ timestamp: "nope" }) }),
			{
				now: NOW,
			},
		);
		expect(unparseable.trusted).toBe(false);
		expect(unparseable.reasons.some((r) => r.includes("not a valid ISO instant"))).toBe(true);

		const future = new Date(Date.parse(NOW) + 10 * 60 * 1000).toISOString();
		const fromFuture = checkMeasurementCredibility(gateInput({ replayResult: replayResult({ timestamp: future }) }), {
			now: NOW,
		});
		expect(fromFuture.trusted).toBe(false);
		expect(fromFuture.reasons.some((r) => r.includes("in the future"))).toBe(true);
	});

	it("defaults to wall clock and accepts a fresh timestamp", () => {
		const fresh = replayResult({ timestamp: new Date().toISOString() });

		const result = checkMeasurementCredibility(gateInput({ replayResult: fresh }));

		expect(result.trusted).toBe(true);
	});

	it("gateShadowPromotion passes only for a passing verdict with a trusted measurement", () => {
		expect(gateShadowPromotion(replayResult(), BASELINE_ID, CANDIDATE_ID, { now: NOW })).toBe(true);
	});

	it("gateShadowPromotion blocks non-pass verdicts even when the measurement is trusted", () => {
		expect(gateShadowPromotion(replayResult({ verdict: "reject" }), BASELINE_ID, CANDIDATE_ID, { now: NOW })).toBe(
			false,
		);
		expect(
			gateShadowPromotion(replayResult({ verdict: "inconclusive" }), BASELINE_ID, CANDIDATE_ID, { now: NOW }),
		).toBe(false);
	});

	it("gateShadowPromotion blocks passing verdicts with an untrusted measurement", () => {
		const stale = new Date(Date.parse(NOW) - MAX_MEASUREMENT_AGE_MS - 1).toISOString();

		expect(gateShadowPromotion(replayResult({ timestamp: stale }), BASELINE_ID, CANDIDATE_ID, { now: NOW })).toBe(
			false,
		);
		expect(gateShadowPromotion(replayResult(), CANDIDATE_ID, CANDIDATE_ID, { now: NOW })).toBe(false);
	});
});
