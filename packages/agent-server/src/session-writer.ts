import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
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
export class SessionWriter {
	private stream: WriteStream;
	private headerWritten = false;
	private lastEntryId: string | null = null;

	constructor(path: string) {
		this.stream = createWriteStream(path, { flags: "a" });
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
		this.stream.write(`${JSON.stringify(entry)}\n`);
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
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
 * `stream_event` custom entries.
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
