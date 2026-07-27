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

/** One structured trace log line on stdout (container logs stay parseable). */
export function logTrace(requestId: string, phase: string, fields: Record<string, unknown> = {}): void {
	const parts = Object.entries(fields)
		.map(([k, v]) => `${k}=${typeof v === "string" && v.includes(" ") ? JSON.stringify(v) : String(v)}`)
		.join(" ");
	console.log(`[agent-server] req=${requestId} phase=${phase}${parts ? ` ${parts}` : ""}`);
}
