import { describe, expect, it, vi } from "vitest";
import {
	type StreamEvent,
	type ValidateStreamOptions,
	validateToolCall,
	validateToolCallStream,
} from "../src/toolcall-validator.ts";

const READ_TOOL = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		required: ["path"],
		properties: { path: { type: "string" }, offset: { type: "number" } },
	},
};

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function readSse(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out;
}

function parseEvents(raw: string): StreamEvent[] {
	return raw
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as StreamEvent);
}

async function runStream(chunks: string[], options: ValidateStreamOptions) {
	const raw = await readSse(validateToolCallStream(sseStream(chunks), options));
	return parseEvents(raw);
}

describe("validateToolCall", () => {
	it("allows arguments satisfying the schema", () => {
		const result = validateToolCall({ name: "read", arguments: { path: "/tmp/a" } }, READ_TOOL.parameters);
		expect(result).toEqual({ allowed: true });
	});

	it("rejects a missing required property", () => {
		const result = validateToolCall({ name: "read", arguments: {} }, READ_TOOL.parameters);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("missing required property path");
	});

	it("rejects a wrong top-level property type", () => {
		const result = validateToolCall({ name: "read", arguments: { path: 42 } }, READ_TOOL.parameters);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("path");
	});

	it("rejects non-object arguments", () => {
		const result = validateToolCall({ name: "read", arguments: "nope" }, READ_TOOL.parameters);
		expect(result.allowed).toBe(false);
	});
});

describe("validateToolCallStream", () => {
	it("transforms a text stream into pi-ai-style events", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
				'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		const done = events[events.length - 1];
		expect(done).toMatchObject({ type: "done", reason: "stop" });
		if (done.type === "done") {
			expect(done.usage.input).toBe(10);
			expect(done.usage.output).toBe(2);
			expect(done.usage.totalTokens).toBe(12);
		}
	});

	it("emits buffered toolcall events and done(toolUse) for a valid toolCall", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/tmp/a\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
		expect(events[1]).toMatchObject({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" });
		expect(events[2]).toMatchObject({ type: "toolcall_delta", delta: '{"path":"/tmp/a"}' });
		expect(events[4]).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("rejects truncated toolCall on finish_reason=length", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
		expect(events[1]).toMatchObject({ type: "error", reason: "error" });
		if (events[1].type === "error") expect(events[1].errorMessage).toContain("length");
	});

	it("rejects a toolCall missing a required property", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"offset\\":1}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
		if (events[1].type === "error") expect(events[1].errorMessage).toContain("missing required property path");
	});

	it("rejects a toolCall for an unknown tool", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":"{}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
		if (events[1].type === "error") expect(events[1].errorMessage).toContain("unknown tool exec");
	});

	it("rejects unparseable toolCall arguments", async () => {
		const events = await runStream(
			[
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{not json"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			],
			{ tools: [READ_TOOL] },
		);
		expect(events.map((e) => e.type)).toEqual(["start", "error"]);
		if (events[1].type === "error") expect(events[1].errorMessage).toContain("invalid arguments JSON");
	});

	it("parses SSE frames split across chunk boundaries", async () => {
		const frame = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
		const mid = Math.floor(frame.length / 2);
		const events = await runStream([frame.slice(0, mid), frame.slice(mid)], { tools: [] });
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("reports each emitted event through onEvent", async () => {
		const onEvent = vi.fn();
		const stream = validateToolCallStream(
			sseStream(['data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
			{ tools: [], onEvent },
		);
		await readSse(stream);
		expect(onEvent.mock.calls.map(([e]) => (e as StreamEvent).type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});

	it("emits an error event when the stream ends without finish_reason", async () => {
		const events = await runStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'], { tools: [] });
		expect(events[events.length - 1]).toMatchObject({ type: "error", reason: "error" });
	});
});
