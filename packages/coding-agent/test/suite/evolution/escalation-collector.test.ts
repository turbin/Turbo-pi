import { describe, expect, it } from "vitest";
import {
	createEscalationCollector,
	EscalationCollector,
	type EscalationJoinKey,
	parseFromGatewayResponse,
} from "../../../src/core/evolution/escalation-collector.ts";

const VALID_SHA = "b".repeat(64);

function validKey(overrides: Partial<EscalationJoinKey> = {}): EscalationJoinKey {
	return {
		gatewaySequence: 7,
		qualitySignalsSha: VALID_SHA,
		...overrides,
	};
}

describe("EscalationCollector", () => {
	it("records and retrieves join keys in order", () => {
		const collector = new EscalationCollector();
		const first = validKey();
		const second = validKey({ gatewaySequence: 8 });
		collector.recordJoinKey(first);
		collector.recordJoinKey(second);
		expect(collector.getJoinKeys()).toEqual([first, second]);
	});

	it("rejects a non-integer gatewaySequence", () => {
		const collector = new EscalationCollector();
		expect(() => collector.recordJoinKey(validKey({ gatewaySequence: 1.5 }))).toThrow(/gatewaySequence/);
		expect(() => collector.recordJoinKey(validKey({ gatewaySequence: "7" as unknown as number }))).toThrow(
			/gatewaySequence/,
		);
		expect(collector.getJoinKeys()).toHaveLength(0);
	});

	it("rejects an invalid qualitySignalsSha", () => {
		const collector = new EscalationCollector();
		expect(() => collector.recordJoinKey(validKey({ qualitySignalsSha: "abc" }))).toThrow(/qualitySignalsSha/);
		expect(() => collector.recordJoinKey(validKey({ qualitySignalsSha: `g${"b".repeat(63)}` }))).toThrow(
			/qualitySignalsSha/,
		);
		expect(() => collector.recordJoinKey(validKey({ qualitySignalsSha: "B".repeat(64) }))).toThrow(
			/qualitySignalsSha/,
		);
		expect(collector.getJoinKeys()).toHaveLength(0);
	});
});

describe("createEscalationCollector", () => {
	it("returns an independent EscalationCollector instance", () => {
		const a = createEscalationCollector();
		const b = createEscalationCollector();
		expect(a).toBeInstanceOf(EscalationCollector);
		a.recordJoinKey(validKey());
		expect(a.getJoinKeys()).toHaveLength(1);
		expect(b.getJoinKeys()).toHaveLength(0);
	});
});

describe("parseFromGatewayResponse", () => {
	it("extracts a join key from a gateway response shape", () => {
		const response = {
			choices: [{ message: { content: "ok" } }],
			gateway: { gateway_sequence: 12, quality_signals_sha: VALID_SHA },
		};
		expect(parseFromGatewayResponse(response)).toEqual({ gatewaySequence: 12, qualitySignalsSha: VALID_SHA });
	});

	it("extracts a join key from a flat response shape", () => {
		const response = { gateway_sequence: 3, quality_signals_sha: VALID_SHA };
		expect(parseFromGatewayResponse(response)).toEqual({ gatewaySequence: 3, qualitySignalsSha: VALID_SHA });
	});

	it("returns null for missing or invalid join key fields", () => {
		expect(parseFromGatewayResponse(null)).toBeNull();
		expect(parseFromGatewayResponse({})).toBeNull();
		expect(parseFromGatewayResponse({ gateway_sequence: 1.5, quality_signals_sha: VALID_SHA })).toBeNull();
		expect(parseFromGatewayResponse({ gateway_sequence: 1, quality_signals_sha: "short" })).toBeNull();
	});
});
