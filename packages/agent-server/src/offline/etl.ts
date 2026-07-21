import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExperienceStore } from "../experience-store.ts";

/**
 * Offline ETL (SPEC §4.2 step 1 / §5.2): parse session JSONL files and insert
 * EVIDENCE candidates (dormant, quality 0) into the ExperienceStore. The
 * offline pipeline later promotes candidates to active after verification.
 *
 * Two on-disk formats are supported:
 *
 * 1. Pi-native session format (P1 target, Task 8): a `{type:"session"}`
 *    header plus `{type:"message", id, parentId, message:{role, content}}`
 *    entries (see SessionMessageEntry in pi's session-manager). A flat
 *    `{role, content}` message entry is also tolerated. The streamed reply
 *    lives in `{type:"custom", customType:"stream_event", data}` entries,
 *    whose `text_delta`/`thinking_delta` payloads are reassembled per
 *    contentIndex into one assistant message.
 * 2. Legacy P0 proxy-handler format (`{type, data}`), kept only so old files
 *    remain readable: the `request` entry carries `data.body.context.messages`,
 *    and `event` entries carry the same streamed SSE events as `stream_event`.
 *
 * Only assistant and toolResult text is mined. Insertion is idempotent per
 * (file, entry, sentence) so a cron run can safely reprocess a file.
 */

interface ExtractedMessage {
	entryId: string;
	role: string;
	text: string;
}

export async function etlSessionFiles(paths: string[], store: ExperienceStore): Promise<number> {
	let inserted = 0;
	for (const path of paths) {
		for (const message of extractMessages(path)) {
			if (message.role !== "assistant" && message.role !== "toolResult") continue;
			const sentences = splitSentences(message.text);
			for (let i = 0; i < sentences.length; i++) {
				const text = sentences[i];
				const id = `ev-${shortHash(`${path}${message.entryId}${i}`)}`;
				if (await store.getById(id)) continue;
				await store.insert({
					id,
					type: "EVIDENCE",
					title: text.slice(0, 50),
					payload: {
						text,
						sourceSession: path,
						sourceEntryId: message.entryId,
						charStart: 0,
						charEnd: text.length,
					},
					quality: 0,
					status: "dormant",
					sourceSession: path,
					sourceEntryId: message.entryId,
					contentHash: createHash("sha256").update(text).digest("hex"),
					createdAt: new Date().toISOString(),
				});
				inserted++;
			}
		}
	}
	return inserted;
}

function extractMessages(path: string): ExtractedMessage[] {
	const messages: ExtractedMessage[] = [];
	// Reassembled streamed text from stream_event custom entries (and legacy `event` entries).
	const streamParts = new Map<number, string[]>();
	let streamIndex = 0;

	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // skip malformed lines instead of aborting the whole file
		}

		if (entry.type === "message") {
			// Pi-native: message payload is nested under `message`; tolerate flat.
			const message = (entry.message ?? entry) as Record<string, unknown>;
			const text = extractText(message.content);
			if (text) {
				messages.push({
					entryId: String(entry.id ?? `line-${messages.length}`),
					role: String(message.role ?? ""),
					text,
				});
			}
			continue;
		}

		if (entry.type === "request") {
			const data = entry.data as { body?: { context?: { messages?: unknown } } } | undefined;
			const contextMessages = data?.body?.context?.messages;
			if (!Array.isArray(contextMessages)) continue;
			for (let i = 0; i < contextMessages.length; i++) {
				const message = contextMessages[i] as Record<string, unknown>;
				const text = extractText(message.content);
				if (text) {
					messages.push({ entryId: `request-${i}`, role: String(message.role ?? ""), text });
				}
			}
			continue;
		}

		if (entry.type === "event" || (entry.type === "custom" && entry.customType === "stream_event")) {
			const event = entry.data as { type?: string; contentIndex?: number; delta?: string } | undefined;
			if ((event?.type === "text_delta" || event?.type === "thinking_delta") && typeof event.delta === "string") {
				const idx = event.contentIndex ?? 0;
				const parts = streamParts.get(idx) ?? [];
				parts.push(event.delta);
				streamParts.set(idx, parts);
			}
		}
	}

	for (const [idx, parts] of [...streamParts.entries()].sort((a, b) => a[0] - b[0])) {
		messages.push({ entryId: `stream-${streamIndex++}-${idx}`, role: "assistant", text: parts.join("") });
	}
	return messages;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const p = part as { type?: string; text?: string };
				return p?.type === "text" && typeof p.text === "string" ? p.text : "";
			})
			.join("");
	}
	return "";
}

function splitSentences(text: string): string[] {
	return text
		.split(/[。！？.!?\n]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 10);
}

function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
