import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { retrieve } from "../src/retrieval.ts";
import type { Experience } from "../src/types.ts";

function makeExp(id: string, title: string, text: string): Experience {
	return {
		id,
		type: "SKILL",
		title,
		payload: { text },
		quality: 0.8,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: `entry-${id}`,
		contentHash: `hash-${id}`,
		createdAt: new Date().toISOString(),
	};
}

async function seededStore(exps: Experience[]): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	for (const exp of exps) {
		await store.insert(exp);
	}
	return store;
}

describe("retrieve", () => {
	it("returns top experiences by FTS then cosine re-rank", async () => {
		// CJK test data contains the query string "量子计算" contiguously;
		// unicode61 stores a CJK run as one token, so retrieval relies on
		// the prefix query built in buildFtsQuery.
		const store = await seededStore([
			makeExp("exp-1", "量子计算入门指南", "量子计算 的 量子计算 实验 与 量子计算 应用"),
			makeExp("exp-2", "量子计算进阶", "量子计算 算法"),
			makeExp("exp-3", "量子计算", "简介"),
			makeExp("exp-4", "release checklist", "bump versions and tag"),
		]);
		const results = await retrieve(store, "量子计算", 3);
		expect(results).toHaveLength(3);
		expect(results.map((r) => r.experience.id)).not.toContain("exp-4");
		// exp-3 is the shortest text fully overlapping the query: highest cosine.
		expect(results[0].experience.id).toBe("exp-3");
		expect(results[0].score).toBeGreaterThan(results[1].score);
		expect(results[1].score).toBeGreaterThan(results[2].score);
	});

	it("matches a CJK query inside a longer contiguous ideograph run", async () => {
		const store = await seededStore([makeExp("exp-1", "量子计算入门指南", "前置知识")]);
		const results = await retrieve(store, "量子计算", 5);
		expect(results.map((r) => r.experience.id)).toEqual(["exp-1"]);
	});

	it("re-ranks English candidates by cosine score", async () => {
		const store = await seededStore([
			makeExp("exp-1", "retry flaky tests", "rerun vitest with backoff on flaky failures"),
			makeExp("exp-2", "flaky deploys", "flaky"),
			makeExp("exp-3", "release checklist", "bump versions and tag"),
		]);
		const results = await retrieve(store, "flaky", 2);
		expect(results).toHaveLength(2);
		expect(results[0].experience.id).toBe("exp-2");
		expect(results[0].score).toBeGreaterThan(results[1].score);
	});

	it("returns an empty array when nothing matches", async () => {
		const store = await seededStore([makeExp("exp-1", "retry flaky tests", "rerun vitest")]);
		expect(await retrieve(store, "非存在话题", 3)).toEqual([]);
	});

	it("returns an empty array for a query with no searchable tokens", async () => {
		const store = await seededStore([makeExp("exp-1", "retry flaky tests", "rerun vitest")]);
		expect(await retrieve(store, "!!! ---", 3)).toEqual([]);
	});

	it("does not throw on FTS5 special characters in the query", async () => {
		const store = await seededStore([makeExp("exp-1", "retry flaky tests", "rerun vitest")]);
		const results = await retrieve(store, '"flaky" OR (tests: NEAR)', 3);
		expect(results.length).toBeGreaterThan(0);
	});

	it("respects the limit", async () => {
		const store = await seededStore([
			makeExp("exp-1", "量子计算 一", "量子计算"),
			makeExp("exp-2", "量子计算 二", "量子计算"),
			makeExp("exp-3", "量子计算 三", "量子计算"),
		]);
		expect(await retrieve(store, "量子计算", 2)).toHaveLength(2);
	});
});
