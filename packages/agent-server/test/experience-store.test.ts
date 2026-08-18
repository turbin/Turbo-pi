import { copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperienceStore, tokenizeForFts } from "../src/experience-store.ts";
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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

	// M10 (adversarial review 2026-08-09): snapshot mode — reads (search /
	// listActive / getById) come from a frozen copy; writes still go to the
	// live database. A batch run started with a snapshot is immune to
	// mid-run library writes changing the retrieval behavior.
	it("snapshot mode freezes reads while writes stay live (M10)", async () => {
		const livePath = join(tmpdir(), `live-${Date.now()}-${Math.random()}.db`);
		const snapPath = join(tmpdir(), `snap-${Date.now()}-${Math.random()}.db`);
		try {
			const live = new ExperienceStore(livePath);
			await live.initSchema();
			const before: Experience = {
				id: "exp-before-snapshot",
				type: "EVIDENCE" as const,
				title: "frozen evidence",
				payload: { text: "hello" },
				quality: 0.8,
				confidence: 0.5,
				rescoreExcludedBatches: 0,
				status: "active" as const,
				sourceSession: "session-1",
				sourceEntryId: "entry-1",
				contentHash: "hash-before",
				createdAt: new Date().toISOString(),
			};
			await live.insert(before);

			// Freeze: copy the live db, then keep writing to it.
			copyFileSync(livePath, snapPath);
			const after: Experience = {
				id: "exp-after-snapshot",
				type: "EVIDENCE" as const,
				title: "post-snapshot evidence",
				payload: { text: "world" },
				quality: 0.9,
				confidence: 0.5,
				rescoreExcludedBatches: 0,
				status: "active" as const,
				sourceSession: "session-2",
				sourceEntryId: "entry-2",
				contentHash: "hash-after",
				createdAt: new Date().toISOString(),
			};
			await live.insert(after);

			// Snapshot-mode store: RETRIEVAL reads (search) frozen at the copy;
			// write-path queries (getById) and writes go to live (issue-006).
			const snap = new ExperienceStore(livePath, { snapshotPath: snapPath });
			await snap.initSchema();
			expect((await snap.search("hello", 10)).map((e) => e.id)).toEqual(["exp-before-snapshot"]);
			expect(await snap.search("world", 10)).toHaveLength(0); // frozen: after-snapshot invisible

			// Writes still land in the live db (learning loop keeps working).
			const written: Experience = { ...after, id: "exp-via-snapshot-store", contentHash: "hash-via" };
			await snap.insert(written);
			const verify = new ExperienceStore(livePath);
			await verify.initSchema();
			expect(await verify.getById("exp-via-snapshot-store")).not.toBeNull();
			// 写路径去重查询读 live：快照模式也必须能查到 live 新写入（issue-006）。
			expect(await snap.getById("exp-after-snapshot")).not.toBeNull();
			expect(await snap.getByContentHash("hash-after")).not.toBeNull();
			expect(await snap.search("world", 10)).toHaveLength(0); // 检索仍冻结
		} finally {
			rmSync(livePath, { force: true });
			rmSync(snapPath, { force: true });
		}
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
				confidence: 0.5,
				rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
				confidence: 0.5,
				rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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
			confidence: 0.5,
			rescoreExcludedBatches: 0,
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

// ---------------------------------------------------------------------------
// N1: FTS tokenizer fix — Latin whole words + CJK char/bigram
// ---------------------------------------------------------------------------

describe("N1: FTS search for Latin body text (tokenizeForFts fix)", () => {
	function makeExp(overrides: Partial<Experience> & Pick<Experience, "id" | "title" | "payload">): Experience {
		return {
			type: "EVIDENCE",
			quality: 0.8,
			confidence: 0.5,
			rescoreExcludedBatches: 0,
			status: "active",
			sourceSession: "session-1",
			sourceEntryId: "entry-1",
			contentHash: `hash-${overrides.id}`,
			createdAt: new Date().toISOString(),
			...overrides,
		};
	}

	it("#1 EVIDENCE body word 'idempotent' (not in title) is searchable", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-1",
				title: "Note",
				payload: { text: "The retry logic must be idempotent to avoid duplicates" },
			}),
		);
		const results = await store.search('"idempotent"', 10);
		expect(results.map((r) => r.id)).toContain("n1-1");
	});

	it("#2 ABILITY body words 'backoff' and 'jitter' (not in title) are each searchable", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-2",
				type: "ABILITY",
				title: "Retry strategy",
				payload: { text: "Use exponential backoff with jitter between retries" },
			}),
		);
		const backoffHits = await store.search('"backoff"', 10);
		expect(backoffHits.map((r) => r.id)).toContain("n1-2");
		const jitterHits = await store.search('"jitter"', 10);
		expect(jitterHits.map((r) => r.id)).toContain("n1-2");
	});

	it("#3 CJK body text '量子计算' (not in title) is searchable — no regression", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-3",
				title: "Tech note",
				payload: { text: "量子计算是未来的重要方向" },
			}),
		);
		const results = await store.search('"量子"', 10);
		expect(results.map((r) => r.id)).toContain("n1-3");
	});

	it("#4 mixed CJK+Latin body: backoff, flaky, and CJK prefix query all hit", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-4",
				title: "Mixed note",
				payload: { text: "使用 backoff 策略处理 flaky API" },
			}),
		);
		const backoffHits = await store.search('"backoff"', 10);
		expect(backoffHits.map((r) => r.id)).toContain("n1-4");
		const flakyHits = await store.search('"flaky"', 10);
		expect(flakyHits.map((r) => r.id)).toContain("n1-4");
		// CJK prefix query: "策略" stored as char+bigram, prefix match with *
		const cjkHits = await store.search('"策略"*', 10);
		expect(cjkHits.map((r) => r.id)).toContain("n1-4");
	});

	it("#5a payload.text missing — insert does not throw, unrelated query does not hit", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-5a",
				title: "No text entry",
				payload: { other: "data" },
			}),
		);
		const results = await store.search('"nonexistent"', 10);
		expect(results.map((r) => r.id)).not.toContain("n1-5a");
	});

	it("#5b payload.text empty string — insert does not throw", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-5b",
				title: "Empty text entry",
				payload: { text: "" },
			}),
		);
		const results = await store.search('"nonexistent"', 10);
		expect(results.map((r) => r.id)).not.toContain("n1-5b");
	});

	it("#5c payload.text pure punctuation — insert does not throw", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "n1-5c",
				title: "Punctuation entry",
				payload: { text: "... !!! ???" },
			}),
		);
		const results = await store.search('"nonexistent"', 10);
		expect(results.map((r) => r.id)).not.toContain("n1-5c");
	});
});

describe("N1: tokenizeForFts unit tests", () => {
	it("#6 Latin with hyphen: whole words, no per-char split", () => {
		const output = tokenizeForFts("Bounded Exponential-Backoff");
		const tokens = output.split(" ");
		expect(tokens).toContain("bounded");
		expect(tokens).toContain("exponential");
		expect(tokens).toContain("backoff");
		// Must NOT contain single-char splits like "b", "o", "u", etc.
		expect(tokens).not.toContain("b");
		expect(tokens).not.toContain("e");
	});

	it("#7 CJK char + bigram preserved (same as before)", () => {
		const output = tokenizeForFts("量子计算");
		const tokens = output.split(" ");
		expect(tokens).toContain("量");
		expect(tokens).toContain("量子");
		expect(tokens).toContain("子");
		expect(tokens).toContain("计算");
		expect(tokens).toContain("算");
	});
});
