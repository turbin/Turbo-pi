import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalize,
	createToolEventCollector,
	hashCanonical,
	type ToolEvent,
	ToolEventCollector,
} from "../../../src/core/evolution/tool-event-collector.ts";

// sha256 of JSON.stringify("hello"), i.e. the canonical form of the string "hello".
const SHA256_CANONICAL_HELLO = "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a";

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
	return {
		toolName: "read_file",
		argsHash: hashCanonical({ path: "a.ts" }),
		resultHash: hashCanonical("file contents"),
		durationMs: 12,
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

describe("ToolEventCollector", () => {
	it("records and retrieves events in order", () => {
		const collector = createToolEventCollector();
		const first = makeEvent({ toolName: "read_file" });
		const second = makeEvent({ toolName: "write_file", durationMs: 30 });
		collector.record(first);
		collector.record(second);
		expect(collector.getEvents()).toEqual([first, second]);
	});

	it("returns a copy so callers cannot mutate internal state", () => {
		const collector = createToolEventCollector();
		collector.record(makeEvent());
		collector.getEvents().push(makeEvent({ toolName: "injected" }));
		expect(collector.getEvents()).toHaveLength(1);
	});

	it("captures the error field when present", () => {
		const collector = createToolEventCollector();
		collector.record(makeEvent({ error: "ENOENT: no such file" }));
		const [event] = collector.getEvents();
		expect(event.error).toBe("ENOENT: no such file");
	});

	it("omits the error field on success", () => {
		const collector = createToolEventCollector();
		collector.record(makeEvent());
		expect(collector.getEvents()[0].error).toBeUndefined();
	});

	it("factory returns a ToolEventCollector instance", () => {
		expect(createToolEventCollector()).toBeInstanceOf(ToolEventCollector);
	});
});

describe("canonicalize / hashCanonical", () => {
	it("produces deterministic hashes independent of key order", () => {
		const a = hashCanonical({ b: 2, a: 1 });
		const b = hashCanonical({ a: 1, b: 2 });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("sorts nested object keys recursively", () => {
		expect(canonicalize({ z: { y: 1, x: 2 }, a: [3, 4] })).toBe('{"a":[3,4],"z":{"x":2,"y":1}}');
	});

	it("distinguishes different payloads", () => {
		expect(hashCanonical({ path: "a.ts" })).not.toBe(hashCanonical({ path: "b.ts" }));
	});

	it("matches a known sha256 vector", () => {
		expect(hashCanonical("hello")).toBe(SHA256_CANONICAL_HELLO);
		expect(hashCanonical("hello")).toBe(sha256Hex('"hello"'));
	});
});
