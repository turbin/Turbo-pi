import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ExperienceStore } from "./experience-store.ts";
import { type GatewayChatRequest, GatewayClient } from "./gateway-client.ts";
import { buildInjection } from "./injection.ts";
import { toOpenAIRequest } from "./openai-compat.ts";
import { retrieve } from "./retrieval.ts";
import { SessionWriter } from "./session-writer.ts";
import { validateToolCallStream } from "./toolcall-validator.ts";
import type { InjectionPayload, ProxyStreamOptions, StreamRequest } from "./types.ts";

export interface ProxyHandlerOptions {
	store: ExperienceStore;
	gatewayUrl: string;
	sessionPath: string;
}

/** FTS bm25 top-24 -> cosine re-rank top-8 (SPEC §5.1 step 3). */
const RETRIEVAL_LIMIT = 8;

/**
 * Online replay pipeline (SPEC §5.1): extract the last user message as query,
 * retrieve + inject experiences, forward to the Python gateway, and transform
 * the raw OpenAI SSE response into the pi-ai-style `/api/stream` event
 * protocol (SPEC §4.1) with toolCall outbound validation (SPEC §5.1 step 7).
 * Every step is recorded to the session JSONL — the request (with injected
 * experience IDs) and every emitted event — including which experience IDs
 * were injected. The writer is closed exactly once, when the stream completes,
 * errors, or is cancelled, so no tail entries are lost.
 */
export async function handleStream(
	body: StreamRequest,
	opts: ProxyHandlerOptions,
): Promise<ReadableStream<Uint8Array>> {
	mkdirSync(dirname(opts.sessionPath), { recursive: true });
	const writer = new SessionWriter(opts.sessionPath);

	try {
		const query = lastUserText(body.context);
		const retrieved = await retrieve(opts.store, query, RETRIEVAL_LIMIT);
		const injected = await buildInjection(body.context, retrieved);
		const gatewayReq = toGatewayRequest(injected, body.model, body.options ?? {});

		writer.write({
			type: "request",
			data: { body, retrieved: retrieved.map((r) => r.experience.id) },
		});

		const gateway = new GatewayClient(opts.gatewayUrl);
		const stream = await gateway.stream(gatewayReq);
		writer.write({ type: "response_started", data: {} });
		const validated = validateToolCallStream(stream, {
			tools: body.context.tools,
			onEvent: (event) => writer.write({ type: "event", data: event }),
		});
		return teeWithSessionClose(validated, writer);
	} catch (err) {
		writer.write({ type: "error", data: { message: String(err) } });
		await writer.close();
		throw err;
	}
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role !== "user") continue;
		const text =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		if (text.startsWith("<system-reminder>")) continue;
		return text;
	}
	return "";
}

function toGatewayRequest(
	payload: InjectionPayload,
	model: Model<any>,
	options: ProxyStreamOptions,
): GatewayChatRequest {
	const req: GatewayChatRequest = toOpenAIRequest(payload, model as Model<"openai-completions">);
	if (options.temperature !== undefined) req.temperature = options.temperature;
	if (options.maxTokens !== undefined) req.max_tokens = options.maxTokens;
	return req;
}

/**
 * Pass `source` through unchanged while guaranteeing the session writer is
 * closed with a terminal entry on completion, mid-stream error, or cancel.
 */
function teeWithSessionClose(source: ReadableStream<Uint8Array>, writer: SessionWriter): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let closed = false;
	const closeWriter = async (entry: Record<string, unknown>) => {
		if (closed) return;
		closed = true;
		writer.write(entry);
		await writer.close();
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await closeWriter({ type: "response_completed", data: {} });
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (err) {
				await closeWriter({ type: "error", data: { message: String(err) } });
				controller.error(err);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await closeWriter({ type: "aborted", data: { reason: String(reason) } });
		},
	});
}
