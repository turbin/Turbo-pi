import { describe, expect, it } from "vitest";
import { summarizeKinds, titlesOf } from "../src/observability.ts";
import type { Experience } from "../src/types.ts";

function exp(title: string, type: Experience["type"] = "ABILITY", role?: string): { experience: Experience; score: number } {
	return {
		experience: {
			id: title,
			type,
			title,
			payload: role ? { role } : {},
			quality: 0.7,
			status: "active",
			sourceSession: "",
			sourceEntryId: "",
			contentHash: title,
			createdAt: "2026-07-27T00:00:00Z",
		},
		score: 1,
	};
}

describe("summarizeKinds", () => {
	it("maps kind strings to Chinese labels with counts", () => {
		const kinds = [
			"EVIDENCE:null",
			...Array(7).fill("ABILITY:Method"),
		] as string[];
		expect(summarizeKinds(kinds)).toBe("证据×1,方法×7");
	});

	it("keeps insertion order and falls back to raw kind for unknown values", () => {
		expect(summarizeKinds(["ABILITY:Guard", "SOP:null", "X:Y"])).toBe("护栏×1,SOP×1,X:Y×1");
	});

	it("returns empty string for no kinds", () => {
		expect(summarizeKinds([])).toBe("");
	});
});

describe("titlesOf", () => {
	it("lists titles up to max with overflow count", () => {
		const retrieved = [
			exp("Idempotent Retry with Bounded Exponential Backoff"),
			exp("Brief Contrastive Explanation"),
			exp("Scope Code Review Framework"),
			exp("One More Method"),
		];
		expect(titlesOf(retrieved)).toBe(
			"Idempotent Retry with Bounded Exponential Backoff; Brief Contrastive Explanation; Scope Code Review Framework 等4条",
		);
	});

	it("lists all titles when within max", () => {
		expect(titlesOf([exp("A"), exp("B")])).toBe("A; B");
	});

	it("returns empty string for empty input", () => {
		expect(titlesOf([])).toBe("");
	});
});
