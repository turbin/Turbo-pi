import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ExperienceStore } from "./experience-store.ts";
import { type GatewayChatRequest, GatewayClient } from "./gateway-client.ts";
import { buildInjection } from "./injection.ts";
import { toOpenAIRequest } from "./openai-compat.ts";
import { retrieve } from "./retrieval.ts";
import { buildAssistantMessage, SessionWriter } from "./session-writer.ts";
import { type StreamEvent, validateToolCallStream } from "./toolcall-validator.ts";
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
 * Every step is recorded to a pi-native session JSONL (SPEC §6): a session
 * header, one `message` tree entry per request context message, an
 * `experience_injection` custom entry with the retrieved experience IDs, and
 * custom entries for the stream lifecycle (`response_started`, `stream_event`,
 * `response_completed` / `error` / `aborted`). When the stream ends with a
 * `done` event, the gateway reply is additionally reconstructed from the
 * accumulated stream events and written as a pi-native assistant `message`
 * entry, so replayed/forked sessions include the model's turn. On stream
 * error/abort no assistant message is written — the partial reply stays
 * recorded only as `stream_event` customs. The writer is closed exactly
 * once, when the stream completes, errors, or is cancelled, so no tail
 * entries are lost.
 */
export async function handleStream(
	body: StreamRequest,
	opts: ProxyHandlerOptions,
): Promise<ReadableStream<Uint8Array>> {
	mkdirSync(dirname(opts.sessionPath), { recursive: true });
	const writer = new SessionWriter(opts.sessionPath);
	writer.writeSessionHeader({
		id: body.options?.sessionId ?? basename(opts.sessionPath, ".jsonl"),
		cwd: process.cwd(),
		metadata: { model: body.model.id, provider: body.model.provider },
	});

	try {
		const query = lastUserText(body.context);
		const retrieved = await retrieve(opts.store, query, RETRIEVAL_LIMIT);
		const injected = await buildInjection(body.context, retrieved, { store: opts.store });
		const gatewayReq = toGatewayRequest(injected, body.model, body.options ?? {});

		for (const message of body.context.messages) {
			writer.writeMessage(message);
		}
		writer.writeCustomEntry("experience_injection", { retrieved: retrieved.map((r) => r.experience.id) });

		const gateway = new GatewayClient(opts.gatewayUrl);
		const stream = await gateway.stream(gatewayReq);
		writer.writeCustomEntry("response_started");
		const streamEvents: StreamEvent[] = [];
		const validated = validateToolCallStream(stream, {
			// Validate against the merged tool list: request tools plus any SOP
			// schemas merged in by buildInjection (SPEC §4.1). Validating against
			// body.context.tools alone would reject legitimate SOP toolCalls.
			tools: injected.tools,
			onEvent: (event) => recordStreamEvent(writer, streamEvents, body.model, event),
		});
		return teeWithSessionClose(validated, writer);
	} catch (err) {
		writer.writeCustomEntry("error", { message: String(err) });
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

/**
 * Records one stream event as a `stream_event` custom entry and, when the
 * stream completed successfully (`done`), writes the reconstructed assistant
 * reply as a pi-native `message` entry chained to the last written entry.
 */
function recordStreamEvent(
	writer: SessionWriter,
	streamEvents: StreamEvent[],
	model: Model<any>,
	event: StreamEvent,
): void {
	writer.writeCustomEntry("stream_event", event);
	streamEvents.push(event);
	if (event.type !== "done") return;
	const reply = buildAssistantMessage(streamEvents, model);
	if (reply) writer.writeMessage(reply);
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
 * closed with a terminal custom entry on completion, mid-stream error, or
 * cancel.
 */
function teeWithSessionClose(source: ReadableStream<Uint8Array>, writer: SessionWriter): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let closed = false;
	const closeWriter = async (customType: string, data?: unknown) => {
		if (closed) return;
		closed = true;
		writer.writeCustomEntry(customType, data);
		await writer.close();
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await closeWriter("response_completed");
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (err) {
				await closeWriter("error", { message: String(err) });
				controller.error(err);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await closeWriter("aborted", { reason: String(reason) });
		},
	});
}
