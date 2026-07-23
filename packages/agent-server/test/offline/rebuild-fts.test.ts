import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { rebuildFts } from "../../src/offline/rebuild-fts.ts";
import type { Experience } from "../../src/types.ts";

function tempDbPath(): string {
	return join(tmpdir(), `rebuild-fts-test-${randomUUID()}.db`);
}

function makeExp(overrides: Partial<Experience> & Pick<Experience, "id" | "title" | "payload">): Experience {
	return {
		type: "EVIDENCE",
		quality: 0.8,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: "entry-1",
		contentHash: `hash-${overrides.id}`,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("N1 #8-#10: rebuild-fts CLI", () => {
	it("#8 rebuild reindexes old char-split FTS data; word query hits; row counts match", async () => {
		const dbPath = tempDbPath();
		const store = new ExperienceStore(dbPath);
		await store.initSchema();

		// Insert a row normally (uses current tokenizeForFts).
		await store.insert(
			makeExp({
				id: "rebuild-1",
				title: "Retry note",
				payload: { text: "Use exponential backoff with jitter" },
			}),
		);

		// Simulate old-format FTS: drop and recreate, then insert char-split text.
		const db = new Database(dbPath);
		db.exec("DROP TABLE IF EXISTS experiences_fts");
		db.exec(`CREATE VIRTUAL TABLE experiences_fts USING fts5(
			title, search_text, content=experiences, content_rowid=rowid,
			tokenize='unicode61'
		)`);
		const oldText = "Use exponential backoff with jitter".split("").join(" ");
		db.prepare(
			"INSERT INTO experiences_fts (rowid, title, search_text) SELECT rowid, title, ? FROM experiences WHERE id = ?",
		).run(oldText, "rebuild-1");
		db.close();

		// Before rebuild: word query "backoff" should NOT hit (char-split index).
		const beforeHits = await store.search('"backoff"', 10);
		expect(beforeHits.length).toBe(0);

		// Run rebuild.
		const count = rebuildFts({ dbPath, dryRun: false });
		expect(count).toBe(1);

		// After rebuild: word query "backoff" should hit.
		const afterHits = await store.search('"backoff"', 10);
		expect(afterHits.map((r) => r.id)).toContain("rebuild-1");

		// Row counts: FTS rows = experiences rows.
		// Use experiences_fts_docsize (internal FTS5 table) to count indexed docs
		// because SELECT COUNT(*) on an external-content FTS table tries to read
		// the missing search_text column from the content table.
		const db2 = new Database(dbPath);
		const expCount = (db2.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n;
		const ftsCount = (db2.prepare("SELECT COUNT(*) AS n FROM experiences_fts_docsize").get() as { n: number }).n;
		db2.close();
		expect(ftsCount).toBe(expCount);

		store.close();
	});

	it("#9 rebuild is idempotent — second run produces identical state", async () => {
		const dbPath = tempDbPath();
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "idem-1",
				title: "Idempotent test",
				payload: { text: "backoff and jitter strategy" },
			}),
		);

		rebuildFts({ dbPath, dryRun: false });
		const firstHits = await store.search('"backoff"', 10);

		rebuildFts({ dbPath, dryRun: false });
		const secondHits = await store.search('"backoff"', 10);

		expect(secondHits.map((r) => r.id)).toEqual(firstHits.map((r) => r.id));

		// FTS row count still matches experiences row count.
		const db = new Database(dbPath);
		const expCount = (db.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n;
		const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM experiences_fts_docsize").get() as { n: number }).n;
		db.close();
		expect(ftsCount).toBe(expCount);

		store.close();
	});

	it("#10 --dry-run does not write to the database", async () => {
		const dbPath = tempDbPath();
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(
			makeExp({
				id: "dry-1",
				title: "Dry run test",
				payload: { text: "backoff and jitter" },
			}),
		);
		store.close();

		// Record mtime before dry-run.
		const mtimeBefore = statSync(dbPath).mtimeMs;

		const count = rebuildFts({ dbPath, dryRun: true });
		expect(count).toBe(1); // reports row count

		// mtime must not change.
		const mtimeAfter = statSync(dbPath).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);

		// Verify FTS content is unchanged (still has old data).
		const db = new Database(dbPath);
		const ftsCount = (db.prepare("SELECT COUNT(*) AS n FROM experiences_fts_docsize").get() as { n: number }).n;
		db.close();
		expect(ftsCount).toBe(1); // original insert still there, no rebuild happened
	});
});
