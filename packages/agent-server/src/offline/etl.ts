import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExperienceStore } from "../experience-store.ts";
import { domainForTask } from "./task-domain.ts";

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
 *    `{role, content}` message entry is also tolerated. Completed streams
 *    additionally carry the gateway reply as a reconstructed assistant
 *    `message` entry; streams that errored or were aborted (and files
 *    written before that change) carry it only in `{type:"custom",
 *    customType:"stream_event", data}` entries, whose
 *    `text_delta`/`thinking_delta` payloads are reassembled per
 *    contentIndex into one assistant message. When both exist, the
 *    `message` entry wins and the matching stream parts are skipped so
 *    the same reply text is mined exactly once.
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

/**
 * ETL 结果（台账 7/T6）：inserted = 摄入条数；isolated = 因 session 完整性
 * 校验失败而被整体隔离的文件路径列表（半截 session 不摄入）。
 */
export interface EtlResult {
	inserted: number;
	/** 不完整（半截）session 文件路径——有 session 头但无流闭合标记。 */
	isolated: string[];
}

/**
 * 完整性判据（pi-native）：session 头 + 流闭合标记（response_completed /
 * error / aborted custom entry）齐全 = 完整；有头无闭合 = 半截（落盘中断）；
 * 无头文件（legacy P0 格式）无完整性信号，返回 (true, legacy)。
 */
export function sessionCompleteness(path: string): { complete: boolean; reason: string } {
	let hasHeader = false;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // malformed 行跳过（行级语义不变）
		}
		if (entry.type === "session") {
			hasHeader = true;
			continue;
		}
		if (entry.type === "custom") {
			const kind = entry.customType;
			if (kind === "response_completed" || kind === "error" || kind === "aborted") {
				return { complete: true, reason: "" };
			}
		}
	}
	if (!hasHeader) return { complete: true, reason: "legacy-format-without-session-header" };
	return { complete: false, reason: "missing closure marker (response_completed/error/aborted)" };
}

export async function etlSessionFiles(paths: string[], store: ExperienceStore): Promise<EtlResult> {
	let inserted = 0;
	const isolated: string[] = [];
	for (const path of paths) {
		// 台账 7（T6）：摄入前完整性校验——半截 session 整体隔离不摄入。
		const completeness = sessionCompleteness(path);
		if (!completeness.complete) {
			isolated.push(path);
			continue;
		}
		// F3 (T4): ETL 打标路径——EVIDENCE 直插不经蒸馏，摄入时按 session 所属
		// 任务打域（复用 M1 task_id 透传 + 任务→域注册表）。
		const domain = domainForTask(sessionTaskId(path));
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
						// F3 (T4): domain 空串 = 无标签（检索不过滤，向后兼容存量卡）。
						domain,
					},
					quality: 0,
					confidence: 0.5,
					rescoreExcludedBatches: 0,
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
	return { inserted, isolated };
}

/** 读 session 头 metadata.task_id（F0 透传的任务归属键）。 */
function sessionTaskId(path: string): string {
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "session") {
			const meta = (entry.metadata ?? {}) as Record<string, unknown>;
			const taskId =
				typeof meta.task_id === "string" ? meta.task_id : typeof meta.taskId === "string" ? meta.taskId : "";
			return taskId;
		}
	}
	return "";
}

function extractMessages(path: string): ExtractedMessage[] {
	const messages: ExtractedMessage[] = [];
	// Reassembled streamed text from stream_event custom entries (and legacy `event` entries).
	const streamParts = new Map<number, string[]>();
	let streamIndex = 0;
	// Text of assistant `message` entries, used to skip stream parts that a
	// reconstructed reply message already covers (mined exactly once).
	const assistantMessageTexts: string[] = [];

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
				const role = String(message.role ?? "");
				if (role === "assistant") assistantMessageTexts.push(text);
				messages.push({
					entryId: String(entry.id ?? `line-${messages.length}`),
					role,
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
		const text = parts.join("");
		// Skip stream parts already covered by a reconstructed assistant
		// `message` entry; mine them only for sessions lacking it (error/aborted
		// streams, old files). Thinking deltas never match (message text parts
		// exclude thinking), so they are still mined from the stream.
		if (assistantMessageTexts.some((messageText) => messageText.includes(text))) continue;
		messages.push({ entryId: `stream-${streamIndex++}-${idx}`, role: "assistant", text });
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
