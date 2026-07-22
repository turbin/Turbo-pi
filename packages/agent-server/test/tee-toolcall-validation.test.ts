import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teeOpenAISSEWithSession } from "../src/server.ts";
import { SessionWriter } from "../src/session-writer.ts";
import type { ToolCallValidationReport } from "../src/toolcall-validator.ts";

const READ_TOOL = {
	name: "read",
	parameters: {
		type: "object",
		required: ["path"],
		properties: { path: { type: "string" }, offset: { type: "number" } },
	},
};

const SEARCH_TOOL = {
	name: "search",
	parameters: { type: "object", properties: { query: { type: "string" } } },
};

const TOOLS = [READ_TOOL, SEARCH_TOOL];

const MODEL: Model<any> = {
	id: "agent-auto",
	name: "agent-auto",
	api: "openai-completions" as const,
	provider: "local" as const,
	baseUrl: "http://127.0.0.1:8367/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function sseBytes(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function consumeAsText(stream: ReadableStream<Uint8Array>): Promise<string> {
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

describe("teeOpenAISSEWithSession — toolCall validation", () => {
	let dir: string;
	let path: string;
	let writer: SessionWriter;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tee-toolcall-"));
		path = join(dir, "session.jsonl");
		writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "tee-test", cwd: "/tmp/work" });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function drainAndRead(): Promise<Record<string, unknown>[]> {
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	function findCustomEntry(
		entries: Record<string, unknown>[],
		customType: string,
	): Record<string, unknown> | undefined {
		return entries.find((e) => e.type === "custom" && e.customType === customType);
	}

	it("writes toolcall_validation entry for a valid toolCall with pass-through bytes unchanged", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/tmp/a\\"}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		const output = await consumeAsText(tee);
		const entries = await drainAndRead();

		// 1. Raw bytes pass through unchanged
		expect(output).toContain(
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
		);
		expect(output).toContain("data: [DONE]");

		// 2. toolcall_validation custom entry exists after stream events
		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(1);
		expect(reports[0].call).toMatchObject({ streamIndex: 0, id: "call_1", name: "read" });
		expect(reports[0].result).toEqual({ allowed: true });

		// 3. response_completed is the last entry
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry).toMatchObject({ type: "custom", customType: "response_completed" });
	});

	it("records violation for an unknown tool name", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec","arguments":"{}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(1);
		expect(reports[0].result.allowed).toBe(false);
		expect(reports[0].result.reason).toContain("unknown tool");
		expect(reports[0].call.name).toBe("exec");
	});

	it("records violation for invalid JSON arguments", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{not json"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(1);
		expect(reports[0].result.allowed).toBe(false);
		expect(reports[0].result.reason).toContain("invalid arguments JSON");
	});

	it("records violation for missing required property", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"offset\\":1}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(1);
		expect(reports[0].result.allowed).toBe(false);
		expect(reports[0].result.reason).toContain("missing required property path");
	});

	it("assembles multiple toolCalls across different indices and validates each independently", async () => {
		// Two toolCalls arriving interleaved across chunks — index 0 and index 1.
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[' +
				'{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"/a\\"}"}},' +
				'{"index":1,"id":"call_2","function":{"name":"search","arguments":"{\\"query\\":\\"hel"}}' +
				"]}}]}\n\n",
			'data: {"choices":[{"delta":{"tool_calls":[' + '{"index":1,"function":{"arguments":"lo\\"}"}}' + "]}}]}\n\n",
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(2);

		// index 0: read with valid args
		const call0 = reports.find((r) => r.call.streamIndex === 0);
		expect(call0).toBeDefined();
		expect(call0!.call.id).toBe("call_1");
		expect(call0!.call.name).toBe("read");
		expect(call0!.result).toEqual({ allowed: true });

		// index 1: search with valid args
		const call1 = reports.find((r) => r.call.streamIndex === 1);
		expect(call1).toBeDefined();
		expect(call1!.call.id).toBe("call_2");
		expect(call1!.call.name).toBe("search");
		expect(call1!.result).toEqual({ allowed: true });
	});

	it("assembles toolCall arguments split across multiple small chunks on one index", async () => {
		// Single toolCall with arguments fragmented across 3 deltas.
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/x\\","}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"offset\\":0}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(1);
		expect(reports[0].call.argsText).toBe('{"path":"/x","offset":0}');
		expect(reports[0].result).toEqual({ allowed: true });
	});

	it("reports one allowed and one violation when toolCalls are mixed", async () => {
		// Call 0 is valid, call 1 targets an unknown tool.
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[' +
				'{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"/a\\"}"}},' +
				'{"index":1,"id":"call_2","function":{"name":"delete","arguments":"{}"}}' +
				"]}}]}\n\n",
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		const validationEntry = findCustomEntry(entries, "toolcall_validation");
		expect(validationEntry).toBeDefined();
		const { reports } = validationEntry!.data as { reports: ToolCallValidationReport[] };
		expect(reports).toHaveLength(2);
		expect(reports.find((r) => r.call.streamIndex === 0)!.result).toEqual({ allowed: true });
		expect(reports.find((r) => r.call.streamIndex === 1)!.result.allowed).toBe(false);
		expect(reports.find((r) => r.call.streamIndex === 1)!.result.reason).toContain("unknown tool");
	});

	it("skips toolcall_validation when there are no tools to validate against", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		// Pass undefined tools — the tee skips validation entirely.
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, undefined);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		expect(findCustomEntry(entries, "toolcall_validation")).toBeUndefined();
	});

	it("skips toolcall_validation when toolCalls list is empty", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		expect(findCustomEntry(entries, "toolcall_validation")).toBeUndefined();
	});

	it("writes an assistant message entry before toolcall_validation", async () => {
		const source = sseBytes([
			'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		]);
		const tee = teeOpenAISSEWithSession(source, writer, MODEL, TOOLS);
		await consumeAsText(tee);
		const entries = await drainAndRead();

		// assistant message should exist for a clean stream
		const messages = entries.filter((e) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(1);
		const assistantMsg = messages.find((m) => (m as any).message?.role === "assistant");
		expect(assistantMsg).toBeDefined();

		// response_completed is the last entry
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry).toMatchObject({ type: "custom", customType: "response_completed" });
	});
});
