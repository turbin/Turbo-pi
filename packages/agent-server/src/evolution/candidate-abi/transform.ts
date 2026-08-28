/**
 * P5-1: pure transform function contract for candidate extensions.
 *
 * A candidate transform receives read-only input and a narrow context and
 * returns a serializable output. It MUST NOT perform side effects: no file
 * system access, no network, no subprocesses, no mutation of the context, and
 * no access to host globals. The isolated runner enforces these restrictions
 * at load and execution time (see P5-3).
 */

import type { CandidateCapability } from "./manifest.ts";

/** Context passed to every transform invocation. */
export interface TransformContext {
	/** The capability that selected this transform. */
	readonly capability: CandidateCapability;
	/** Task that produced the failure cluster. */
	readonly taskId: string;
	/** Failure cluster identifier. */
	readonly clusterId: string;
	/** Evidence artifact from which the candidate was generated. */
	readonly evidenceArtifactId: string;
}

/**
 * Candidate transform function signature.
 *
 * Input and output must be JSON-serializable. The function is expected to be
 * pure: the same input/context must produce the same output.
 */
export type CandidateTransform = (input: unknown, context: TransformContext) => unknown;
