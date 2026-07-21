import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";

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
