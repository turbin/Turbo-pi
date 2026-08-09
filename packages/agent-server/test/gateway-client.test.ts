import { afterEach, describe, expect, it, vi } from "vitest";
import { type GatewayChatRequest, GatewayClient } from "../src/gateway-client.ts";

const GATEWAY_URL = "http://127.0.0.1:8787";

function makeBody(overrides: Partial<GatewayChatRequest> = {}): GatewayChatRequest {
	return {
		model: "agent-auto",
		messages: [{ role: "user", content: "hello" }],
		...overrides,
	};
}

function mockFetchOnce(response: unknown) {
	const mock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal("fetch", mock);
	return mock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AGENT_GATEWAY_KEY;
});

describe("GatewayClient", () => {
	it("sends chat completion request and returns parsed JSON", async () => {
		const mock = mockFetchOnce({
			ok: true,
			json: async () => ({ id: "chatcmpl-1", choices: [] }),
		});
		const client = new GatewayClient(GATEWAY_URL);
		const body = makeBody({ temperature: 0.2, max_tokens: 128 });
		const resp = await client.chat(body);

		expect(resp.id).toBe("chatcmpl-1");
		expect(mock).toHaveBeenCalledTimes(1);
		const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${GATEWAY_URL}/v1/chat/completions`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer lobster-local-key");
		expect(JSON.parse(init.body as string)).toEqual(body);
	});

	it("uses AGENT_GATEWAY_KEY env var when no explicit key is given", async () => {
		process.env.AGENT_GATEWAY_KEY = "env-key";
		const mock = mockFetchOnce({ ok: true, json: async () => ({ id: "chatcmpl-2", choices: [] }) });
		const client = new GatewayClient(GATEWAY_URL);
		await client.chat(makeBody());
		const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer env-key");
	});

	it("prefers explicit apiKey over env var", async () => {
		process.env.AGENT_GATEWAY_KEY = "env-key";
		const mock = mockFetchOnce({ ok: true, json: async () => ({ id: "chatcmpl-3", choices: [] }) });
		const client = new GatewayClient(GATEWAY_URL, "explicit-key");
		await client.chat(makeBody());
		const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer explicit-key");
	});

	it("strips trailing slashes from baseUrl", async () => {
		const mock = mockFetchOnce({ ok: true, json: async () => ({ id: "chatcmpl-4", choices: [] }) });
		const client = new GatewayClient(`${GATEWAY_URL}/`);
		await client.chat(makeBody());
		const [url] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${GATEWAY_URL}/v1/chat/completions`);
	});

	it("throws on non-ok chat response", async () => {
		mockFetchOnce({ ok: false, status: 502, statusText: "Bad Gateway" });
		const client = new GatewayClient(GATEWAY_URL);
		await expect(client.chat(makeBody())).rejects.toThrow("gateway error: 502 Bad Gateway");
	});

	it("stream sets stream:true and returns the response body", async () => {
		const bodyStream = new ReadableStream<Uint8Array>();
		const mock = mockFetchOnce({ ok: true, body: bodyStream });
		const client = new GatewayClient(GATEWAY_URL);
		const result = await client.stream(makeBody());

		expect(result).toBe(bodyStream);
		const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).stream).toBe(true);
	});

	// M2 (adversarial review 2026-08-09): usage=0 in request_traces was caused
	// by streams never requesting stream_options.include_usage — the gateway
	// only emits the usage chunk on request. Without it, the length-flaw
	// signature (completion_tokens pinned at the cap) was invisible.
	it("stream requests include_usage so token usage is observable (M2)", async () => {
		const bodyStream = new ReadableStream<Uint8Array>();
		const mock = mockFetchOnce({ ok: true, body: bodyStream });
		const client = new GatewayClient(GATEWAY_URL);
		await client.stream(makeBody());

		const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).stream_options).toEqual({ include_usage: true });
	});

	it("stream throws on non-ok response", async () => {
		mockFetchOnce({ ok: false, status: 500, statusText: "Internal Server Error" });
		const client = new GatewayClient(GATEWAY_URL);
		await expect(client.stream(makeBody())).rejects.toThrow("gateway error: 500 Internal Server Error");
	});

	it("stream throws when response has no body", async () => {
		mockFetchOnce({ ok: true, body: null });
		const client = new GatewayClient(GATEWAY_URL);
		await expect(client.stream(makeBody())).rejects.toThrow("no response body");
	});
});
