import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import type { Experience } from "../src/types.ts";

describe("ExperienceStore", () => {
	it("creates schema and inserts experiences", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const exp: Experience = {
			id: "exp-1",
			type: "EVIDENCE" as const,
			title: "test evidence",
			payload: { text: "hello" },
			quality: 0.8,
			status: "active" as const,
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: "hash-1",
			createdAt: new Date().toISOString(),
		};
		await store.insert(exp);
		const found = await store.getById("exp-1");
		expect(found).toEqual(exp);
	});

	it("returns null for unknown id", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		expect(await store.getById("missing")).toBeNull();
	});

	it("finds experiences via FTS search", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert({
			id: "exp-1",
			type: "SKILL",
			title: "retry flaky tests",
			payload: { text: "rerun vitest with backoff" },
			quality: 0.9,
			status: "active",
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: "hash-1",
			createdAt: new Date().toISOString(),
		});
		await store.insert({
			id: "exp-2",
			type: "SOP",
			title: "release checklist",
			payload: { text: "bump versions and tag" },
			quality: 0.7,
			status: "active",
			sourceSession: "session-2",
			sourceEntryId: "entry-2",
			contentHash: "hash-2",
			createdAt: new Date().toISOString(),
		});
		const results = await store.search("flaky", 10);
		expect(results.map((r) => r.id)).toEqual(["exp-1"]);
	});

	it("excludes dormant and removed rows from FTS search", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const base = {
			type: "EVIDENCE" as const,
			payload: { text: "hello" },
			quality: 0,
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			createdAt: new Date().toISOString(),
		};
		await store.insert({ ...base, id: "exp-active", title: "flaky active", status: "active", contentHash: "h1" });
		await store.insert({ ...base, id: "exp-dormant", title: "flaky dormant", status: "dormant", contentHash: "h2" });
		const results = await store.search("flaky", 10);
		expect(results.map((r) => r.id)).toEqual(["exp-active"]);
	});

	it("looks up rows by contentHash", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert({
			id: "exp-1",
			type: "EVIDENCE",
			title: "test evidence",
			payload: { text: "hello" },
			quality: 0,
			status: "dormant",
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: "hash-abc",
			createdAt: new Date().toISOString(),
		});
		expect((await store.getByContentHash("hash-abc"))?.id).toBe("exp-1");
		expect(await store.getByContentHash("hash-missing")).toBeNull();
	});

	it("promoteToActive flips status and writes back quality", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert({
			id: "exp-1",
			type: "EVIDENCE",
			title: "test evidence",
			payload: { text: "hello" },
			quality: 0,
			status: "dormant",
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: "hash-abc",
			createdAt: new Date().toISOString(),
		});
		await store.promoteToActive("exp-1", 0.9);
		const row = await store.getById("exp-1");
		expect(row?.status).toBe("active");
		expect(row?.quality).toBe(0.9);
	});

	it("removeDormantBefore removes dormant rows older than the cutoff", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const now = Date.now();
		const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
		const insertDormant = (id: string, daysAgo: number) =>
			store.insert({
				id,
				type: "EVIDENCE",
				title: `dormant ${id}`,
				payload: { text: `text ${id}` },
				quality: 0,
				status: "dormant",
				sourceSession: "session-1",
				sourceEntryId: "entry-1",
				contentHash: `hash-${id}`,
				createdAt: iso(daysAgo),
			});
		await insertDormant("d-old", 40);
		await insertDormant("d-new", 1);
		// An old but active row must not be touched.
		await store.insert({
			id: "a-old",
			type: "EVIDENCE",
			title: "active old",
			payload: { text: "text a-old" },
			quality: 0.9,
			status: "active",
			sourceSession: "session-1",
			sourceEntryId: "entry-2",
			contentHash: "hash-a-old",
			createdAt: iso(40),
		});

		const removed = await store.removeDormantBefore(iso(30));
		expect(removed).toBe(1);
		expect((await store.getById("d-old"))?.status).toBe("removed");
		expect((await store.getById("d-new"))?.status).toBe("dormant");
		expect((await store.getById("a-old"))?.status).toBe("active");
	});

	it("removeDormantBefore trims the oldest excess when the dormant count exceeds the cap", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const now = Date.now();
		for (const [i, daysAgo] of [3, 2, 1].entries()) {
			await store.insert({
				id: `d-${i}`,
				type: "EVIDENCE",
				title: `dormant ${i}`,
				payload: { text: `text ${i}` },
				quality: 0,
				status: "dormant",
				sourceSession: "session-1",
				sourceEntryId: "entry-1",
				contentHash: `hash-${i}`,
				createdAt: new Date(now - daysAgo * 86_400_000).toISOString(),
			});
		}

		// Nothing older than the 30-day cutoff; the cap trims d-0 (oldest).
		const removed = await store.removeDormantBefore(new Date(now - 30 * 86_400_000).toISOString(), 2);
		expect(removed).toBe(1);
		expect((await store.getById("d-0"))?.status).toBe("removed");
		expect((await store.getById("d-1"))?.status).toBe("dormant");
		expect((await store.getById("d-2"))?.status).toBe("dormant");
	});

	it("keeps rows removed by a plain status UPDATE out of FTS search", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const now = Date.now();
		await store.insert({
			id: "d-gone",
			type: "EVIDENCE",
			title: "flaky removed candidate",
			payload: { text: "flaky text that stays indexed" },
			quality: 0,
			status: "dormant",
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: "hash-gone",
			createdAt: new Date(now - 40 * 86_400_000).toISOString(),
		});
		await store.insert({
			id: "a-kept",
			type: "EVIDENCE",
			title: "flaky active candidate",
			payload: { text: "flaky active text" },
			quality: 0.9,
			status: "active",
			sourceSession: "session-1",
			sourceEntryId: "entry-2",
			contentHash: "hash-kept",
			createdAt: new Date(now).toISOString(),
		});

		await store.removeDormantBefore(new Date(now - 30 * 86_400_000).toISOString());
		const results = await store.search("flaky", 10);
		expect(results.map((r) => r.id)).toEqual(["a-kept"]);
	});
});
