import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { runDailyEvolution } from "../src/offline/scheduler.ts";
import { retrieve } from "../src/retrieval.ts";
import type { Experience } from "../src/types.ts";

/**
 * F2 实战归因奖惩（T3）：confidence 列迁移 + 检索排序降权 + 复升排除。
 *
 * 覆盖点（plans §3 F2，dev-tasks T3）：
 * 1. 旧库迁移：experiences 缺 confidence/rescore_excluded_batches 列 →
 *    initSchema 补列（PRAGMA + ALTER，M1 模式）+ user_version 版本化；旧行读回
 *    confidence=0.5 / rescore_excluded_batches=0（COALESCE 默认）；
 * 2. 旧 schema 快照（readonly）打开不破：读路径（search/listActive）默认值兜底；
 * 3. demoteToDormant：人工确认降级通道（active→dormant + 复升排除标记）；
 * 4. decrementRescoreExclusions：每运行一批递减，N 批后复评资格恢复；
 * 5. 检索排序加权：confidence 参与排序——低确信卡沉底、高确信卡优先；
 * 6. runDormantRescore 复升排除：带排除标记的 dormant 卡跳过自评复评。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-t3-"));
	tempDirs.push(dir);
	return dir;
}

function makeExp(id: string, overrides: Partial<Experience> = {}): Experience {
	return {
		id,
		type: "EVIDENCE",
		title: `title-${id}`,
		payload: { text: `text-${id}` },
		quality: 0.8,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: `entry-${id}`,
		contentHash: `hash-${id}`,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("T3: confidence column migration (M1 pattern + user_version)", () => {
	it("migrates an old-schema db by adding confidence/rescore_excluded_batches and setting user_version", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "old.db");
		{
			// 模拟 F2 以前旧库：experiences 无 confidence/rescore_excluded_batches 列。
			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE experiences (
					id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
					payload TEXT NOT NULL, quality REAL NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'active', branch_path TEXT,
					times_selected INTEGER NOT NULL DEFAULT 0,
					source_session TEXT NOT NULL, source_entry_id TEXT NOT NULL,
					content_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				CREATE TABLE request_traces (
					request_id TEXT PRIMARY KEY, ts TEXT NOT NULL, model TEXT NOT NULL,
					stream INTEGER NOT NULL DEFAULT 0, retrieved_count INTEGER NOT NULL DEFAULT 0,
					retrieved_ids TEXT NOT NULL DEFAULT '[]', retrieved_kinds TEXT NOT NULL DEFAULT '[]',
					hit INTEGER NOT NULL DEFAULT 0, injected_ids TEXT NOT NULL DEFAULT '[]',
					task_id TEXT, finish_reason TEXT, prompt_tokens INTEGER,
					completion_tokens INTEGER, latency_ms INTEGER, error TEXT
				);
			`);
			db.prepare(
				"INSERT INTO experiences (id, type, title, payload, quality, status, source_session, source_entry_id, content_hash) VALUES ('old-1','EVIDENCE','t','{}',0.8,'active','s','e','h')",
			).run();
			db.close();
		}

		const store = new ExperienceStore(dbPath);
		await store.initSchema();

		// 迁移补列。
		const cols = new Database(dbPath).prepare("PRAGMA table_info(experiences)").all() as { name: string }[];
		expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["confidence", "rescore_excluded_batches"]));

		// user_version 版本化。
		const version = new Database(dbPath).pragma("user_version", { simple: true }) as number;
		expect(version).toBeGreaterThanOrEqual(1);

		// 旧行读回安全默认值（COALESCE 默认 confidence=0.5）。
		const old = await store.getById("old-1");
		expect(old?.confidence).toBe(0.5);
		expect(old?.rescoreExcludedBatches).toBe(0);
		store.close();
	});

	it("keeps confidence round-tripping through insert/getById", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const exp = makeExp("exp-c", { confidence: 0.9, rescoreExcludedBatches: 2 });
		await store.insert(exp);
		const found = await store.getById("exp-c");
		expect(found?.confidence).toBe(0.9);
		expect(found?.rescoreExcludedBatches).toBe(2);
	});

	it("opens an old-schema readonly snapshot without breaking reads (defaults apply)", async () => {
		const dir = makeTempDir();
		const snapPath = join(dir, "snapshot.db");
		{
			const db = new Database(snapPath);
			db.exec(`
				CREATE TABLE experiences (
					id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
					payload TEXT NOT NULL, quality REAL NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'active', branch_path TEXT,
					times_selected INTEGER NOT NULL DEFAULT 0,
					source_session TEXT NOT NULL, source_entry_id TEXT NOT NULL,
					content_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				CREATE VIRTUAL TABLE experiences_fts USING fts5(
					title, search_text, content=experiences, content_rowid=rowid, tokenize='unicode61'
				);
			`);
			db.prepare(
				"INSERT INTO experiences (id, type, title, payload, quality, status, source_session, source_entry_id, content_hash) VALUES ('snap-1','EVIDENCE','hello snapshot','{\"text\":\"hello snapshot\"}',0.9,'active','s','e','h')",
			).run();
			db.prepare(
				"INSERT INTO experiences_fts (rowid, title, search_text) VALUES (1, 'hello snapshot', 'hello snapshot')",
			).run();
			db.close();
		}
		// 快照只读打开（initSchema 只迁移 live 库，快照语义不破）。
		const live = new ExperienceStore(":memory:");
		await live.initSchema();
		const snap = new ExperienceStore(":memory:", { snapshotPath: snapPath });
		const hits = await snap.search("snapshot", 5);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.confidence).toBe(0.5);
		expect(hits[0]?.rescoreExcludedBatches).toBe(0);
		const active = await snap.listActive("EVIDENCE", 5);
		expect(active[0]?.confidence).toBe(0.5);
	});
});

describe("T3: manual demotion channel (no auto-downgrade)", () => {
	it("demoteToDormant moves active rows to dormant with the rescore-exclusion marker", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeExp("exp-a"));
		await store.insert(makeExp("exp-b"));
		const count = await store.demoteToDormant(["exp-a", "exp-ghost"], 3);
		expect(count).toBe(1);
		const a = await store.getById("exp-a");
		expect(a?.status).toBe("dormant");
		expect(a?.rescoreExcludedBatches).toBe(3);
		expect(a?.confidence).toBe(0.5); // 降级不动 quality/confidence（降权由离线脚本做）
		expect((await store.getById("exp-b"))?.status).toBe("active");
	});

	it("decrementRescoreExclusions counts down batches and clamps at zero", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeExp("exp-a", { rescoreExcludedBatches: 3 }));
		await store.insert(makeExp("exp-b", { rescoreExcludedBatches: 1 }));
		await store.insert(makeExp("exp-c", { rescoreExcludedBatches: 0 }));
		expect(await store.decrementRescoreExclusions()).toBe(2);
		expect((await store.getById("exp-a"))?.rescoreExcludedBatches).toBe(2);
		expect((await store.getById("exp-b"))?.rescoreExcludedBatches).toBe(0);
		expect((await store.getById("exp-c"))?.rescoreExcludedBatches).toBe(0);
	});
});

describe("T3: retrieval ranking weight by confidence", () => {
	it("ranks a high-confidence card above a low-confidence one at equal relevance", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp("exp-good", {
				title: "retry backoff",
				payload: { text: "retry with backoff on flaky failures" },
				confidence: 0.9,
			}),
		);
		await store.insert(
			makeExp("exp-bad", {
				title: "retry backoff",
				payload: { text: "retry with backoff on flaky failures" },
				confidence: 0.1,
			}),
		);
		const results = await retrieve(store, "retry backoff", 2);
		expect(results.map((r) => r.experience.id)).toEqual(["exp-good", "exp-bad"]);
		// score 为 cosine × confidence 的加权分。
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
	});

	it("a demoted low-confidence card sinks below a less-relevant default card", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		// 低确信卡相关性更高（cosine 全匹配），但 confidence 0.1 使其加权分低于默认卡。
		await store.insert(
			makeExp("exp-low", { title: "flaky retry", payload: { text: "retry backoff flaky" }, confidence: 0.1 }),
		);
		await store.insert(makeExp("exp-default", { title: "flaky", payload: { text: "flaky" }, confidence: 0.5 }));
		const results = await retrieve(store, "flaky retry", 2);
		expect(results.map((r) => r.experience.id)).toEqual(["exp-default", "exp-low"]);
	});
});

describe("T3: rescore self-re-evaluation exclusion (loop breaker)", () => {
	it("runDailyEvolution skips dormant rows carrying the exclusion marker and counts batches down", async () => {
		const dir = makeTempDir();
		const sessionDir = join(dir, "sessions");
		const outputDir = join(dir, "evolution");
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		// 两个 dormant EVIDENCE 候选：一个带复升排除标记（实战降权），一个正常。
		// createdAt 用测试 epoch（TTL 清理不误伤）。
		const epoch = new Date(1_800_000_000_000).toISOString();
		await store.insert(
			makeExp("exp-excluded", {
				status: "dormant",
				rescoreExcludedBatches: 3,
				createdAt: epoch,
				payload: { text: "excluded evidence", task: "t" },
			}),
		);
		await store.insert(
			makeExp("exp-eligible", {
				status: "dormant",
				createdAt: epoch,
				payload: { text: "eligible evidence", task: "t" },
			}),
		);

		const rescored: string[] = [];
		const rescoreFn = async (candidates: { content_hash: string }[]) => {
			for (const c of candidates) rescored.push(c.content_hash);
			return new Map(candidates.map((c) => [c.content_hash, 0.9]));
		};
		// 空 ETL/pipeline：只跑 rescore 阶段。
		await runDailyEvolution(store, {
			inputDir: sessionDir,
			outputDir,
			etlFn: async () => ({ inserted: 0, isolated: [] }),
			pipelineFn: async () => ({ skills: 0, sops: 0, cards: 0 }),
			promoteFn: async () => 0,
			rescoreFn,
			now: () => 1_800_000_000_000,
		});

		// 排除标记卡未被自评复评；正常卡被复评并晋升。
		expect(rescored).toEqual(["hash-exp-eligible"]);
		expect((await store.getById("exp-eligible"))?.status).toBe("active");
		expect((await store.getById("exp-excluded"))?.status).toBe("dormant");
		// 每运行一批，排除计数递减（3 → 2）；N 批后恢复复评资格。
		expect((await store.getById("exp-excluded"))?.rescoreExcludedBatches).toBe(2);
	});
});
