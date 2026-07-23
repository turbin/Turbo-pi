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

	it("maps cards.json entries by role: Method routes to ABILITY scored by verifier quality", () => {
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
		expect(card.type).toBe("ABILITY");
		expect(card.title).toBe("isolate before retry");
		expect(card.quality).toBe(0.77);
		expect(card.payload?.role).toBe("Method");
		expect(card.payload?.taskId).toBe("task-1");
	});
});

describe("cardsToStaged role routing (C1)", () => {
	it("routes Method cards to ABILITY with the full tuple payload, promoted active above threshold", async () => {
		const evidence = { task_id: "task-1", verifier_score: 0.7 };
		const items = cardsToStaged([
			{
				taskId: "task-1",
				quality: 0.7,
				card: {
					name: "isolate before retry",
					trigger: "Use when a flaky step fails",
					procedure: "1) isolate 2) retry",
					boundary: "Must not apply to deterministic failures",
					role: "Method",
					evidence,
				},
			},
		]);
		expect(items).toHaveLength(1);
		const [item] = items;
		expect(item.type).toBe("ABILITY");
		expect(item.title).toBe("isolate before retry");
		expect(item.quality).toBe(0.7);
		expect(item.payload?.role).toBe("Method");
		expect(item.payload?.trigger).toBe("Use when a flaky step fails");
		expect(item.payload?.procedure).toBe("1) isolate 2) retry");
		expect(item.payload?.boundary).toBe("Must not apply to deterministic failures");
		expect(item.payload?.evidence).toEqual(evidence);
		expect(item.payload?.taskId).toBe("task-1");
		expect(item.payload?.text).toBe("Use when a flaky step fails\n1) isolate 2) retry");

		const store = await makeStore();
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		const active = await store.listActive("ABILITY", 10);
		expect(active).toHaveLength(1);
		expect(active[0]?.title).toBe("isolate before retry");
	});

	it("routes Guard cards to ABILITY and stores them active", async () => {
		const items = cardsToStaged([
			{
				taskId: "task-2",
				quality: 0.6,
				card: {
					name: "never force push",
					trigger: "Use before any git mutation",
					procedure: "check the remote state first",
					boundary: "Must not run git push --force",
					role: "Guard",
					evidence: { task_id: "task-2", verifier_score: 0.6 },
				},
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("ABILITY");
		expect(items[0]?.payload?.role).toBe("Guard");

		const store = await makeStore();
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(1);
	});

	it("keeps Workflow cards as EVIDENCE even at high quality", () => {
		const items = cardsToStaged([
			{
				taskId: "task-3",
				quality: 0.9,
				card: {
					name: "standard fix workflow",
					trigger: "Use when a bug is reported",
					procedure: "reproduce, fix, test",
					boundary: "Must not skip reproduction",
					role: "Workflow",
					evidence: { task_id: "task-3", verifier_score: 0.9 },
				},
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("EVIDENCE");
		expect(items[0]?.payload?.role).toBe("Workflow");
	});

	it("keeps cards without a role field as EVIDENCE without throwing", () => {
		const items = cardsToStaged([
			{
				taskId: "task-4",
				quality: 0.8,
				card: {
					name: "no role card",
					trigger: "Use when x",
					procedure: "1) y",
					boundary: "Must not z",
					evidence: { task_id: "task-4" },
				},
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("EVIDENCE");
		expect(items[0]?.payload?.role).toBe("");
	});

	it("keeps cards with an unknown role value as EVIDENCE without throwing", () => {
		const items = cardsToStaged([
			{
				taskId: "task-5",
				quality: 0.8,
				card: {
					name: "unknown role card",
					trigger: "Use when x",
					procedure: "1) y",
					boundary: "Must not z",
					role: "UnknownRole",
					evidence: { task_id: "task-5" },
				},
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("EVIDENCE");
		expect(items[0]?.payload?.role).toBe("UnknownRole");
	});

	it("promotes a Method card at exactly the threshold as active ABILITY", async () => {
		const items = cardsToStaged([
			{
				taskId: "task-6",
				quality: 0.5,
				card: {
					name: "threshold method",
					trigger: "Use when at threshold",
					procedure: "1) proceed",
					boundary: "Must not regress",
					role: "Method",
					evidence: { task_id: "task-6", verifier_score: 0.5 },
				},
			},
		]);
		expect(items[0]?.type).toBe("ABILITY");

		const store = await makeStore();
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(1);
	});

	it("does not promote a Method card just below the threshold", async () => {
		const items = cardsToStaged([
			{
				taskId: "task-7",
				quality: 0.49,
				card: {
					name: "below threshold method",
					trigger: "Use when below threshold",
					procedure: "1) proceed",
					boundary: "Must not regress",
					role: "Method",
					evidence: { task_id: "task-7", verifier_score: 0.49 },
				},
			},
		]);
		expect(items[0]?.type).toBe("ABILITY");

		const store = await makeStore();
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(0);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(0);
	});

	it("treats non-number quality as 0: gated out without throwing", async () => {
		const items = cardsToStaged([
			{
				taskId: "task-8a",
				quality: "high" as unknown as number,
				card: {
					name: "string quality method",
					trigger: "Use when x",
					procedure: "1) y",
					boundary: "Must not z",
					role: "Method",
					evidence: { task_id: "task-8a" },
				},
			},
			{
				taskId: "task-8b",
				card: {
					name: "missing quality method",
					trigger: "Use when x",
					procedure: "1) y",
					boundary: "Must not z",
					role: "Method",
					evidence: { task_id: "task-8b" },
				},
			},
		]);
		expect(items).toHaveLength(2);
		expect(items[0]?.quality).toBe(0);
		expect(items[1]?.quality).toBe(0);
		expect(items[0]?.type).toBe("ABILITY");
		expect(items[1]?.type).toBe("ABILITY");

		const store = await makeStore();
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(0);
	});

	it("skips entries without a card without throwing", () => {
		const items = cardsToStaged([
			{ taskId: "task-9a", quality: 0.9 },
			{ taskId: "task-9b", quality: 0.9, card: null as unknown as { name?: string } },
		]);
		expect(items).toHaveLength(0);
	});

	it("routes a mixed batch: exactly 2 ABILITY and 2 EVIDENCE", () => {
		const makeCard = (taskId: string, quality: number, role?: string) => ({
			taskId,
			quality,
			card: {
				name: `card-${taskId}`,
				trigger: `trigger-${taskId}`,
				procedure: `procedure-${taskId}`,
				boundary: `boundary-${taskId}`,
				role,
				evidence: { task_id: taskId },
			},
		});
		const items = cardsToStaged([
			makeCard("m", 0.9, "Method"),
			makeCard("g", 0.8, "Guard"),
			makeCard("w", 0.7, "Workflow"),
			makeCard("n", 0.6),
		]);
		expect(items).toHaveLength(4);
		expect(items.filter((i) => i.type === "ABILITY")).toHaveLength(2);
		expect(items.filter((i) => i.type === "EVIDENCE")).toHaveLength(2);
		expect(items.map((i) => i.type)).toEqual(["ABILITY", "ABILITY", "EVIDENCE", "EVIDENCE"]);
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
		// The promoted card is role Guard, so it is stored as ABILITY, not EVIDENCE.
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(0);
		const abilities = await store.listActive("ABILITY", 10);
		expect(abilities).toHaveLength(1);
		expect(abilities[0]?.title).toBe("card one");
	});

	it("names the missing staged file and the pipeline stage when outputs are absent", async () => {
		const dir = makeTempDir();
		const store = await makeStore();
		await expect(promoteStagedOutputs(dir, store)).rejects.toThrow(/staged output .*skills\.json/);
		await expect(promoteStagedOutputs(dir, store)).rejects.toThrow(/pipeline stage must run first/);
	});
});
