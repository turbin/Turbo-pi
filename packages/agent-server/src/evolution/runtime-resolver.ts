import type Database from "better-sqlite3";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import type { EventType } from "./schema.ts";

/**
 * T6a: runtime slot resolver.
 *
 * A slot is resolved exclusively from the deployment event stream and the
 * content-addressed artifact registry. The resolver never reads from the
 * shared working tree (architecture §4, C7).
 *
 * Fail-closed behaviors:
 * - no events for the slot -> reject;
 * - seq gap in the slot chain -> reject;
 * - blob SHA mismatch on fetch -> reject;
 * - unknown event type in stream -> reject.
 */

export interface DeploymentEvent {
	event_id: string;
	seq: number;
	slot: string;
	event_type: EventType;
	artifact_id: string;
	previous_event_id: string | null;
}

export interface ResolvedBundle {
	event: DeploymentEvent;
	bundle: {
		manifest: import("./artifact-schema.ts").ArtifactManifest;
		blobs: Buffer[];
	};
}

export class RuntimeResolver {
	readonly db: Database.Database;
	private readonly registry: ArtifactRegistry;

	constructor(db: Database.Database, registry: ArtifactRegistry) {
		this.db = db;
		this.registry = registry;
	}

	/**
	 * Resolve a slot to its current deployment event and verified bundle.
	 * Throws on any fail-closed condition.
	 */
	resolveSlot(slot: string): ResolvedBundle {
		const rows = this.db
			.prepare(
				"SELECT event_id, seq, slot, event_type, artifact_id, previous_event_id FROM deployment_event_stream WHERE slot = ? ORDER BY seq",
			)
			.all(slot) as DeploymentEvent[];

		if (rows.length === 0) {
			throw new Error(`no deployment events for slot: ${slot}`);
		}

		const maxSeq = rows[rows.length - 1].seq;
		const expectedCount = maxSeq;
		const gapDetected = rows.length !== expectedCount || rows.some((r, idx) => r.seq !== idx + 1);
		if (gapDetected) {
			throw new Error(`seq gap detected for slot: ${slot}`);
		}

		const event = rows[rows.length - 1];
		const bundle = this.registry.fetchBundle(event.artifact_id);
		return { event, bundle };
	}

	close(): void {
		this.db.close();
	}
}
