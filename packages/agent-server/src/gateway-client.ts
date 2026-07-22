import { writeFile } from "node:fs/promises";
import type { OpenAIChatRequest } from "./openai-compat.ts";

/**
 * Request body sent to the Python agent-gateway. Extends the Task 5 OpenAI
 * body with the sampling/stream options carried by the /api/stream request
 * (SPEC §4.1 `options`).
 */
export interface GatewayChatRequest extends OpenAIChatRequest {
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

/** Non-streaming chat completion response from the gateway. */
export interface OpenAIChatCompletion {
	id: string;
	choices: unknown[];
	[key: string]: unknown;
}

const DEFAULT_GATEWAY_KEY = "lobster-local-key";

/**
 * Client for the Python agent-gateway's OpenAI-compatible
 * `/v1/chat/completions` endpoint (SPEC §4.2). Supports both a JSON
 * (`chat`) and an SSE streaming (`stream`) call.
 */
export class GatewayClient {
	private baseUrl: string;
	private apiKey: string;

	constructor(baseUrl: string, apiKey?: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey ?? process.env.AGENT_GATEWAY_KEY ?? DEFAULT_GATEWAY_KEY;
	}

	async chat(body: GatewayChatRequest): Promise<OpenAIChatCompletion> {
		const resp = await this.post(body);
		return (await resp.json()) as OpenAIChatCompletion;
	}

	async stream(body: GatewayChatRequest): Promise<ReadableStream<Uint8Array>> {
		const resp = await this.post({ ...body, stream: true });
		if (!resp.body) throw new Error("gateway error: no response body");
		return resp.body;
	}

	private async post(body: GatewayChatRequest): Promise<Response> {
		// Opt-in request dump for debugging (same gate as server.ts); off by
		// default so prompts are not written outside var/.
		if (process.env.AGENT_SERVER_DEBUG_DUMP === "1") {
			await writeFile("/tmp/gateway-request.json", JSON.stringify(body, null, 2));
		}
		const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			throw new Error(`gateway error: ${resp.status} ${resp.statusText}`);
		}
		return resp;
	}
}
