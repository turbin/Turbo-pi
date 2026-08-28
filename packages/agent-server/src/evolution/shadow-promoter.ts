import { gateShadowPromotion } from "./measurement-gate.ts";
import type { PromotionController, SlotState } from "./promotion-controller.ts";
import type { ReplayResult } from "./replay-validator.ts";

/**
 * P2-T26: shadow-only promotion for M1 experience candidates.
 *
 * Wires the T25 replay verdict to the T5 promotion controller, behind the
 * T27 measurement-credibility gate:
 *
 *   pass + trusted measurement — emit a signed `shadow` deployment event;
 *   reject                   — do not promote (no event appended);
 *   inconclusive             — do not promote (fail closed, A8: unknown data
 *                              never ships);
 *   pass + untrusted measurement (T27 E0/E1 gate: stale/future timestamp,
 *   missing metrics, id mismatch, self-comparison, invalid entries)
 *                            — do not promote; the gate decision is enforced
 *                              here at the promotion entry point, not only by
 *                              the caller.
 *
 * The promoter is deliberately shadow-only: it never emits any event type
 * other than `shadow`, so a promoted candidate cannot reach `active` without
 * the downstream canary/approval chain (state machine §6.3). A rejected
 * verdict also leaves no trace in the event stream — the slot state is
 * exactly what it was before the call.
 *
 * Seq allocation defaults to the slot-local next seq (`slotState.seq + 1`,
 * 1 for a fresh slot) so the slot chain stays contiguous; pass `input.seq`
 * to override (the controller enforces global seq uniqueness).
 */

export interface ShadowPromotionInput {
	/** Artifact id of the candidate experience snapshot. */
	candidateId: string;
	slot: string;
	replayResult: ReplayResult;
	/** Global stream seq; defaults to the slot-local next seq. */
	seq?: number;
	operator?: string;
	reason?: string;
	/** INTEGER epoch ms; defaults to now. */
	occurredAt?: number;
}

export interface ShadowPromotionResult {
	/** Id of the emitted shadow event; null when the gate blocked promotion. */
	eventId: string | null;
	/** Slot state after the decision. */
	slotState: SlotState;
	/** true iff the candidate entered shadow; false iff the gate rejected it. */
	promoted: boolean;
}

/**
 * Decide shadow promotion from the replay verdict and the T27 measurement
 * gate. Never throws on a blocked promotion — rejection is a result, not an
 * error. Errors from the promotion controller (state-machine/CAS/seq
 * violations) propagate.
 */
export function promoteToShadow(
	promotionController: PromotionController,
	input: ShadowPromotionInput,
): Promise<ShadowPromotionResult> {
	const before = promotionController.resolveSlotState(input.slot);

	// A verdict is only valid for the candidate it was computed on; a
	// mismatched replay result must never promote a different artifact.
	if (input.replayResult.candidateId !== input.candidateId) {
		return Promise.resolve({ eventId: null, slotState: before, promoted: false });
	}

	// T27 gate enforced at the promotion entry point: a pass verdict only
	// promotes when the measurement behind it is credible. A replay result
	// without a baseline cannot be verified — fail closed.
	const baselineId = input.replayResult.baselineId;
	if (baselineId === null || !gateShadowPromotion(input.replayResult, baselineId, input.candidateId)) {
		return Promise.resolve({ eventId: null, slotState: before, promoted: false });
	}

	const eventId = promotionController.emitDeploymentEvent({
		seq: input.seq ?? (before.seq ?? 0) + 1,
		slot: input.slot,
		eventType: "shadow",
		artifactId: input.candidateId,
		previousEventId: before.eventId,
		operator: input.operator ?? "draft",
		reason: input.reason ?? `replay verdict pass; promote candidate ${input.candidateId} to shadow`,
		occurredAt: input.occurredAt ?? Date.now(),
	});

	return Promise.resolve({
		eventId,
		slotState: promotionController.resolveSlotState(input.slot),
		promoted: true,
	});
}
