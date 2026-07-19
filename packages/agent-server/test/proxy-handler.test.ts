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

		// Session JSONL records request (with retrieved IDs), start, every
		// emitted event, and completion.
		const entries = readSessionEntries();
		const types = entries.map((e) => e.type);
		expect(types[0]).toBe("request");
		expect(types[1]).toBe("response_started");
		expect(types[types.length - 1]).toBe("response_completed");
		expect(entries[0].data.retrieved).toEqual(["exp-1"]);
		const eventTypes = entries.filter((e) => e.type === "event").map((e) => e.data.type);
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
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
		const eventTypes = entries.filter((e) => e.type === "event").map((e) => e.data.type);
		expect(eventTypes).toEqual(["start", "error"]);
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
		expect(entries[0].data.retrieved).toEqual([]);
	});

	it("returns 502 and records the error when the gateway fails", async () => {
		mockGatewayFetch(null, false, 500);
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await server.inject({ method: "POST", url: "/api/stream", payload: PAYLOAD });

		expect(resp.statusCode).toBe(502);
		expect(resp.json().error.message).toContain("gateway error: 500");

		const entries = readSessionEntries();
		expect(entries.map((e) => e.type)).toEqual(["request", "error"]);
		expect(entries[1].data.message).toContain("gateway error: 500");
	});
});
