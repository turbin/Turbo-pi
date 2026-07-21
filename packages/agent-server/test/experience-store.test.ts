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
});
