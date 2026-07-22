import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
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
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(DUMP_PATH, { force: true });
	});

	it("does not dump the request body to /tmp by default", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "");
		rmSync(DUMP_PATH, { force: true });
		// No gateway is listening, so the request fails downstream with 502;
		// the dump (or its absence) happens before that.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = createServer({ store: makeStore(), gatewayUrl: "http://127.0.0.1:1" });
		const res = await postChatCompletion(app);
		expect(res.statusCode).toBe(502);
		expect(existsSync(DUMP_PATH)).toBe(false);
		await app.close();
	});

	it("dumps the request body when AGENT_SERVER_DEBUG_DUMP=1", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "1");
		rmSync(DUMP_PATH, { force: true });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = createServer({ store: makeStore(), gatewayUrl: "http://127.0.0.1:1" });
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
		expect(entries[0].metadata).toEqual({ model: "agent-auto", provider: "local" });
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
