import Database from "better-sqlite3";
import type { Experience } from "./types.ts";

/**
 * Offline evolution checkpoint (SPEC §7 `checkpoints` table). `kind` separates
 * checkpoint streams (only "evolution" so far), `epoch` is the caller-supplied
 * run timestamp (ms), `metric` the headline number of the run (promoted
 * entries), and `snapshot` a JSON blob with the full run details.
 */
export interface Checkpoint {
	id: string;
	kind: string;
	epoch: number;
	metric: number;
	snapshot: string;
	createdAt: string;
}

interface CheckpointRow {
	id: string;
	kind: string;
	epoch: number;
	metric: number;
	snapshot: string;
	created_at: string;
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
	return {
		id: row.id,
		kind: row.kind,
		epoch: row.epoch,
		metric: row.metric,
		snapshot: row.snapshot,
		createdAt: row.created_at,
	};
}

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

const CJK_RE = /[一-鿿]/;

// ---------------------------------------------------------------------------
// Request traces (O spec R1/R2)
// ---------------------------------------------------------------------------

/** Phase-1 (retrieval) + phase-2 (completion) fields for one proxied request. */
export interface RequestTraceInput {
	requestId: string;
	ts?: string;
	model?: string;
	stream?: boolean;
	retrievedCount?: number;
	retrievedIds?: string[];
	retrievedKinds?: string[];
	hit?: boolean;
	finishReason?: string;
	promptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
	error?: string;
}

export interface HitRateStats {
	windowHours: number;
	total: number;
	hits: number;
	hitRate: number;
	byKind: { kind: string; cnt: number }[];
	daily: { day: string; total: number; hits: number }[];
	recent: Record<string, unknown>[];
}

/**
 * Tokenize text for FTS5 indexing (search_text column). Aligned with
 * `tokenize()` in retrieval.ts: Latin/digit runs become whole-word tokens
 * (lowercased), CJK chars get single char + adjacent bigram. Whitespace
 * and punctuation are natural delimiters. Exported for unit testing and
 * the rebuild-fts CLI.
 */
export function tokenizeForFts(text: string): string {
	const tokens: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (CJK_RE.test(ch)) {
			tokens.push(ch);
			if (i + 1 < text.length && CJK_RE.test(text[i + 1])) {
				tokens.push(ch + text[i + 1]);
			}
		} else if (/[a-zA-Z0-9]/.test(ch)) {
			const word = text.slice(i).match(/^[a-zA-Z0-9]+/);
			if (word) {
				tokens.push(word[0].toLowerCase());
				i += word[0].length - 1;
			}
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
			CREATE INDEX IF NOT EXISTS idx_exp_content_hash ON experiences(content_hash);
			CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
				title, search_text, content=experiences, content_rowid=rowid,
				tokenize='unicode61'
			);
			CREATE TABLE IF NOT EXISTS checkpoints (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				metric REAL NOT NULL,
				snapshot TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX IF NOT EXISTS idx_checkpoints_kind_epoch ON checkpoints(kind, epoch DESC);
			-- Per-request observability trace (O spec R1): one row per proxied chat
			-- request, written in two phases (after retrieval, then at completion).
			CREATE TABLE IF NOT EXISTS request_traces (
				request_id TEXT PRIMARY KEY,
				ts TEXT NOT NULL,
				model TEXT NOT NULL,
				stream INTEGER NOT NULL DEFAULT 0,
				retrieved_count INTEGER NOT NULL DEFAULT 0,
				retrieved_ids TEXT NOT NULL DEFAULT '[]',
				retrieved_kinds TEXT NOT NULL DEFAULT '[]',
				hit INTEGER NOT NULL DEFAULT 0,
				finish_reason TEXT,
				prompt_tokens INTEGER,
				completion_tokens INTEGER,
				latency_ms INTEGER,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_request_traces_ts ON request_traces(ts);
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

	async getByContentHash(contentHash: string): Promise<Experience | null> {
		const row = this.db.prepare("SELECT * FROM experiences WHERE content_hash = ?").get(contentHash) as
			| ExperienceRow
			| undefined;
		if (!row) return null;
		return rowToExperience(row);
	}

	async promoteToActive(id: string, quality: number): Promise<void> {
		this.db.prepare("UPDATE experiences SET status = 'active', quality = ? WHERE id = ?").run(quality, id);
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

	async listDormant(type: Experience["type"], limit: number): Promise<Experience[]> {
		const rows = this.db
			.prepare(`
				SELECT * FROM experiences
				WHERE type = ? AND status = 'dormant'
				ORDER BY created_at ASC
				LIMIT ?
			`)
			.all(type, limit) as ExperienceRow[];
		return rows.map(rowToExperience);
	}

	/**
	 * Bound dormant-row growth (SPEC §5.2 lifecycle): mark dormant rows older
	 * than `cutoffIso` as 'removed', then, if dormant rows still exceed `cap`,
	 * mark the oldest excess as 'removed'. Returns the number of rows removed
	 * in this call. FTS needs no handling: rows stay indexed but `search`
	 * filters status='active', so a plain status UPDATE suffices.
	 */
	async removeDormantBefore(cutoffIso: string, cap?: number): Promise<number> {
		let removed = this.db
			.prepare("UPDATE experiences SET status = 'removed' WHERE status = 'dormant' AND created_at < ?")
			.run(cutoffIso).changes;
		if (cap !== undefined) {
			const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM experiences WHERE status = 'dormant'").get() as {
				n: number;
			};
			const excess = n - cap;
			if (excess > 0) {
				removed += this.db
					.prepare(`
						UPDATE experiences SET status = 'removed'
						WHERE id IN (
							SELECT id FROM experiences WHERE status = 'dormant' ORDER BY created_at ASC LIMIT ?
						)
					`)
					.run(excess).changes;
			}
		}
		return removed;
	}

	/**
	 * Run `fn` inside a single SQLite transaction so a mid-batch failure rolls
	 * back every write of the batch. Manual BEGIN/COMMIT instead of
	 * db.transaction: the store's methods are async facades over synchronous
	 * better-sqlite3 calls, and db.transaction rejects promise-returning
	 * functions. Must not be nested (SQLite has no nested BEGIN).
	 */
	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	async search(query: string, limit: number): Promise<Experience[]> {
		const rows = this.db
			.prepare(`
				SELECT e.* FROM experiences_fts fts
				JOIN experiences e ON e.rowid = fts.rowid
				WHERE experiences_fts MATCH ?
				AND e.status = 'active'
				ORDER BY bm25(experiences_fts)
				LIMIT ?
			`)
			.all(query, limit) as ExperienceRow[];
		return rows.map(rowToExperience);
	}

	/**
	 * Insert a checkpoint row. INSERT OR IGNORE keeps retries idempotent:
	 * re-writing the same deterministic id is a no-op instead of a UNIQUE
	 * constraint failure (checkpoint ids hash their content, so the same id
	 * always carries the same content).
	 */
	async insertCheckpoint(checkpoint: Checkpoint): Promise<void> {
		this.db
			.prepare(`
				INSERT OR IGNORE INTO checkpoints (id, kind, epoch, metric, snapshot, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(
				checkpoint.id,
				checkpoint.kind,
				checkpoint.epoch,
				checkpoint.metric,
				checkpoint.snapshot,
				checkpoint.createdAt,
			);
	}

	async getCheckpoint(id: string): Promise<Checkpoint | null> {
		const row = this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as CheckpointRow | undefined;
		if (!row) return null;
		return rowToCheckpoint(row);
	}

	async getLatestCheckpoint(kind: string): Promise<Checkpoint | null> {
		const row = this.db
			.prepare("SELECT * FROM checkpoints WHERE kind = ? ORDER BY epoch DESC, created_at DESC LIMIT 1")
			.get(kind) as CheckpointRow | undefined;
		if (!row) return null;
		return rowToCheckpoint(row);
	}

	/**
	 * Record a request trace (O spec R1). Two-phase upsert: phase 1 (retrieval)
	 * inserts the row, phase 2 (completion) updates the same row by request_id
	 * without touching phase-1 fields. Later phases may omit any field.
	 */
	async recordRequestTrace(input: RequestTraceInput): Promise<void> {
		this.db
			.prepare(`
				INSERT INTO request_traces
					(request_id, ts, model, stream, retrieved_count, retrieved_ids, retrieved_kinds, hit,
					 finish_reason, prompt_tokens, completion_tokens, latency_ms, error)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(request_id) DO UPDATE SET
					finish_reason = COALESCE(excluded.finish_reason, request_traces.finish_reason),
					prompt_tokens = COALESCE(excluded.prompt_tokens, request_traces.prompt_tokens),
					completion_tokens = COALESCE(excluded.completion_tokens, request_traces.completion_tokens),
					latency_ms = COALESCE(excluded.latency_ms, request_traces.latency_ms),
					error = COALESCE(excluded.error, request_traces.error)
			`)
			.run(
				input.requestId,
				input.ts ?? new Date().toISOString(),
				input.model ?? "",
				input.stream ? 1 : 0,
				input.retrievedCount ?? 0,
				JSON.stringify(input.retrievedIds ?? []),
				JSON.stringify(input.retrievedKinds ?? []),
				input.hit ? 1 : 0,
				input.finishReason ?? null,
				input.promptTokens ?? null,
				input.completionTokens ?? null,
				input.latencyMs ?? null,
				input.error ?? null,
			);
	}

	/** Aggregate hit-rate stats over the trailing window (O spec R2). */
	async getHitRateStats(windowHours: number, now: Date = new Date()): Promise<HitRateStats> {
		const cutoff = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
		const totals = this.db
			.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(hit),0) AS hits FROM request_traces WHERE ts >= ?")
			.get(cutoff) as { total: number; hits: number };
		const daily = this.db
			.prepare(
				"SELECT substr(ts,1,10) AS day, COUNT(*) AS total, COALESCE(SUM(hit),0) AS hits FROM request_traces WHERE ts >= ? GROUP BY day ORDER BY day",
			)
			.all(cutoff) as { day: string; total: number; hits: number }[];
		const recent = this.db
			.prepare(
				"SELECT request_id AS requestId, ts, model, stream, retrieved_count AS retrievedCount, hit, finish_reason AS finishReason, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, latency_ms AS latencyMs, error FROM request_traces WHERE ts >= ? ORDER BY ts DESC LIMIT 20",
			)
			.all(cutoff) as Record<string, unknown>[];
		// byKind: expand the JSON retrieved_kinds arrays in JS (window is small).
		const kindRows = this.db
			.prepare("SELECT retrieved_kinds AS kinds FROM request_traces WHERE ts >= ? AND hit = 1")
			.all(cutoff) as { kinds: string }[];
		const kindCounts = new Map<string, number>();
		for (const row of kindRows) {
			for (const kind of JSON.parse(row.kinds) as string[]) {
				kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
			}
		}
		const byKind = [...kindCounts.entries()]
			.map(([kind, cnt]) => ({ kind, cnt }))
			.sort((a, b) => a.kind.localeCompare(b.kind));
		return {
			windowHours,
			total: totals.total,
			hits: totals.hits,
			hitRate: totals.total > 0 ? totals.hits / totals.total : 0,
			byKind,
			daily,
			recent,
		};
	}

	close(): void {
		this.db.close();
	}
}
