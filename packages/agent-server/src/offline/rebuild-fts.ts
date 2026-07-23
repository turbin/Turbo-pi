import Database from "better-sqlite3";
import { tokenizeForFts } from "../experience-store.ts";

/**
 * Offline FTS rebuild CLI (N1; post-C ops 2026-07-23).
 *
 * Drops and recreates experiences_fts, then re-inserts all rows using the
 * current tokenizeForFts (Latin whole-word + CJK char/bigram). DROP is
 * necessary because experiences_fts is an external-content FTS5 table
 * (content=experiences) and the experiences table lacks a search_text
 * column, so a plain DELETE FROM fails. This is a manual one-time
 * migration — server startup and run-evolution do NOT trigger it.
 *
 * Usage:
 *   npx tsx src/offline/rebuild-fts.ts [--dry-run]
 *
 * --dry-run: print the row count that would be rebuilt without writing.
 *
 * Red line: only touches the database at EXPERIENCE_STORE_PATH (default
 * ./var/experience.db). No other state is modified.
 */

export interface RebuildFtsOptions {
	/** Path to the SQLite database file. */
	dbPath: string;
	/** Print what would be done without writing. */
	dryRun: boolean;
	/** Logger for test observability. */
	log?: (msg: string) => void;
}

const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
	title, search_text, content=experiences, content_rowid=rowid,
	tokenize='unicode61'
)`;

/**
 * Rebuild the experiences_fts index from scratch. Returns the number of
 * rows processed. When dryRun is true, only counts rows without writing.
 */
export function rebuildFts(opts: RebuildFtsOptions): number {
	const _log = opts.log ?? console.log;
	const db = new Database(opts.dbPath, opts.dryRun ? { readonly: true } : {});
	try {
		const rows = db.prepare("SELECT rowid, title, payload FROM experiences").all() as {
			rowid: number;
			title: string;
			payload: string;
		}[];
		const count = rows.length;
		_log(`${opts.dryRun ? "[dry-run] would rebuild" : "rebuilt"} ${count} FTS row(s)`);

		if (opts.dryRun) return count;

		const run = db.transaction(() => {
			db.exec("DROP TABLE IF EXISTS experiences_fts");
			db.exec(FTS_DDL);
			const insertFts = db.prepare("INSERT INTO experiences_fts (rowid, title, search_text) VALUES (?, ?, ?)");
			for (const row of rows) {
				const payload = JSON.parse(row.payload) as Record<string, unknown>;
				const payloadText = (payload.text as string) ?? "";
				const searchText = `${row.title} ${payloadText}`;
				insertFts.run(row.rowid, row.title, tokenizeForFts(searchText));
			}
		});
		run();
		return count;
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// CLI dispatch (standalone, following schedule.ts pattern)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const dbPath = process.env.EXPERIENCE_STORE_PATH ?? "./var/experience.db";
	rebuildFts({ dbPath, dryRun });
}
