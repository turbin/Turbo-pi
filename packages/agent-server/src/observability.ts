import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RetrievedExperience } from "./types.ts";

/**
 * Request-level observability helpers (O spec R3).
 *
 * Local/remote attribution rule: the ids/kinds logged at phase=retrieval are
 * the LOCAL experience-store content injected into this request; the response
 * content logged at phase=done is produced by the REMOTE LLM. The request id
 * ties log lines, the session JSONL (header metadata.requestId), the
 * request_traces row, and the x-request-id response header together.
 */

/** "TYPE:role" kind strings for retrieved experiences, e.g. "ABILITY:Method". */
export function kindsOf(retrieved: RetrievedExperience[]): string[] {
	return retrieved.map((r) => {
		const role = (r.experience.payload as Record<string, unknown>).role;
		return `${r.experience.type}:${typeof role === "string" && role ? role : "null"}`;
	});
}

/** Human-readable Chinese labels for kind strings (logs/stats page). */
const KIND_LABELS: Record<string, string> = {
	"ABILITY:Method": "方法",
	"ABILITY:Guard": "护栏",
	"EVIDENCE:null": "证据",
	"EVIDENCE:Workflow": "工作流",
	"SKILL:null": "技能",
	"SOP:null": "SOP",
};

/** Kind strings → compact Chinese summary, e.g. "方法×7,证据×1". */
export function summarizeKinds(kinds: string[]): string {
	const counts = new Map<string, number>();
	for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	return [...counts.entries()].map(([kind, cnt]) => `${KIND_LABELS[kind] ?? kind}×${cnt}`).join(",");
}

/** Titles of retrieved experiences for the trace log: first `max` + overflow count. */
export function titlesOf(retrieved: RetrievedExperience[], max = 3): string {
	const titles = retrieved.slice(0, max).map((r) => r.experience.title);
	const rest = retrieved.length - titles.length;
	return rest > 0 ? `${titles.join("; ")} 等${retrieved.length}条` : titles.join("; ");
}

/**
 * Optional file sink for trace logs (web monitor /api/logs). Set once at
 * server startup; stdout logging continues regardless (container discipline).
 */
let logFilePath: string | null = null;

export function setLogFile(path: string): void {
	logFilePath = path;
}

/** One structured trace log line on stdout (container logs stay parseable). */
export function logTrace(requestId: string, phase: string, fields: Record<string, unknown> = {}): void {
	const parts = Object.entries(fields)
		.map(([k, v]) => `${k}=${typeof v === "string" && v.includes(" ") ? JSON.stringify(v) : String(v)}`)
		.join(" ");
	const line = `[agent-server] req=${requestId} phase=${phase}${parts ? ` ${parts}` : ""}`;
	console.log(line);
	if (logFilePath) {
		try {
			mkdirSync(dirname(logFilePath), { recursive: true });
			appendFileSync(logFilePath, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Logging must never break a request.
		}
	}
}
