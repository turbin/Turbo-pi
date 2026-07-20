import Database from "better-sqlite3";
import type { Experience } from "./types.ts";

interface ExperienceRow {
	id: string;
	type: Experience["type"];
	title: string;
	payload: string;
	quality: number;
	status: Experience["status"];
	source_session: string;
	source_entry_id: string;
	content_hash: string;
	created_at: string;
}

function rowToExperience(row: ExperienceRow): Experience {
	return {
		id: row.id,
		type: row.type,
		title: row.title,
		payload: JSON.parse(row.payload) as Record<string, unknown>,
		quality: row.quality,
		status: row.status,
		sourceSession: row.source_session,
		sourceEntryId: row.source_entry_id,
		contentHash: row.content_hash,
		createdAt: row.created_at,
	};
}

// Split CJK text into single chars + bigrams so FTS5 can match words inside
// contiguous CJK runs (unicode61 does not segment CJK natively).
function tokenizeForFts(text: string): string {
	const tokens: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (/[一-鿿]/.test(ch)) {
			tokens.push(ch);
			if (i + 1 < text.length && /[一-鿿]/.test(text[i + 1])) {
				tokens.push(ch + text[i + 1]);
			}
		} else {
			tokens.push(ch);
		}
	}
	return tokens.join(" ");
}

export class ExperienceStore {
	private db: Database.Database;

	constructor(path: string) {
		this.db = new Database(path);
	}

	async initSchema(): Promise<void> {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS experiences (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL CHECK (type IN ('SKILL','SOP','ABILITY','EVIDENCE')),
				title TEXT NOT NULL,
				payload TEXT NOT NULL,
				quality REAL NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','removed')),
				branch_path TEXT,
				times_selected INTEGER NOT NULL DEFAULT 0,
				source_session TEXT NOT NULL,
				source_entry_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX IF NOT EXISTS idx_exp_type_status ON experiences(type, status);
			CREATE INDEX IF NOT EXISTS idx_exp_quality ON experiences(quality DESC);
			CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
				title, search_text, content=experiences, content_rowid=rowid,
				tokenize='unicode61'
			);
		`);
	}

	async insert(exp: Experience): Promise<void> {
		this.db
			.prepare(`
				INSERT INTO experiences (id, type, title, payload, quality, status, source_session, source_entry_id, content_hash, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				exp.id,
				exp.type,
				exp.title,
				JSON.stringify(exp.payload),
				exp.quality,
				exp.status,
				exp.sourceSession,
				exp.sourceEntryId,
				exp.contentHash,
				exp.createdAt,
			);
		const payloadText = (exp.payload as Record<string, unknown>).text as string | undefined;
		const searchText = `${exp.title} ${payloadText ?? ""}`;
		this.db
			.prepare(`
				INSERT INTO experiences_fts (rowid, title, search_text)
				SELECT rowid, title, ?
				FROM experiences WHERE id = ?
			`)
			.run(tokenizeForFts(searchText), exp.id);
	}

	async getById(id: string): Promise<Experience | null> {
		const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as ExperienceRow | undefined;
		if (!row) return null;
		return rowToExperience(row);
	}

	async listActive(type: Experience["type"], limit: number): Promise<Experience[]> {
		const rows = this.db
			.prepare(`
				SELECT * FROM experiences
				WHERE type = ? AND status = 'active'
				ORDER BY quality DESC, created_at DESC
				LIMIT ?
			`)
			.all(type, limit) as ExperienceRow[];
		return rows.map(rowToExperience);
	}

	async search(query: string, limit: number): Promise<Experience[]> {
		const rows = this.db
			.prepare(`
				SELECT e.* FROM experiences_fts fts
				JOIN experiences e ON e.rowid = fts.rowid
				WHERE experiences_fts MATCH ?
				ORDER BY bm25(experiences_fts)
				LIMIT ?
			`)
			.all(query, limit) as ExperienceRow[];
		return rows.map(rowToExperience);
	}

	close(): void {
		this.db.close();
	}
}
