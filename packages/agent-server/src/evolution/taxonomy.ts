/**
 * T7: failure taxonomy for the evidence plane.
 *
 * Aligned with V3 §8.1. Every recordEvidence input must carry a
 * failure_classification from this list; unknown is the catch-all bucket.
 */

export const FAILURE_TAXONOMY = [
	"environment",
	"model",
	"scaffold",
	"retrieval",
	"experience_content",
	"delivery",
	"judge",
	"unknown",
] as const;

export type FailureTaxonomy = (typeof FAILURE_TAXONOMY)[number];
