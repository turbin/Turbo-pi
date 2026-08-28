/**
 * Frozen shadow task-level detector v1 (rule-based).
 *
 * This module is intentionally side-effect-free. It takes a task trajectory
 * (turns + tool events), the current scaffold contract, and the original user
 * task, and returns read-only detector signals with confidence scores and
 * evidence references.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

function canonicalizeValue(value: unknown): string {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return String(value);
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`);
	return `{${parts.join(",")}}`;
}

export function canonicalizeForDetector(value: unknown): string {
	return canonicalizeValue(value);
}

/**
 * Browser-safe deterministic 64-bit hash of a canonical value. Not
 * cryptographically secure; used only for progress-stall detection.
 */
export function hashCanonicalForDetector(value: unknown): string {
	return cyrb53Hex(canonicalizeValue(value));
}

function cyrb53Hex(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2_654_435_761);
		h2 = Math.imul(h2 ^ ch, 1_597_334_677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export type TaskLevelDetectorSignalName =
	| "progressStalled"
	| "repeatedToolFailure"
	| "deliveryMissing"
	| "escalationRecommended";

export interface TaskLevelDetectorSignal {
	name: TaskLevelDetectorSignalName;
	/** Confidence in [0, 1]. */
	confidence: number;
	/** Stable references to the evidence that produced the signal. */
	evidenceRefs: string[];
}

export interface TaskLevelDetectorSnapshot {
	/** Detector version that produced the snapshot. */
	version: string;
	/** Signals computed for the task. */
	signals: TaskLevelDetectorSignal[];
	/** True when escalation is recommended. */
	recommended: boolean;
	/** Original user task text. */
	originalTask: string;
	/** Timestamp when the snapshot was computed. */
	computedAt: number;
}

export interface TaskLevelDetectorScaffold {
	/** "off" or undefined disables the detector; "v1-rule" enables v1 rules. */
	taskLevelDetectorVersion: string | undefined;
	/** Consecutive failure threshold for `repeatedToolFailure`. */
	repeatedFailureThreshold?: number;
	/** Minimum confidence required to trigger `escalationRecommended`. */
	escalationConfidenceThreshold?: number;
}

export interface TaskLevelDetectorToolEvent {
	toolName: string;
	/** Deterministic hash of canonical tool arguments. */
	argsHash: string;
	/** Deterministic hash of canonical tool result. */
	resultHash: string;
	/** Error message if the tool invocation failed. */
	error?: string;
}

export interface TaskLevelDetectorTurn {
	/** Assistant message that ended the turn. */
	assistantMessage: AgentMessage;
	/** Tool call IDs executed in this turn, when available. */
	toolCallIds?: string[];
}

export interface TaskLevelDetectorInput {
	originalTask: string;
	turns: TaskLevelDetectorTurn[];
	toolEvents: TaskLevelDetectorToolEvent[];
	scaffold: TaskLevelDetectorScaffold;
}

const DEFAULT_REPEATED_FAILURE_THRESHOLD = 2;
const DEFAULT_ESCALATION_CONFIDENCE_THRESHOLD = 0.5;

function isDeliverableContent(message: AgentMessage): boolean {
	if (message.role !== "assistant") {
		return false;
	}

	const assistantMessage = message as AssistantMessage;
	const content = assistantMessage.content;
	if (!Array.isArray(content)) {
		return false;
	}

	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const typed = block as { type?: string; text?: unknown };
		if (typed.type === "text") {
			const text = typeof typed.text === "string" ? typed.text : "";
			if (text.trim().length > 0) {
				return true;
			}
		} else if (typed.type === "thinking" || typed.type === "file") {
			return true;
		}
	}

	return false;
}

function dedupeSortedRefs(refs: string[]): string[] {
	return [...new Set(refs)];
}

/**
 * Pure rule-based detector. Returns a snapshot with zero or more signals.
 */
export function computeTaskLevelDetectorSnapshot(input: TaskLevelDetectorInput): TaskLevelDetectorSnapshot {
	const version = input.scaffold.taskLevelDetectorVersion ?? "off";

	if (version === "off" || version.length === 0) {
		return {
			version,
			signals: [],
			recommended: false,
			originalTask: input.originalTask,
			computedAt: Date.now(),
		};
	}

	const failureThreshold = input.scaffold.repeatedFailureThreshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
	const escalationThreshold = input.scaffold.escalationConfidenceThreshold ?? DEFAULT_ESCALATION_CONFIDENCE_THRESHOLD;
	const signals: TaskLevelDetectorSignal[] = [];
	const toolEvents = input.toolEvents;

	// Repeated tool failure: same tool name failing N times consecutively.
	for (let i = 0; i < toolEvents.length; ) {
		const event = toolEvents[i];
		if (event.error === undefined) {
			i++;
			continue;
		}

		let j = i;
		while (j < toolEvents.length && toolEvents[j].toolName === event.toolName && toolEvents[j].error !== undefined) {
			j++;
		}

		const streak = j - i;
		if (streak >= failureThreshold) {
			const refs: string[] = [];
			for (let k = i; k < j; k++) {
				refs.push(`tool_event:${k}`);
			}
			signals.push({
				name: "repeatedToolFailure",
				confidence: 1,
				evidenceRefs: refs,
			});
		}
		i = j;
	}

	// Progress stalled: consecutive tool events with the same args hash.
	let maxRepeatRun = 1;
	let currentRepeatRun = 1;
	const stalledRefs: string[] = [];
	for (let i = 1; i < toolEvents.length; i++) {
		if (toolEvents[i].argsHash === toolEvents[i - 1].argsHash) {
			currentRepeatRun++;
			stalledRefs.push(`tool_event:${i - 1}`, `tool_event:${i}`);
		} else {
			currentRepeatRun = 1;
		}
		if (currentRepeatRun > maxRepeatRun) {
			maxRepeatRun = currentRepeatRun;
		}
	}
	if (maxRepeatRun >= 2) {
		signals.push({
			name: "progressStalled",
			confidence: Math.min(1, maxRepeatRun / 3),
			evidenceRefs: dedupeSortedRefs(stalledRefs),
		});
	}

	// Delivery missing: after at least one tool event, the final assistant message
	// has no deliverable content (text / thinking / file).
	if (toolEvents.length > 0 && input.turns.length > 0) {
		const finalTurn = input.turns[input.turns.length - 1];
		if (finalTurn && !isDeliverableContent(finalTurn.assistantMessage)) {
			signals.push({
				name: "deliveryMissing",
				confidence: 1,
				evidenceRefs: [`turn:${input.turns.length - 1}`],
			});
		}
	}

	// Escalation recommended: any signal above the confidence threshold.
	const causalSignals = signals.filter((signal) => signal.name !== "escalationRecommended");
	const maxConfidence = causalSignals.length > 0 ? Math.max(...causalSignals.map((signal) => signal.confidence)) : 0;
	if (maxConfidence > escalationThreshold) {
		signals.push({
			name: "escalationRecommended",
			confidence: maxConfidence,
			evidenceRefs: dedupeSortedRefs(causalSignals.flatMap((signal) => signal.evidenceRefs)),
		});
	}

	return {
		version,
		signals,
		recommended: signals.some((signal) => signal.name === "escalationRecommended"),
		originalTask: input.originalTask,
		computedAt: Date.now(),
	};
}

export interface TaskLevelDetector {
	/** Replace the accumulated trajectory with a fresh one. */
	reset(): void;
	/** Set the original user task text (only the first non-empty call sticks). */
	setOriginalTask(text: string): void;
	/** Record a tool event from the trajectory. */
	recordToolEvent(event: TaskLevelDetectorToolEvent): void;
	/** Record the assistant message that ended a turn. */
	recordTurnEnd(turn: TaskLevelDetectorTurn): void;
	/** Compute the current detector snapshot from the accumulated trajectory. */
	getSnapshot(scaffold: TaskLevelDetectorScaffold): TaskLevelDetectorSnapshot;
}

class TaskLevelDetectorImpl implements TaskLevelDetector {
	private originalTask = "";
	private readonly turns: TaskLevelDetectorTurn[] = [];
	private readonly toolEvents: TaskLevelDetectorToolEvent[] = [];

	reset(): void {
		this.originalTask = "";
		this.turns.length = 0;
		this.toolEvents.length = 0;
	}

	setOriginalTask(text: string): void {
		if (this.originalTask.length === 0 && text.trim().length > 0) {
			this.originalTask = text.trim();
		}
	}

	recordToolEvent(event: TaskLevelDetectorToolEvent): void {
		this.toolEvents.push(event);
	}

	recordTurnEnd(turn: TaskLevelDetectorTurn): void {
		this.turns.push(turn);
	}

	getSnapshot(scaffold: TaskLevelDetectorScaffold): TaskLevelDetectorSnapshot {
		return computeTaskLevelDetectorSnapshot({
			originalTask: this.originalTask,
			turns: [...this.turns],
			toolEvents: [...this.toolEvents],
			scaffold,
		});
	}
}

export function createTaskLevelDetector(): TaskLevelDetector {
	return new TaskLevelDetectorImpl();
}
