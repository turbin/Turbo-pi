import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

const GATEWAY_URL = "http://127.0.0.1:8787";

function makeExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "exp-1",
		type: "EVIDENCE",
		title: "你好问候偏好",
		payload: { text: "用户说你好时偏好简洁的中文回复" },
		quality: 0.9,
		status: "active",
		sourceSession: "sess-0",
		sourceEntryId: "entry-0",
		contentHash: "hash-0",
		createdAt: "2026-07-19T00:00:00.000Z",
		...overrides,
	};
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function mockGatewayFetch(body: ReadableStream<Uint8Array> | null, ok = true, status = 200) {
	const mock = vi.fn().mockResolvedValue({
		ok,
		status,
		statusText: ok ? "OK" : "Internal Server Error",
		body,
	});
	vi.stubGlobal("fetch", mock);
	return mock;
}

const PAYLOAD = {
	model: { id: "agent-auto", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:8367/v1" },
	context: { messages: [{ role: "user", content: "你好" }] },
	options: { temperature: 0.2, maxTokens: 128 },
};

describe("POST /api/stream", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-proxy-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function readSessionEntries(): Record<string, any>[] {
		const files = readdirSync(sessionDir);
		expect(files).toHaveLength(1);
		return readFileSync(join(sessionDir, files[0]), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	it("proxies request with experience injection and records the session", async () => {
		await store.insert(makeExperience());
		const fetchMock = mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload: PAYLOAD });

		expect(resp.statusCode).toBe(200);
		expect(resp.headers["content-type"]).toContain("text/event-stream");
		// Raw OpenAI SSE is transformed into the pi-ai-style event protocol (SPEC §4.1).
		expect(resp.body).toContain('"delta":"你好！"');
		expect(resp.body).toContain('"type":"done"');
		expect(resp.body).not.toContain("data: [DONE]");

		// Gateway received an OpenAI-compatible request with the injection applied.
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const sent = JSON.parse(init.body as string);
		expect(sent.model).toBe("agent-auto");
		expect(sent.stream).toBe(true);
		expect(sent.temperature).toBe(0.2);
		expect(sent.max_tokens).toBe(128);
		const injected = sent.messages.find(
			(m: { content?: string }) => typeof m.content === "string" && m.content.includes("<Extra Info>"),
		);
		expect(injected).toBeDefined();
		expect(injected.content).toContain("用户说你好时偏好简洁的中文回复");

		// Session JSONL is pi-native (SPEC §6): a session header, one `message`
		// entry per request context message, the injection record, custom
		// entries for the stream lifecycle, and a reconstructed assistant
		// `message` entry once the stream completes.
		const entries = readSessionEntries();
		expect(entries[0].type).toBe("session");
		expect(entries[0].version).toBe(3);
		expect(typeof entries[0].id).toBe("string");
		expect(entries[0].metadata).toEqual({ model: "agent-auto", provider: "local" });
		const messages = entries.filter((e) => e.type === "message");
		expect(messages).toHaveLength(2);
		expect(messages[0].message).toEqual({ role: "user", content: "你好" });
		expect(messages[0].parentId).toBeNull();
		const injection = entries.find((e) => e.customType === "experience_injection");
		expect(injection?.data.retrieved).toEqual(["exp-1"]);
		expect(injection?.parentId).toBe(messages[0].id);
		// custom_message records the injected context the model actually saw
		// (SPEC §6): the evidence block inserted before the last user message.
		const customMessage = entries.find((e) => e.customType === "custom_message");
		expect(customMessage?.parentId).toBe(injection?.id);
		const injectedTexts = (customMessage?.data.messages as { role: string; content: unknown }[]).map((m) =>
			typeof m.content === "string" ? m.content : "",
		);
		expect(injectedTexts.some((text) => text.includes("用户说你好时偏好简洁的中文回复"))).toBe(true);
		const customTypes = entries.filter((e) => e.type === "custom").map((e) => e.customType);
		expect(customTypes[1]).toBe("custom_message");
		expect(customTypes[2]).toBe("response_started");
		expect(customTypes[customTypes.length - 1]).toBe("response_completed");
		const eventTypes = entries.filter((e) => e.customType === "stream_event").map((e) => e.data.type);
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);

		// The gateway reply is recorded as a pi-native assistant `message` entry
		// so replayed/forked sessions include the model's turn.
		const assistant = messages[1];
		const lastStreamEvent = entries.filter((e) => e.customType === "stream_event").at(-1);
		expect(lastStreamEvent).toBeDefined();
		expect(assistant.parentId).toBe(lastStreamEvent?.id);
		expect(assistant.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "你好！" }],
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			stopReason: "stop",
			usage: { input: 10, output: 3, totalTokens: 13 },
		});
		expect(typeof assistant.message.timestamp).toBe("number");
		const completed = entries.find((e) => e.customType === "response_completed");
		expect(completed?.parentId).toBe(assistant.id);
	});

	it("injects skill catalog and SOP schemas, and validates SOP toolCalls against the merged tools", async () => {
		await store.insert(
			makeExperience({
				id: "skill-1",
				type: "SKILL",
				title: "code-review",
				payload: { description: "Review code changes for defects" },
			}),
		);
		await store.insert(
			makeExperience({
				id: "sop-1",
				type: "SOP",
				title: "run-tests",
				payload: {
					schema: {
						name: "run_tests",
						description: "Run the project test suite",
						parameters: {
							type: "object",
							required: ["filter"],
							properties: { filter: { type: "string" } },
						},
					},
				},
			}),
		);
		const fetchMock = mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_tests","arguments":"{\\"filter\\":\\"unit\\"}"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const payload = {
			...PAYLOAD,
			context: {
				...PAYLOAD.context,
				systemPrompt: "You are a helpful agent.",
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
					},
				],
			},
		};
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload });

		expect(resp.statusCode).toBe(200);
		// The SOP toolCall passes outbound validation against the merged tool
		// list (request tools + injected SOP schemas) — it must not be rejected
		// as an unknown tool.
		expect(resp.body).toContain('"type":"done"');
		expect(resp.body).toContain('"reason":"toolUse"');
		expect(resp.body).toContain('"toolName":"run_tests"');
		expect(resp.body).not.toContain('"type":"error"');

		// The gateway request carries the skill catalog in the system prompt
		// and the merged tools (request tools + SOP schemas).
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const sent = JSON.parse(init.body as string);
		const system = sent.messages.find((m: { role: string }) => m.role === "system");
		expect(system).toBeDefined();
		expect(system.content).toContain("You are a helpful agent.");
		expect(system.content).toContain("<available_skills>");
		expect(system.content).toContain('<skill name="code-review">Review code changes for defects</skill>');
		const toolNames = sent.tools.map((t: { function: { name: string } }) => t.function.name);
		expect(toolNames).toContain("read");
		expect(toolNames).toContain("run_tests");
	});

	it("replaces a truncated toolCall with an error event (SPEC §5.1 step 7)", async () => {
		mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const payload = {
			...PAYLOAD,
			context: {
				...PAYLOAD.context,
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
					},
				],
			},
		};
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload });

		expect(resp.statusCode).toBe(200);
		expect(resp.body).toContain('"type":"error"');
		expect(resp.body).toContain("finish_reason=length");
		expect(resp.body).not.toContain('"type":"done"');

		const entries = readSessionEntries();
		const eventTypes = entries.filter((e) => e.customType === "stream_event").map((e) => e.data.type);
		expect(eventTypes).toEqual(["start", "error"]);
		// On stream error no assistant `message` entry is reconstructed; the
		// reply stays recorded only as `stream_event` customs.
		expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
	});

	it("proxies without injection when retrieval has no hits", async () => {
		const fetchMock = mockGatewayFetch(
			sseStream(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]),
		);
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload: PAYLOAD });

		expect(resp.statusCode).toBe(200);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const sent = JSON.parse(init.body as string);
		expect(sent.messages).toEqual([{ role: "user", content: "你好" }]);

		const entries = readSessionEntries();
		const injection = entries.find((e) => e.customType === "experience_injection");
		expect(injection?.data.retrieved).toEqual([]);
	});

	it("returns 502 and records the error when the gateway fails", async () => {
		mockGatewayFetch(null, false, 500);
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload: PAYLOAD });

		expect(resp.statusCode).toBe(502);
		expect(resp.json().error.message).toContain("gateway error: 500");

		const entries = readSessionEntries();
		const last = entries[entries.length - 1];
		expect(last.type).toBe("custom");
		expect(last.customType).toBe("error");
		expect(last.data.message).toContain("gateway error: 500");
	});
});
