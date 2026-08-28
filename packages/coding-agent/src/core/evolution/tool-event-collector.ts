/**
 * Tool event collector (Phase 1 evidence plane).
 *
 * Records structured evidence for every tool invocation: which tool ran, a
 * deterministic hash of its canonical arguments and result, how long it took,
 * and whether it errored. The collector is dependency-free apart from
 * node:crypto and keeps events in memory until drained via getEvents().
 */

import { createHash } from "node:crypto";

export interface ToolEvent {
	/** Name of the tool that was invoked. */
	toolName: string;
	/** 64-char lowercase sha256 hex of the canonicalized tool arguments. */
	argsHash: string;
	/** 64-char lowercase sha256 hex of the canonicalized tool result. */
	resultHash: string;
	/** Wall-clock duration of the invocation in milliseconds. */
	durationMs: number;
	/** Error message if the invocation failed; absent on success. */
	error?: string;
	/** Unix epoch milliseconds when the event was recorded. */
	timestamp: number;
}

/**
 * Canonicalizes a value to a deterministic JSON string: object keys are sorted
 * recursively so semantically equal payloads hash identically regardless of
 * key insertion order. Non-JSON-serializable values (undefined, functions,
 * symbols) are stringified.
 */
export function canonicalize(value: unknown): string {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return String(value);
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
	return `{${parts.join(",")}}`;
}

/** Computes the sha256 hex digest of a value's canonical representation. */
export function hashCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export class ToolEventCollector {
	private events: ToolEvent[] = [];

	record(event: ToolEvent): void {
		this.events.push(event);
	}

	/** Returns a shallow copy of all recorded events in record order. */
	getEvents(): ToolEvent[] {
		return [...this.events];
	}
}

export function createToolEventCollector(): ToolEventCollector {
	return new ToolEventCollector();
}
