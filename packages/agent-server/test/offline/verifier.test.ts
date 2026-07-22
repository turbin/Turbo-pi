import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { contentHashFor, dedupeCandidates } from "../../src/offline/canonicalize.ts";
import {
	cardsToStaged,
	promoteStagedOutputs,
	skillsToStaged,
	sopsToStaged,
	verifyAndCanonicalize,
} from "../../src/offline/verifier.ts";
import { buildSkillCatalog } from "../../src/skill-catalog.ts";
import type { Experience } from "../../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-verifier-test-"));
	tempDirs.push(dir);
	return dir;
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

function dormantEvidence(text: string): Experience {
	return {
		id: `ev-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
		type: "EVIDENCE",
		title: text.slice(0, 50),
		payload: { text },
		quality: 0,
		status: "dormant",
		sourceSession: "session-1",
		sourceEntryId: "entry-1",
		contentHash: createHash("sha256").update(text).digest("hex"),
		createdAt: new Date().toISOString(),
	};
}

describe("verifyAndCanonicalize", () => {
	it("marks quality >= 0.5 as active", async () => {
		const store = await makeStore();
		const items = [
			{ id: "x", quality: 0.8, title: "good evidence", payload: { text: "good evidence" } },
			{ id: "y", quality: 0.3, title: "bad evidence", payload: { text: "bad evidence" } },
		];
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		const promoted = await store.getById("x");
		expect(promoted?.status).toBe("active");
		expect(promoted?.quality).toBe(0.8);
		expect(await store.getById("y")).toBeNull();
	});

	it("treats the threshold as inclusive (quality == 0.5 promotes)", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			[{ id: "edge", quality: 0.5, title: "edge case", payload: { text: "edge case" } }],
			store,
		);
		expect(count).toBe(1);
		expect((await store.getById("edge"))?.status).toBe("active");
	});

	it("dedupes identical items inside one batch", async () => {
		const store = await makeStore();
		const items = [
			{ quality: 0.9, title: "same insight", payload: { text: "same insight" } },
			{ quality: 0.7, title: "same insight", payload: { text: "same insight" } },
		];
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
	});

	it("skips items whose contentHash already exists active in the store", async () => {
		const store = await makeStore();
		const first = await verifyAndCanonicalize(
			[{ quality: 0.9, title: "known insight", payload: { text: "known insight" } }],
			store,
		);
		expect(first).toBe(1);
		const second = await verifyAndCanonicalize(
			[{ quality: 0.95, title: "known insight", payload: { text: "known insight" } }],
			store,
		);
		expect(second).toBe(0);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
	});

	it("promotes a dormant ETL candidate in place when its contentHash is verified", async () => {
		const store = await makeStore();
		const text = "always run the migration before seeding the database";
		const existing = dormantEvidence(text);
		await store.insert(existing);

		const count = await verifyAndCanonicalize(
			[
				{
					quality: 0.9,
					title: existing.title,
					payload: { text },
					contentHash: existing.contentHash,
				},
			],
			store,
		);
		expect(count).toBe(1);
		const promoted = await store.getById(existing.id);
		expect(promoted?.status).toBe("active");
		expect(promoted?.quality).toBe(0.9);
		// No duplicate row next to the promoted one.
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
	});

	it("leaves dormant rows untouched when the item is below threshold", async () => {
		const store = await makeStore();
		const text = "some unverified sentence from a session";
		const existing = dormantEvidence(text);
		await store.insert(existing);

		const count = await verifyAndCanonicalize(
			[{ quality: 0.2, title: existing.title, payload: { text }, contentHash: existing.contentHash }],
			store,
		);
		expect(count).toBe(0);
		expect((await store.getById(existing.id))?.status).toBe("dormant");
	});

	it("does not resurrect a removed row that matches the verified contentHash", async () => {
		const store = await makeStore();
		const text = "obsolete advice that was removed from the store";
		const removed: Experience = { ...dormantEvidence(text), status: "removed" };
		await store.insert(removed);

		const count = await verifyAndCanonicalize(
			[{ quality: 0.9, title: removed.title, payload: { text }, contentHash: removed.contentHash }],
			store,
		);
		expect(count).toBe(0);
		expect((await store.getById(removed.id))?.status).toBe("removed");
	});

	it("offline-promoted skills render a non-empty description in the online skill catalog", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			skillsToStaged([
				{
					name: "retry-with-backoff",
					summary: "Retry flaky steps with exponential backoff",
					utility: 0.9,
					content: "# Retry with backoff",
				},
			]),
			store,
		);
		expect(count).toBe(1);

		const { catalog } = await buildSkillCatalog(store, 10);
		expect(catalog).toContain('<skill name="retry-with-backoff">Retry flaky steps with exponential backoff</skill>');
	});

	it("rolls back the whole batch when one item fails mid-promotion", async () => {
		const store = await makeStore();
		// Distinct content (passes dedupe) but the same explicit id: the second
		// insert violates the PRIMARY KEY and must roll back the first insert too.
		const items = [
			{ id: "dup", quality: 0.9, title: "first insight", payload: { text: "first insight" } },
			{ id: "dup", quality: 0.8, title: "second insight", payload: { text: "second insight" } },
		];
		await expect(verifyAndCanonicalize(items, store)).rejects.toThrow(/UNIQUE constraint/);
		expect(await store.getById("dup")).toBeNull();
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(0);
	});
});

describe("canonicalize helpers", () => {
	it("contentHashFor is stable across key order and type/title sensitive", () => {
		const a = contentHashFor({ type: "EVIDENCE", title: "t", payload: { b: 2, a: 1 } });
		const b = contentHashFor({ type: "EVIDENCE", title: "t", payload: { a: 1, b: 2 } });
		expect(a).toBe(b);
		const c = contentHashFor({ type: "SKILL", title: "t", payload: { a: 1, b: 2 } });
		expect(c).not.toBe(a);
	});

	it("dedupeCandidates keeps the first occurrence per hash", () => {
		const items = [
			{ id: "first", hash: "h1" },
			{ id: "second", hash: "h1" },
			{ id: "third", hash: "h2" },
		];
		const deduped = dedupeCandidates(items, (item) => item.hash);
		expect(deduped.map((i) => i.id)).toEqual(["first", "third"]);
	});
});

describe("staged output mappers", () => {
	it("maps skills.json entries to SKILL items scored by utility", () => {
		const items = skillsToStaged([{ name: "skill-node-3", summary: "retry", utility: 0.83, content: "# Skill" }]);
		expect(items).toHaveLength(1);
		const [skill] = items;
		expect(skill.type).toBe("SKILL");
		expect(skill.title).toBe("skill-node-3");
		expect(skill.quality).toBe(0.83);
		expect(skill.payload?.text).toBe("# Skill");
	});

	it("maps sops.json entries to pre-vetted SOP items", () => {
		const items = sopsToStaged([
			{
				name: "fix_and_test",
				code: "def fix_and_test(): ...",
				docstring: "fix then test",
				schema: {},
				tools: ["edit", "bash"],
			},
		]);
		expect(items).toHaveLength(1);
		const [sop] = items;
		expect(sop.type).toBe("SOP");
		expect(sop.title).toBe("fix_and_test");
		expect(sop.quality).toBeGreaterThanOrEqual(0.5);
		expect(sop.payload?.text).toBe("fix then test");
	});

	it("maps cards.json entries to EVIDENCE items scored by verifier quality", () => {
		const items = cardsToStaged([
			{
				taskId: "task-1",
				quality: 0.77,
				card: {
					name: "isolate before retry",
					trigger: "Use when a flaky step fails",
					procedure: "1) isolate 2) retry",
					boundary: "Must not apply to deterministic failures",
					role: "Method",
					evidence: { task_id: "task-1", verifier_score: 0.77 },
				},
			},
		]);
		expect(items).toHaveLength(1);
		const [card] = items;
		expect(card.type).toBe("EVIDENCE");
		expect(card.title).toBe("isolate before retry");
		expect(card.quality).toBe(0.77);
		expect(card.payload?.role).toBe("Method");
		expect(card.payload?.taskId).toBe("task-1");
	});
});

describe("promoteStagedOutputs", () => {
	it("reads staged skills/sops/cards JSON and promotes verified entries", async () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "skills.json"),
			JSON.stringify([{ name: "skill-node-1", summary: "s", utility: 0.9, content: "# Full skill" }]),
		);
		writeFileSync(
			join(dir, "sops.json"),
			JSON.stringify([
				{ name: "sop_a", code: "def sop_a(): ...", docstring: "sop doc", schema: {}, tools: ["bash"] },
			]),
		);
		writeFileSync(
			join(dir, "cards.json"),
			JSON.stringify([
				{
					taskId: "t-1",
					quality: 0.8,
					card: {
						name: "card one",
						trigger: "Use when x",
						procedure: "1) y",
						boundary: "Must not z",
						role: "Guard",
						evidence: { task_id: "t-1", verifier_score: 0.8 },
					},
				},
				{
					taskId: "t-2",
					quality: 0.1,
					card: {
						name: "card two",
						trigger: "Use when q",
						procedure: "1) w",
						boundary: "Must not e",
						role: "Method",
						evidence: { task_id: "t-2", verifier_score: 0.1 },
					},
				},
			]),
		);

		const store = await makeStore();
		const count = await promoteStagedOutputs(dir, store);
		expect(count).toBe(3); // skill + sop + one card; the 0.1 card is gated out
		expect(await store.listActive("SKILL", 10)).toHaveLength(1);
		expect(await store.listActive("SOP", 10)).toHaveLength(1);
		const evidence = await store.listActive("EVIDENCE", 10);
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.title).toBe("card one");
	});

	it("names the missing staged file and the pipeline stage when outputs are absent", async () => {
		const dir = makeTempDir();
		const store = await makeStore();
		await expect(promoteStagedOutputs(dir, store)).rejects.toThrow(/staged output .*skills\.json/);
		await expect(promoteStagedOutputs(dir, store)).rejects.toThrow(/pipeline stage must run first/);
	});
});
