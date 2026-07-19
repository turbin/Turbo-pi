import type { Usage } from "@earendil-works/pi-ai";

/**
 * Wire event protocol of `POST /api/stream` (SPEC §4.1), aligned with
 * `ProxyAssistantMessageEvent` in `packages/agent/src/proxy.ts`: the `partial`
 * field is stripped and `done`/`error` carry `usage`. Duplicated here instead
 * of imported because agent-server only depends on pi-ai.
 */
export type StreamEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; usage: Usage }
	| { type: "error"; reason: "aborted" | "error"; errorMessage?: string; usage: Usage };

export interface ToolCallValidationResult {
	allowed: boolean;
	reason?: string;
}

/** Structural subset of pi-ai `Tool` needed for outbound validation. */
export interface ToolSchemaSource {
	name: string;
	parameters?: unknown;
}

export interface ValidateStreamOptions {
	/** Tools from the request context; toolCalls are validated against their schemas. */
	tools?: ToolSchemaSource[];
	/** Called for every event emitted to the transformed stream (session recording). */
	onEvent?: (event: StreamEvent) => void;
}

/**
 * Minimal schema validation (SPEC §5.1 step 7): arguments must be an object,
 * all `required` properties must be present, and present properties must match
 * their declared top-level JSON type.
 */
export function validateToolCall(
	toolCall: { name: string; arguments: unknown },
	schema: unknown,
): ToolCallValidationResult {
	const args = toolCall.arguments;
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return { allowed: false, reason: `toolCall ${toolCall.name}: arguments is not an object` };
	}
	const record = args as Record<string, unknown>;
	const s = schema as { required?: unknown; properties?: unknown } | undefined;
	if (s && Array.isArray(s.required)) {
		for (const key of s.required) {
			if (typeof key === "string" && !(key in record)) {
				return { allowed: false, reason: `toolCall ${toolCall.name}: missing required property ${key}` };
			}
		}
	}
	if (s && typeof s.properties === "object" && s.properties !== null) {
		for (const [key, prop] of Object.entries(s.properties as Record<string, { type?: unknown }>)) {
			if (!(key in record)) continue;
			const declared = prop?.type;
			if (typeof declared !== "string") continue;
			if (!matchesJsonType(record[key], declared)) {
				return { allowed: false, reason: `toolCall ${toolCall.name}: property ${key} expected ${declared}` };
			}
		}
	}
	return { allowed: true };
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
		case "integer":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return true;
	}
}

interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string;
			reasoning?: string;
			reasoning_text?: string;
			tool_calls?: OpenAIToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface PendingToolCall {
	streamIndex: number;
	contentIndex: number;
	id: string;
	name: string;
	argsText: string;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapFinishReason(reason: string): { stopReason: "stop" | "length" | "toolUse" } | { error: string } {
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		default:
			return { error: `Provider finish_reason: ${reason}` };
	}
}

/**
 * Transform a raw OpenAI chat-completion SSE stream (from the gateway) into the
 * pi-ai-style `/api/stream` event protocol (SPEC §4.1), applying outbound
 * toolCall validation (SPEC §5.1 step 7):
 *
 * - Text/thinking deltas stream through live; thinking comes from the
 *   `reasoning_content`/`reasoning`/`reasoning_text` delta fields.
 * - toolCall deltas are buffered because validation needs the full arguments.
 *   When validation passes, the buffered `toolcall_*` events are emitted at
 *   the end of the stream.
 * - `finish_reason=length` rejects the whole toolCall batch （整批拒绝）; a
 *   rejected toolCall is replaced by a terminal `error` event — the only error
 *   channel in the §4.1 protocol — instead of a `done` the client would act on.
 */
export function validateToolCallStream(
	source: ReadableStream<Uint8Array>,
	options: ValidateStreamOptions = {},
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (event: StreamEvent) => {
				options.onEvent?.(event);
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			};
			try {
				await transform(reader, decoder, emit, options.tools);
			} catch (err) {
				emit({ type: "error", reason: "error", errorMessage: String(err), usage: zeroUsage() });
			}
			controller.close();
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		},
	});
}

async function transform(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	decoder: InstanceType<typeof TextDecoder>,
	emit: (event: StreamEvent) => void,
	tools: ToolSchemaSource[] | undefined,
): Promise<void> {
	emit({ type: "start" });

	const usage = zeroUsage();
	let nextContentIndex = 0;
	let textIndex = -1;
	let thinkingIndex = -1;
	let finishReason: string | null = null;
	const toolCalls: PendingToolCall[] = [];

	const handleChunk = (chunk: OpenAIChunk) => {
		if (chunk.usage) {
			usage.input = chunk.usage.prompt_tokens ?? 0;
			usage.output = chunk.usage.completion_tokens ?? 0;
			usage.totalTokens = chunk.usage.total_tokens ?? usage.input + usage.output;
		}
		const choice = chunk.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (!delta) return;
		if (typeof delta.content === "string" && delta.content.length > 0) {
			if (textIndex === -1) {
				textIndex = nextContentIndex++;
				emit({ type: "text_start", contentIndex: textIndex });
			}
			emit({ type: "text_delta", contentIndex: textIndex, delta: delta.content });
		}
		const thinking = [delta.reasoning_content, delta.reasoning, delta.reasoning_text].find(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (thinking) {
			if (thinkingIndex === -1) {
				thinkingIndex = nextContentIndex++;
				emit({ type: "thinking_start", contentIndex: thinkingIndex });
			}
			emit({ type: "thinking_delta", contentIndex: thinkingIndex, delta: thinking });
		}
		for (const call of delta.tool_calls ?? []) {
			const streamIndex = call.index ?? 0;
			let pending = toolCalls.find((t) => t.streamIndex === streamIndex);
			if (!pending) {
				pending = { streamIndex, contentIndex: nextContentIndex++, id: "", name: "", argsText: "" };
				toolCalls.push(pending);
			}
			if (call.id) pending.id = call.id;
			if (call.function?.name) pending.name = call.function.name;
			if (call.function?.arguments) pending.argsText += call.function.arguments;
		}
	};

	let buffer = "";
	const handleLine = (line: string) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return;
		handleChunk(JSON.parse(data) as OpenAIChunk);
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			handleLine(buffer.slice(0, newline).trimEnd());
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) handleLine(buffer.trim());

	if (textIndex !== -1) emit({ type: "text_end", contentIndex: textIndex });
	if (thinkingIndex !== -1) emit({ type: "thinking_end", contentIndex: thinkingIndex });

	if (!finishReason) {
		emit({ type: "error", reason: "error", errorMessage: "Stream ended without finish_reason", usage });
		return;
	}
	const mapped = mapFinishReason(finishReason);
	if ("error" in mapped) {
		emit({ type: "error", reason: "error", errorMessage: mapped.error, usage });
		return;
	}

	if (toolCalls.length > 0) {
		if (mapped.stopReason === "length") {
			emit({
				type: "error",
				reason: "error",
				errorMessage: `toolCall batch rejected: response truncated (finish_reason=length)`,
				usage,
			});
			return;
		}
		const rejections: string[] = [];
		for (const call of toolCalls) {
			let args: unknown;
			try {
				args = JSON.parse(call.argsText || "{}");
			} catch {
				rejections.push(`toolCall ${call.name}: invalid arguments JSON`);
				continue;
			}
			const schema = tools?.find((t) => t.name === call.name);
			if (!schema) {
				rejections.push(`toolCall ${call.name}: unknown tool ${call.name}`);
				continue;
			}
			const result = validateToolCall({ name: call.name, arguments: args }, schema.parameters);
			if (!result.allowed) rejections.push(result.reason ?? `toolCall ${call.name} rejected`);
		}
		if (rejections.length > 0) {
			emit({ type: "error", reason: "error", errorMessage: `toolCall rejected: ${rejections.join("; ")}`, usage });
			return;
		}
		for (const call of toolCalls) {
			emit({ type: "toolcall_start", contentIndex: call.contentIndex, id: call.id, toolName: call.name });
			emit({ type: "toolcall_delta", contentIndex: call.contentIndex, delta: call.argsText });
			emit({ type: "toolcall_end", contentIndex: call.contentIndex });
		}
	}

	emit({ type: "done", reason: mapped.stopReason, usage });
}
