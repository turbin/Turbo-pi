import type Database from "better-sqlite3";
import { AppendOnlyDao, type DeploymentEventInput } from "./append-only-dao.ts";
import type { DevAuditWriter } from "./audit-writer.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { EVENT_TYPES, type EventType } from "./schema.ts";

/**
 * T5: promotion controller + deployment event stream.
 *
 * Responsibilities:
 * - enforce the state machine (architecture §6.3);
 * - enforce CAS (previous_event_id matches the current chain head);
 * - enforce global seq uniqueness and monotonicity;
 * - sign every event with the audit writer key;
 * - derive slot state from max(seq) per slot (D4: no mutable status column);
 * - detect seq gaps and mark the slot fail-closed (A8).
 */

const FIRST_EVENT_TYPES: readonly EventType[] = ["shadow"];

const VALID_TRANSITIONS: Record<EventType | "__start__", readonly EventType[]> = {
	__start__: ["shadow"],
	shadow: ["canary_pending_approval", "quarantine", "reject"],
	canary_pending_approval: ["canary", "rollback", "quarantine", "reject"],
	canary: ["active_pending_approval", "rollback", "quarantine", "reject"],
	active_pending_approval: ["active", "quarantine", "reject"],
	active: ["rollback", "quarantine", "reject"],
	rollback: ["shadow", "quarantine", "reject"],
	quarantine: ["shadow", "quarantine", "reject"],
	reject: ["shadow", "quarantine", "reject"],
};

export interface SlotState {
	eventId: string | null;
	eventType: EventType | "unknown";
	seq: number | null;
	gapDetected: boolean;
}

export class PromotionController {
	readonly db: Database.Database;
	private readonly dao: AppendOnlyDao;
	private readonly auditWriter: DevAuditWriter;

	constructor(db: Database.Database, auditWriter: DevAuditWriter) {
		this.db = db;
		this.dao = new AppendOnlyDao(db);
		this.auditWriter = auditWriter;
	}

	/**
	 * Emit a signed deployment event. Throws on any contract violation so the
	 * caller cannot append an invalid event (fail closed, A8).
	 */
	emitDeploymentEvent(input: Omit<DeploymentEventInput, "eventId" | "keyId" | "signature">): string {
		if (!EVENT_TYPES.includes(input.eventType)) {
			throw new Error(`invalid event_type: ${input.eventType}`);
		}

		const slotState = this.resolveSlotState(input.slot);
		const isFirstEvent = slotState.eventId === null;

		if (isFirstEvent) {
			if (input.previousEventId !== null && input.previousEventId !== undefined) {
				throw new Error("first event must have previous_event_id=null");
			}
			if (!FIRST_EVENT_TYPES.includes(input.eventType)) {
				throw new Error(`invalid state transition: __start__ -> ${input.eventType}`);
			}
		} else {
			if (input.previousEventId !== slotState.eventId) {
				throw new Error(
					`previous_event_id mismatch: expected ${slotState.eventId}, received ${input.previousEventId}`,
				);
			}
			const from = slotState.eventType as EventType;
			const allowed = VALID_TRANSITIONS[from] ?? [];
			if (!allowed.includes(input.eventType)) {
				throw new Error(`invalid state transition: ${from} -> ${input.eventType}`);
			}
		}

		const existingSeq = this.db.prepare("SELECT seq FROM deployment_event_stream WHERE seq = ?").get(input.seq) as
			| { seq: number }
			| undefined;
		if (existingSeq) {
			throw new Error(`seq already exists: ${input.seq}`);
		}

		const payload = canonicalJson({
			seq: input.seq,
			slot: input.slot,
			event_type: input.eventType,
			artifact_id: input.artifactId,
			previous_event_id: input.previousEventId ?? null,
			previous_artifact_id: input.previousArtifactId ?? null,
			operator: input.operator,
			reason: input.reason,
			occurred_at: input.occurredAt,
		});
		const eventId = sha256Hex(payload);
		const { signature, keyId } = this.auditWriter.signString(payload);

		this.dao.appendEvent({
			...input,
			eventId,
			keyId,
			signature,
			previousEventId: input.previousEventId ?? null,
			previousArtifactId: input.previousArtifactId ?? null,
		});
		return eventId;
	}

	/**
	 * Derive the current state of a slot from the event stream.
	 * Slot state = max(seq) event for that slot. If a seq gap is detected
	 * (any missing integer between 1 and max), the slot is marked unknown and
	 * fail-closed (A8).
	 */
	resolveSlotState(slot: string): SlotState {
		const rows = this.db
			.prepare("SELECT event_id, seq, event_type FROM deployment_event_stream WHERE slot = ? ORDER BY seq")
			.all(slot) as Array<{ event_id: string; seq: number; event_type: EventType }>;

		if (rows.length === 0) {
			return { eventId: null, eventType: "unknown", seq: null, gapDetected: false };
		}

		const maxSeq = rows[rows.length - 1].seq;
		const expectedCount = maxSeq;
		const gapDetected = rows.length !== expectedCount || rows.some((r, idx) => r.seq !== idx + 1);
		if (gapDetected) {
			return { eventId: null, eventType: "unknown", seq: null, gapDetected: true };
		}

		const head = rows[rows.length - 1];
		return { eventId: head.event_id, eventType: head.event_type, seq: head.seq, gapDetected: false };
	}

	close(): void {
		this.db.close();
	}
}
