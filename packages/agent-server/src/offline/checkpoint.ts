import { createHash } from "node:crypto";
import type { Checkpoint, ExperienceStore } from "../experience-store.ts";

/**
 * Checkpoint write/read-back for the offline evolution flow (SPEC §4.2 step 6,
 * §7 `checkpoints` table). A checkpoint records that one offline run completed:
 * after it is written, the promoted experiences of that run are the active set,
 * and the previous checkpoint remains in the table for rollback/inspection
 * (SPEC §9: on failure the previous checkpoint is kept — the new one is simply
 * never written).
 *
 * Storage lives in the ExperienceStore database so checkpoints and the
 * experiences they describe share one file and one backup/migration story.
 */

export interface CheckpointInput {
	/** Checkpoint stream name; the offline evolution flow uses "evolution". */
	kind: string;
	/** Run timestamp in ms (caller-supplied so tests can fix it). */
	epoch: number;
	/** Headline metric of the run (entries promoted to active). */
	metric: number;
	/** JSON blob with full run details (ETL count, pipeline counts, ...). */
	snapshot: string;
}

/**
 * Write a checkpoint row and return its id. The id is deterministic: a sha256
 * of (kind, epoch, snapshot) joined with explicit separators, so distinct
 * inputs can never collide through concatenation. Re-writing the same
 * checkpoint id is a no-op success (retry-safe: same id means same content).
 */
export async function writeCheckpoint(store: ExperienceStore, input: CheckpointInput): Promise<string> {
	const hashInput = `${input.kind}:${input.epoch}:${input.snapshot}`;
	const id = `ckpt-${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`;
	await store.insertCheckpoint({ id, ...input, createdAt: new Date().toISOString() });
	return id;
}

/** Read a checkpoint back by id; null when it does not exist. */
export async function readCheckpoint(store: ExperienceStore, id: string): Promise<Checkpoint | null> {
	return store.getCheckpoint(id);
}

/** Latest checkpoint of a kind by epoch; null when none was ever written. */
export async function latestCheckpoint(store: ExperienceStore, kind: string): Promise<Checkpoint | null> {
	return store.getLatestCheckpoint(kind);
}
