import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { createServer } from "../../src/server.ts";
import { validateToolCallStream } from "../../src/toolcall-validator.ts";

/**
 * issue-004 回归：非流式路径升级标记链路（gateway x-gateway → agent-server
 * 非流式 body → openai SDK 对象）。两层断裂：
 * 1. toolcall-validator 必须解析 gateway SSE 的 `: x-gateway` 注释并带入 done 事件；
 * 2. /v1/chat/completions 非流式响应 body 必须携带 x_gateway 字段。
 */

const MARKER_COMMENT =
	': x-gateway {"escalated": true, "reason": "finish_reason_length", "provider": "kimi", "local_provider": "omlx"}\n\n';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function gatewaySseWithMarker(reason = "stop"): ReadableStream<Uint8Array> {
	return sseStream([
		MARKER_COMMENT,
		'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"agent-auto",' +
			'"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
		'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"agent-auto",' +
			`"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"${reason}"}]}\n\n`,
		"data: [DONE]\n\n",
	]);
}

function mockGatewayFetch(body: ReadableStream<Uint8Array> | null, ok = true) {
	const mock = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 502, statusText: ok ? "OK" : "Bad Gateway", body });
	vi.stubGlobal("fetch", mock);
	return mock;
}

function collectEvents(stream: ReadableStream<Uint8Array>): Promise<Record<string, any>[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const events: Record<string, any>[] = [];
	const pump = async (): Promise<void> => {
		const { done, value } = await reader.read();
		if (done) return;
		for (const line of decoder.decode(value).split("\n")) {
			if (!line.startsWith("data: ")) continue;
			events.push(JSON.parse(line.slice(6)));
		}
		await pump();
	};
	return pump().then(() => events);
}

describe("issue-004: non-streaming x-gateway marker chain", () => {
	it("toolcall-validator parses the x-gateway comment into the done event (red layer 1)", async () => {
		const events = await collectEvents(validateToolCallStream(gatewaySseWithMarker()));
		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		expect(done?.x_gateway).toEqual({
			escalated: true,
			reason: "finish_reason_length",
			provider: "kimi",
			local_provider: "omlx",
		});
	});

	it("non-streaming /v1/chat/completions body carries x_gateway (red layer 2)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-server-issue004-"));
		const store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
		try {
			mockGatewayFetch(gatewaySseWithMarker());
			const server = createServer({
				store,
				gatewayUrl: "http://127.0.0.1:8787",
				sessionDir: join(dir, "sessions"),
			});
			const resp = await server.inject({
				method: "POST",
				url: "/v1/chat/completions",
				payload: { model: "agent-auto", messages: [{ role: "user", content: "你好" }] },
			});
			expect(resp.statusCode).toBe(200);
			const body = resp.json();
			expect(body.x_gateway).toEqual({
				escalated: true,
				reason: "finish_reason_length",
				provider: "kimi",
				local_provider: "omlx",
			});
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
			vi.unstubAllGlobals();
		}
	});
});
