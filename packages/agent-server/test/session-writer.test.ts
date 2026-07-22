import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAssistantMessage,
	buildAssistantMessageFromOpenAI,
	type OpenAIChatChunk,
	SessionWriter,
} from "../src/session-writer.ts";
import type { StreamEvent } from "../src/toolcall-validator.ts";

/**
 * The target format is the pi-native session JSONL written by
 * `packages/agent/src/harness/session/jsonl-storage.ts`: a `session` header
 * (version 3) followed by tree entries (`{type, id, parentId, timestamp, ...}`)
 * with ISO 8601 timestamps and messages nested under a `message` payload.
 */
describe("SessionWriter (pi-native session JSONL)", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-"));
		path = join(dir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function readEntries(writer: SessionWriter): Promise<Record<string, unknown>[]> {
		await writer.close();
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("writes a version-3 session header as the first line", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-1", cwd: "/tmp/work", timestamp: "2026-07-21T00:00:00.000Z" });
		const [header] = await readEntries(writer);
		expect(header).toEqual({
			type: "session",
			version: 3,
			id: "s-1",
			timestamp: "2026-07-21T00:00:00.000Z",
			cwd: "/tmp/work",
		});
	});

	it("includes optional parentSession and metadata in the header", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({
			id: "s-2",
			cwd: "/tmp/work",
			parentSession: "/sessions/parent.jsonl",
			metadata: { model: "agent-auto" },
		});
		const [header] = await readEntries(writer);
		expect(header?.parentSession).toBe("/sessions/parent.jsonl");
		expect(header?.metadata).toEqual({ model: "agent-auto" });
	});

	it("writes message entries with a nested message payload and ISO timestamp", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-3", cwd: "/tmp/work" });
		const id = writer.writeMessage({ role: "user", content: "hello", timestamp: 1 });
		const [, entry] = await readEntries(writer);
		expect(entry?.type).toBe("message");
		expect(entry?.id).toBe(id);
		expect(entry?.parentId).toBeNull();
		expect(typeof entry?.timestamp).toBe("string");
		expect(entry?.message).toEqual({ role: "user", content: "hello", timestamp: 1 });
	});

	it("chains parentId across entries so the file replays as a tree", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-4", cwd: "/tmp/work" });
		const userId = writer.writeMessage({ role: "user", content: "hi", timestamp: 1 });
		const injectionId = writer.writeCustomEntry("experience_injection", { retrieved: ["exp-1"] });
		const assistantId = writer.writeMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const entries = await readEntries(writer);
		expect(new Set(entries.slice(1).map((e) => e.id)).size).toBe(3);
		expect(entries[1]?.parentId).toBeNull();
		expect(entries[2]?.parentId).toBe(userId);
		expect(entries[3]?.parentId).toBe(injectionId);
		expect(entries[3]?.id).toBe(assistantId);
	});

	it("writes custom entries with customType and data, and omits data when undefined", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-5", cwd: "/tmp/work" });
		writer.writeCustomEntry("experience_injection", { retrieved: ["exp-1"] });
		writer.writeCustomEntry("response_started");
		const [, withData, withoutData] = await readEntries(writer);
		expect(withData).toMatchObject({
			type: "custom",
			customType: "experience_injection",
			data: { retrieved: ["exp-1"] },
		});
		expect(withoutData).toMatchObject({ type: "custom", customType: "response_started" });
		expect("data" in (withoutData ?? {})).toBe(false);
	});

	it("defaults the header timestamp to now", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-6", cwd: "/tmp/work" });
		const [header] = await readEntries(writer);
		expect(typeof header?.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(header?.timestamp as string))).toBe(false);
	});

	it("rejects entries written before the session header", async () => {
		const writer = new SessionWriter(path);
		expect(() => writer.writeMessage({ role: "user", content: "hi", timestamp: 1 })).toThrow(/header/);
		expect(() => writer.writeCustomEntry("x")).toThrow(/header/);
		await writer.close();
	});

	it("rejects a second session header", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-7", cwd: "/tmp/work" });
		expect(() => writer.writeSessionHeader({ id: "s-8", cwd: "/tmp/work" })).toThrow(/header/);
		await writer.close();
	});
});

describe("buildAssistantMessage", () => {
	const model: Model<any> = {
		id: "agent-auto",
		name: "agent-auto",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:8367/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	function usage(input: number, output: number): Usage {
		return {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	it("reconstructs text, thinking and toolCall parts in contentIndex order", () => {
		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "let me " },
			{ type: "thinking_delta", contentIndex: 0, delta: "think" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "text_start", contentIndex: 1 },
			{ type: "text_delta", contentIndex: 1, delta: "Hello" },
			{ type: "text_delta", contentIndex: 1, delta: " world" },
			{ type: "text_end", contentIndex: 1 },
			{ type: "toolcall_start", contentIndex: 2, id: "call_1", toolName: "run_tests" },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"filter":"unit"}' },
			{ type: "toolcall_end", contentIndex: 2 },
			{ type: "done", reason: "toolUse", usage: usage(10, 5) },
		];
		const message = buildAssistantMessage(events, model);
		expect(message).not.toBeNull();
		expect(message).toMatchObject({
			role: "assistant",
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			stopReason: "toolUse",
			usage: usage(10, 5),
		});
		expect(typeof message?.timestamp).toBe("number");
		expect(message?.content).toEqual([
			{ type: "thinking", thinking: "let me think" },
			{ type: "text", text: "Hello world" },
			{ type: "toolCall", id: "call_1", name: "run_tests", arguments: { filter: "unit" } },
		]);
	});

	it("returns null when the stream ended with an error event instead of done", () => {
		const events: StreamEvent[] = [
			{ type: "start" },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
			{ type: "error", reason: "error", errorMessage: "boom", usage: usage(1, 1) },
		];
		expect(buildAssistantMessage(events, model)).toBeNull();
	});

	it("returns null for an aborted stream with no terminal event", () => {
		const events: StreamEvent[] = [{ type: "start" }, { type: "text_delta", contentIndex: 0, delta: "partial" }];
		expect(buildAssistantMessage(events, model)).toBeNull();
	});
});

describe("buildAssistantMessageFromOpenAI", () => {
	const model: Model<any> = {
		id: "agent-auto",
		name: "agent-auto",
		api: "openai-completions",
		provider: "local",
		baseUrl: "http://127.0.0.1:8367/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	it("maps text, thinking, toolCall fragments and usage from OpenAI chunks", () => {
		const chunks: OpenAIChatChunk[] = [
			{ choices: [{ delta: { reasoning_content: "let me " } }] },
			{ choices: [{ delta: { reasoning: "think" } }] },
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: " world" } }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_1", function: { name: "run_tests", arguments: '{"fil' } }],
						},
					},
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ter":"unit"}' } }] } }] },
			{
				choices: [{ delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			},
		];
		const message = buildAssistantMessageFromOpenAI(chunks, model);
		expect(message).not.toBeNull();
		expect(message).toMatchObject({
			role: "assistant",
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			stopReason: "toolUse",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
		});
		expect(typeof message?.timestamp).toBe("number");
		expect(message?.content).toEqual([
			{ type: "thinking", thinking: "let me think" },
			{ type: "text", text: "Hello world" },
			{ type: "toolCall", id: "call_1", name: "run_tests", arguments: { filter: "unit" } },
		]);
	});

	it("reassembles multiple toolCalls by index in first-seen order", () => {
		const chunks: OpenAIChatChunk[] = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } },
								{ index: 1, id: "call_2", function: { name: "read", arguments: '{"path":"b"}' } },
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		];
		const message = buildAssistantMessageFromOpenAI(chunks, model);
		expect(message?.content).toEqual([
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
			{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b" } },
		]);
	});

	it("returns null when no finish_reason was seen (error/abort)", () => {
		const chunks: OpenAIChatChunk[] = [{ choices: [{ delta: { content: "partial" } }] }];
		expect(buildAssistantMessageFromOpenAI(chunks, model)).toBeNull();
	});

	it("returns null for an unmappable finish_reason", () => {
		const chunks: OpenAIChatChunk[] = [
			{ choices: [{ delta: { content: "partial" }, finish_reason: "content_filter" }] },
		];
		expect(buildAssistantMessageFromOpenAI(chunks, model)).toBeNull();
	});

	it("falls back to {} for truncated toolCall arguments", () => {
		const chunks: OpenAIChatChunk[] = [
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] } },
				],
			},
			{ choices: [{ delta: {}, finish_reason: "length" }] },
		];
		const message = buildAssistantMessageFromOpenAI(chunks, model);
		expect(message?.stopReason).toBe("length");
		expect(message?.content).toEqual([{ type: "toolCall", id: "call_1", name: "read", arguments: {} }]);
	});

	it("tolerates chunks without choices or deltas", () => {
		const chunks: OpenAIChatChunk[] = [
			{},
			{ choices: [] },
			{ choices: [{}] },
			{ choices: [{ delta: { content: null } }] },
			{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
		];
		const message = buildAssistantMessageFromOpenAI(chunks, model);
		expect(message?.content).toEqual([{ type: "text", text: "ok" }]);
		expect(message?.stopReason).toBe("stop");
		expect(message?.usage.totalTokens).toBe(0);
	});
});
