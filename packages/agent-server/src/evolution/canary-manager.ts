/**
 * P3-T33: human-approved canary / active promotion and rollback.
 *
 * The canary manager is a thin, auditable wrapper around the promotion
 * controller. It enforces that `canary` and `active` deployment events are
 * only emitted after an explicit human approval, and it provides a single
 * rollback entry point that returns a slot to a previous artifact.
 */

import type { PromotionController, SlotState } from "./promotion-controller.ts";

export interface CanaryApprovalInput {
	/** Sequence number for the event being emitted. */
	seq: number;
	/** Deployment slot being moved. */
	slot: string;
	/** Artifact id that was approved. */
	artifactId: string;
	/** Approver identity (must be non-empty). */
	approver: string;
	/** Reason recorded in the deployment event. */
	reason: string;
	/** Epoch ms timestamp; defaults to wall clock. */
	occurredAt?: number;
}

export interface CanaryResult {
	eventId: string;
	slotState: SlotState;
}

export interface RollbackInput {
	seq: number;
	slot: string;
	/** Artifact id to roll back to. */
	targetArtifactId: string;
	approver: string;
	reason: string;
	occurredAt?: number;
}

export class CanaryManager {
	/**
	 * Request canary promotion: emits `canary_pending_approval` from the
	 * current `shadow` state. The candidate must already have passed the
	 * measurement gate and entered shadow elsewhere.
	 */
	requestCanary(controller: PromotionController, input: CanaryApprovalInput): CanaryResult {
		const current = controller.resolveSlotState(input.slot);
		const eventId = controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "canary_pending_approval",
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.approver,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
		return { eventId, slotState: controller.resolveSlotState(input.slot) };
	}

	/**
	 * Approve a pending canary: emits `canary`. The slot must currently be in
	 * `canary_pending_approval` and reference the same artifact.
	 */
	approveCanary(controller: PromotionController, input: CanaryApprovalInput): CanaryResult {
		const current = controller.resolveSlotState(input.slot);
		if (current.eventType !== "canary_pending_approval") {
			throw new Error(`cannot approve canary: slot ${input.slot} is in state ${current.eventType}`);
		}

		const eventId = controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "canary",
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.approver,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
		return { eventId, slotState: controller.resolveSlotState(input.slot) };
	}

	/**
	 * Request active promotion from canary: emits `active_pending_approval`.
	 */
	requestActive(controller: PromotionController, input: CanaryApprovalInput): CanaryResult {
		const current = controller.resolveSlotState(input.slot);
		if (current.eventType !== "canary") {
			throw new Error(`cannot request active: slot ${input.slot} is in state ${current.eventType}`);
		}

		const eventId = controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "active_pending_approval",
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.approver,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
		return { eventId, slotState: controller.resolveSlotState(input.slot) };
	}

	/**
	 * Approve active promotion: emits `active`.
	 */
	approveActive(controller: PromotionController, input: CanaryApprovalInput): CanaryResult {
		const current = controller.resolveSlotState(input.slot);
		if (current.eventType !== "active_pending_approval") {
			throw new Error(`cannot approve active: slot ${input.slot} is in state ${current.eventType}`);
		}

		const eventId = controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "active",
			artifactId: input.artifactId,
			previousEventId: current.eventId,
			operator: input.approver,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
		return { eventId, slotState: controller.resolveSlotState(input.slot) };
	}

	/**
	 * Roll a slot back to a known-good artifact. The target artifact is
	 * typically the previous active artifact or the generation-0 bundle.
	 */
	rollback(controller: PromotionController, input: RollbackInput): CanaryResult {
		const current = controller.resolveSlotState(input.slot);
		const eventId = controller.emitDeploymentEvent({
			seq: input.seq,
			slot: input.slot,
			eventType: "rollback",
			artifactId: input.targetArtifactId,
			previousEventId: current.eventId,
			previousArtifactId: input.targetArtifactId,
			operator: input.approver,
			reason: input.reason,
			occurredAt: input.occurredAt ?? Date.now(),
		});
		return { eventId, slotState: controller.resolveSlotState(input.slot) };
	}
}
