import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { writeCheckpoint } from "../src/offline/checkpoint.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

const DUMP_PATH = "/tmp/agent-server-request.json";

function makeStore(): ExperienceStore {
	const store = new ExperienceStore(":memory:");
	void store.initSchema();
	return store;
}

function postChatCompletion(app: ReturnType<typeof createServer>) {
	return app.inject({
		method: "POST",
		url: "/v1/chat/completions",
		payload: { model: "agent-auto", messages: [{ role: "user", content: "hi" }] },
	});
}

describe("server /v1/chat/completions debug dump", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(DUMP_PATH, { force: true });
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeApp() {
		// Keep session writes out of the repo's var/ (default is cwd-relative).
		const sessionDir = mkdtempSync(join(tmpdir(), "agent-server-dump-test-"));
		tempDirs.push(sessionDir);
		return createServer({ store: makeStore(), gatewayUrl: "http://127.0.0.1:1", sessionDir });
	}

	it("does not dump the request body to /tmp by default", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "");
		rmSync(DUMP_PATH, { force: true });
		// No gateway is listening, so the request fails downstream with 502;
		// the dump (or its absence) happens before that.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = makeApp();
		const res = await postChatCompletion(app);
		expect(res.statusCode).toBe(502);
		expect(existsSync(DUMP_PATH)).toBe(false);
		await app.close();
	});

	it("dumps the request body when AGENT_SERVER_DEBUG_DUMP=1", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "1");
		rmSync(DUMP_PATH, { force: true });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = makeApp();
		const res = await postChatCompletion(app);
		expect(res.statusCode).toBe(502);
		expect(existsSync(DUMP_PATH)).toBe(true);
		await app.close();
	});
});

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

describe("POST /v1/chat/completions streaming session recording", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-stream-"));
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

	it("passes raw OpenAI SSE through unchanged and records a pi-native session", async () => {
		await store.insert(makeExperience());
		const sseChunks = [
			'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_tests","arguments":"{\\"fil"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ter\\":\\"unit\\"}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", stream: true, messages: [{ role: "user", content: "你好" }] },
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/event-stream");
		// Raw OpenAI SSE passthrough: bytes are the gateway's, untransformed.
		expect(res.body).toBe(sseChunks.join(""));

		// Session JSONL mirrors what handleStream records: header, request
		// messages, injection record, stream lifecycle customs, one
		// `stream_event` per parsed chunk, and a reconstructed assistant
		// `message` entry at the end.
		const entries = readSessionEntries();
		expect(entries[0].type).toBe("session");
		expect(entries[0].version).toBe(3);
		expect(entries[0].metadata).toEqual({ model: "agent-auto", provider: "local", requestId: expect.any(String) });
		const messages = entries.filter((e) => e.type === "message");
		expect(messages).toHaveLength(2);
		expect(messages[0].message).toEqual({ role: "user", content: "你好" });
		expect(messages[0].parentId).toBeNull();
		const injection = entries.find((e) => e.customType === "experience_injection");
		expect(injection?.data.retrieved).toEqual(["exp-1"]);
		expect(injection?.parentId).toBe(messages[0].id);
		// custom_message records the injected context the model actually saw.
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
		const streamEvents = entries.filter((e) => e.customType === "stream_event");
		expect(streamEvents).toHaveLength(5);
		expect(streamEvents[0].data.choices[0].delta.reasoning_content).toBe("想一想");

		const assistant = messages[1];
		expect(assistant.parentId).toBe(streamEvents.at(-1)?.id);
		expect(assistant.message).toMatchObject({
			role: "assistant",
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			stopReason: "toolUse",
			usage: { input: 10, output: 5, totalTokens: 15 },
		});
		expect(assistant.message.content).toEqual([
			{ type: "thinking", thinking: "想一想" },
			{ type: "text", text: "你好！" },
			{ type: "toolCall", id: "call_1", name: "run_tests", arguments: { filter: "unit" } },
		]);
		expect(typeof assistant.message.timestamp).toBe("number");
		const completed = entries.find((e) => e.customType === "response_completed");
		expect(completed?.parentId).toBe(assistant.id);
		await app.close();
	});

	it("records an error custom entry and no assistant message when the gateway stream fails mid-stream", async () => {
		let pulled = false;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pulled) {
					pulled = true;
					controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
					return;
				}
				controller.error(new Error("gateway stream reset"));
			},
		});
		mockGatewayFetch(failing);
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		// The response stream breaks mid-flight, so inject rejects; whatever the
		// client sees, the session records the partial stream_event, a terminal
		// error entry, and no reconstructed assistant message.
		await expect(
			app.inject({
				method: "POST",
				url: "/v1/chat/completions",
				payload: { model: "agent-auto", stream: true, messages: [{ role: "user", content: "hi" }] },
			}),
		).rejects.toThrow(/destroyed/);

		const entries = readSessionEntries();
		expect(entries.filter((e) => e.customType === "stream_event")).toHaveLength(1);
		const last = entries[entries.length - 1];
		expect(last.type).toBe("custom");
		expect(last.customType).toBe("error");
		expect(last.data.message).toContain("gateway stream reset");
		expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
		await app.close();
	});
});

describe("POST /v1/chat/completions non-streaming response", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-nonstream-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("assembles tool_calls and maps finish_reason/usage to OpenAI shape", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Par"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"is\\"}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: {
				model: "agent-auto",
				messages: [{ role: "user", content: "weather?" }],
				tools: [
					{
						type: "function",
						function: {
							name: "get_weather",
							description: "Get weather",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			},
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const choice = body.choices[0];
		expect(choice.finish_reason).toBe("tool_calls");
		expect(choice.message.tool_calls).toEqual([
			{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } },
		]);
		expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
		await app.close();
	});

	it("keeps stop finish_reason and empty usage for plain text replies", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", messages: [{ role: "user", content: "hi" }] },
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.choices[0].finish_reason).toBe("stop");
		expect(body.choices[0].message.content).toBe("hello");
		expect(body.choices[0].message.tool_calls).toBeUndefined();
		expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
		await app.close();
	});
});

describe("stop/temperature passthrough to gateway", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-passthrough-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("forwards stop/temperature/max_tokens to the gateway (non-streaming)", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"1"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
			"data: [DONE]\n\n",
		];
		const mock = mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: {
				model: "agent-auto",
				messages: [{ role: "user", content: "count" }],
				stop: ["\n"],
				temperature: 0,
				max_tokens: 100,
				thinking: { type: "disabled" },
			},
		});

		expect(res.statusCode).toBe(200);
		const gatewayBody = JSON.parse(String(mock.mock.calls[0][1].body));
		expect(gatewayBody.stop).toEqual(["\n"]);
		expect(gatewayBody.temperature).toBe(0);
		expect(gatewayBody.max_tokens).toBe(100);
		expect(gatewayBody.thinking).toEqual({ type: "disabled" });
		await app.close();
	});

	it("forwards stop/temperature/max_tokens to the gateway (streaming)", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"1"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
			"data: [DONE]\n\n",
		];
		const mock = mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: {
				model: "agent-auto",
				messages: [{ role: "user", content: "count" }],
				stream: true,
				stop: ["\n"],
				temperature: 0,
				max_tokens: 100,
				thinking: { type: "disabled" },
			},
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("data:");
		const gatewayBody = JSON.parse(String(mock.mock.calls[0][1].body));
		expect(gatewayBody.stop).toEqual(["\n"]);
		expect(gatewayBody.temperature).toBe(0);
		expect(gatewayBody.max_tokens).toBe(100);
		expect(gatewayBody.thinking).toEqual({ type: "disabled" });
		expect(gatewayBody.stream).toBe(true);
		await app.close();
	});
});

describe("O spec: observability endpoints and request traces", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-obs-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const sseChunks = [
		'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
		"data: [DONE]\n\n",
	];

	it("records a hit trace with x-request-id header (non-stream)", async () => {
		await store.insert(makeExperience());
		mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });
		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", messages: [{ role: "user", content: "你好" }] },
		});
		expect(res.statusCode).toBe(200);
		const requestId = res.headers["x-request-id"];
		expect(typeof requestId).toBe("string");
		const stats = await store.getHitRateStats(1);
		expect(stats.total).toBe(1);
		expect(stats.hits).toBe(1);
		expect(stats.recent[0]).toMatchObject({
			requestId,
			hit: 1,
			retrievedCount: 1,
			finishReason: "stop",
			promptTokens: 10,
			completionTokens: 5,
		});
		expect(stats.byKind).toEqual([{ kind: "EVIDENCE:null", cnt: 1 }]);
		await app.close();
	});

	it("records a miss trace on an empty store", async () => {
		mockGatewayFetch(sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });
		await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", messages: [{ role: "user", content: "unrelated" }] },
		});
		const stats = await store.getHitRateStats(1);
		expect(stats.total).toBe(1);
		expect(stats.hits).toBe(0);
		await app.close();
	});

	it("serves /api/stats/hit-rate and /stats", async () => {
		await store.recordRequestTrace({
			requestId: "r1",
			model: "m",
			stream: false,
			retrievedCount: 1,
			retrievedIds: ["e"],
			retrievedKinds: ["ABILITY:Method"],
			hit: true,
		});
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });
		const api = await app.inject({ method: "GET", url: "/api/stats/hit-rate?window_hours=24" });
		expect(api.statusCode).toBe(200);
		const stats = api.json();
		expect(stats.total).toBe(1);
		expect(stats.hits).toBe(1);
		expect(stats.by_kind ?? stats.byKind).toBeDefined();
		const page = await app.inject({ method: "GET", url: "/stats" });
		expect(page.statusCode).toBe(200);
		expect(page.headers["content-type"]).toContain("text/html");
		expect(page.body).toContain("/api/stats/hit-rate");
		await app.close();
	});

	it("records the error path when the gateway fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });
		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", messages: [{ role: "user", content: "hi" }] },
		});
		expect(res.statusCode).toBe(502);
		const stats = await store.getHitRateStats(1);
		expect(stats.recent[0]).toMatchObject({ finishReason: "error", error: expect.stringContaining("no gateway") });
		await app.close();
	});
});

describe("GET /api/evolution/status", () => {
	it("returns 404 and never_run when no checkpoint exists", async () => {
		const store = makeStore();
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:1" });
		const res = await app.inject({ method: "GET", url: "/api/evolution/status" });
		expect(res.statusCode).toBe(404);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("never_run");
		await app.close();
	});

	it("returns the latest evolution checkpoint when one exists", async () => {
		const store = makeStore();
		await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 1700000000000,
			metric: 42,
			snapshot: JSON.stringify({ etlInserted: 200, promoted: 42 }),
		});
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:1" });
		const res = await app.inject({ method: "GET", url: "/api/evolution/status" });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("found");
		expect(body.metric).toBe(42);
		expect(body.id).toBeTruthy();
		expect(body.snapshot.promoted).toBe(42);
		await app.close();
	});

	it("returns the latest checkpoint when multiple kinds exist", async () => {
		const store = makeStore();
		await writeCheckpoint(store, {
			kind: "other",
			epoch: 1700000000000,
			metric: 99,
			snapshot: JSON.stringify({}),
		});
		await writeCheckpoint(store, {
			kind: "evolution",
			epoch: 1700000001000,
			metric: 7,
			snapshot: JSON.stringify({ promoted: 7 }),
		});
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:1" });
		const res = await app.inject({ method: "GET", url: "/api/evolution/status" });
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("found");
		expect(body.metric).toBe(7);
		await app.close();
	});
});
