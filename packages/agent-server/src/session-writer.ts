import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { StreamEvent } from "./toolcall-validator.ts";

export interface SessionHeaderOptions {
	id: string;
	cwd: string;
	/** ISO 8601; defaults to now. */
	timestamp?: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Appends pi-native session JSONL, matching the format written and read by
 * `packages/agent/src/harness/session/jsonl-storage.ts`:
 *
 * - Line 1: a session header `{type:"session", version:3, id, timestamp, cwd, ...}`.
 * - Following lines: tree entries `{type, id, parentId, timestamp, ...}` with
 *   ISO 8601 timestamps. `parentId` chains to the previously written entry
 *   (pi's leaf tracking), so the file replays as a linear branch.
 * - Messages are nested under a `message` payload (`type:"message"`); proxy
 *   metadata with no pi-native equivalent uses `type:"custom"` entries with a
 *   `customType` discriminator, the same mechanism pi extensions use.
 *
 * Entry ids are random UUIDs; pi's reader only requires unique non-empty
 * strings (pi itself uses uuidv7 tails).
 */
/** Paths with an open SessionWriter; released on close(). */
const openSessionPaths = new Set<string>();

export class SessionWriter {
	private stream: WriteStream;
	private readonly path: string;
	private headerWritten = false;
	private lastEntryId: string | null = null;
	/** First WriteStream error, captured at construction so a mid-stream disk failure surfaces on the next write/close. */
	private streamError: Error | null = null;

	constructor(path: string) {
		if (openSessionPaths.has(path)) {
			throw new Error(`SessionWriter: ${path} is already open by another SessionWriter`);
		}
		openSessionPaths.add(path);
		this.path = path;
		this.stream = createWriteStream(path, { flags: "a" });
		// Record stream errors instead of letting them surface only at close
		// (or crash as an unhandled 'error' event mid-stream).
		this.stream.on("error", (err) => {
			if (!this.streamError) this.streamError = err;
		});
	}

	writeSessionHeader(options: SessionHeaderOptions): void {
		if (this.headerWritten) throw new Error("SessionWriter: session header already written");
		this.headerWritten = true;
		this.writeLine({
			type: "session",
			version: 3,
			id: options.id,
			timestamp: options.timestamp ?? new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSession,
			metadata: options.metadata,
		});
	}

	/** Appends a `message` tree entry; returns the generated entry id. */
	writeMessage(message: Message): string {
		return this.appendTreeEntry({ type: "message", message });
	}

	/** Appends a `custom` tree entry for proxy metadata; returns the generated entry id. */
	writeCustomEntry(customType: string, data?: unknown): string {
		return this.appendTreeEntry({ type: "custom", customType, data });
	}

	private appendTreeEntry(entry: Record<string, unknown>): string {
		if (!this.headerWritten) throw new Error("SessionWriter: write the session header before entries");
		const id = randomUUID();
		this.writeLine({
			...entry,
			id,
			parentId: this.lastEntryId,
			timestamp: new Date().toISOString(),
		});
		this.lastEntryId = id;
		return id;
	}

	private writeLine(entry: Record<string, unknown>): void {
		if (this.streamError) throw this.streamError;
		this.stream.write(`${JSON.stringify(entry)}\n`);
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			// An errored stream is already destroyed; end() would throw
			// synchronously instead of invoking the callback.
			if (this.streamError) {
				openSessionPaths.delete(this.path);
				reject(this.streamError);
				return;
			}
			this.stream.end((err: Error | null | undefined) => {
				openSessionPaths.delete(this.path);
				const failure = err ?? this.streamError;
				if (failure) reject(failure);
				else resolve();
			});
		});
	}
}

/**
 * Reconstructs a pi-native {@link AssistantMessage} from the recorded
 * `/api/stream` events (SPEC §4.1) so the session JSONL replays with the
 * model's reply (SPEC §6) instead of ending at the last user message.
 * Content parts (text / thinking / toolCall) are reassembled per
 * `contentIndex` in first-seen order. Returns null unless the stream ended
 * with a `done` event: on error/abort the reply stays recorded only as
 * `stream_event` custom entries. Also returns null when the reassembled
 * content is empty, so no empty assistant `message` entry is written.
 */
export function buildAssistantMessage(events: StreamEvent[], model: Model<any>): AssistantMessage | null {
	const done = events.find((event) => event.type === "done");
	if (!done) return null;

	const order: number[] = [];
	const texts = new Map<number, string>();
	const thinkings = new Map<number, string>();
	const toolCalls = new Map<number, { id: string; name: string; argsText: string }>();
	const track = (contentIndex: number) => {
		if (!order.includes(contentIndex)) order.push(contentIndex);
	};

	for (const event of events) {
		switch (event.type) {
			case "text_start":
			case "text_end":
				track(event.contentIndex);
				break;
			case "text_delta":
				track(event.contentIndex);
				texts.set(event.contentIndex, (texts.get(event.contentIndex) ?? "") + event.delta);
				break;
			case "thinking_start":
			case "thinking_end":
				track(event.contentIndex);
				break;
			case "thinking_delta":
				track(event.contentIndex);
				thinkings.set(event.contentIndex, (thinkings.get(event.contentIndex) ?? "") + event.delta);
				break;
			case "toolcall_start":
				track(event.contentIndex);
				toolCalls.set(event.contentIndex, { id: event.id, name: event.toolName, argsText: "" });
				break;
			case "toolcall_delta": {
				const call = toolCalls.get(event.contentIndex);
				if (call) call.argsText += event.delta;
				break;
			}
		}
	}

	const content: AssistantMessage["content"] = [];
	for (const contentIndex of order) {
		const thinking = thinkings.get(contentIndex);
		if (thinking) content.push({ type: "thinking", thinking });
		const text = texts.get(contentIndex);
		if (text) content.push({ type: "text", text });
		const call = toolCalls.get(contentIndex);
		if (call) {
			// toolCall events are only emitted after outbound validation passed,
			// so argsText is valid JSON; fall back to {} defensively.
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(call.argsText || "{}") as Record<string, unknown>;
			} catch {
				// keep {}
			}
			content.push({ type: "toolCall", id: call.id, name: call.name, arguments: args });
		}
	}

	// A completed stream with zero content writes no assistant message entry.
	if (content.length === 0) return null;

	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: done.usage,
		stopReason: done.reason,
		timestamp: Date.now(),
	};
}

/** One parsed `data: {...}` payload of an OpenAI chat.completion.chunk SSE stream. */
export interface OpenAIChatChunk {
	choices?: {
		delta?: {
			content?: string | null;
			reasoning_content?: string;
			reasoning?: string;
			reasoning_text?: string;
			tool_calls?: {
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		finish_reason?: string | null;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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

function mapFinishReason(reason: string): AssistantMessage["stopReason"] | null {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "toolUse";
		default:
			return null;
	}
}

/**
 * Reconstructs a pi-native {@link AssistantMessage} from the raw OpenAI
 * chat.completion.chunk payloads of the `/v1/chat/completions` streaming
 * branch, mirroring {@link buildAssistantMessage} for sessions whose bytes
 * pass through to OpenAI-compatible clients untransformed. `delta.content`
 * accumulates into a text part, `delta.reasoning_content` / `reasoning` /
 * `reasoning_text` into a thinking part, and `delta.tool_calls[]` fragments
 * are reassembled into toolCall parts by `index` in first-seen order. The
 * final `usage` chunk and `finish_reason` map to `usage`/`stopReason`.
 * Returns null unless a mappable `finish_reason` was seen: on error/abort
 * the reply stays recorded only as `stream_event` custom entries. Also
 * returns null when the reassembled content is empty, so no empty assistant
 * `message` entry is written.
 */
export function buildAssistantMessageFromOpenAI(chunks: OpenAIChatChunk[], model: Model<any>): AssistantMessage | null {
	let text = "";
	let thinking = "";
	let finishReason: string | null = null;
	const usage = zeroUsage();
	const order: number[] = [];
	const toolCalls = new Map<number, { id: string; name: string; argsText: string }>();

	for (const chunk of chunks) {
		if (chunk.usage) {
			usage.input = chunk.usage.prompt_tokens ?? 0;
			usage.output = chunk.usage.completion_tokens ?? 0;
			usage.totalTokens = chunk.usage.total_tokens ?? usage.input + usage.output;
		}
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta;
		if (!delta) continue;
		if (typeof delta.content === "string") text += delta.content;
		const thought = [delta.reasoning_content, delta.reasoning, delta.reasoning_text].find(
			(v): v is string => typeof v === "string" && v.length > 0,
		);
		if (thought) thinking += thought;
		for (const call of delta.tool_calls ?? []) {
			const index = call.index ?? 0;
			if (!order.includes(index)) order.push(index);
			const pending = toolCalls.get(index) ?? { id: "", name: "", argsText: "" };
			if (call.id) pending.id = call.id;
			if (call.function?.name) pending.name = call.function.name;
			if (call.function?.arguments) pending.argsText += call.function.arguments;
			toolCalls.set(index, pending);
		}
	}

	if (!finishReason) return null;
	const stopReason = mapFinishReason(finishReason);
	if (!stopReason) return null;

	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking });
	if (text) content.push({ type: "text", text });
	for (const index of order) {
		const call = toolCalls.get(index);
		if (!call) continue;
		// Argument fragments concatenate into the full arguments JSON; fall
		// back to {} defensively when the stream was truncated.
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(call.argsText || "{}") as Record<string, unknown>;
		} catch {
			// keep {}
		}
		content.push({ type: "toolCall", id: call.id, name: call.name, arguments: args });
	}

	// A completed stream with zero content writes no assistant message entry.
	if (content.length === 0) return null;

	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}
