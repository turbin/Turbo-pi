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

export interface ExperienceStoreOptions {
	/**
	 * M10 (adversarial review 2026-08-09): read-only snapshot database for
	 * RETRIEVAL reads only (search/listActive). A batch run pins the
	 * experience set it was started with; live writes (evolution promotion,
	 * TTL cleanup, scheduler) keep going to the live database so the
	 * learning loop is unaffected. The snapshot file must be created by
	 * the runner before the server starts (eval/snapshot_store.py).
	 *
	 * 写路径服务查询（getById/getByContentHash——offline ETL/verifier 的
	 * 去重）一律读 live 库，绝不读快照（issue-006）：否则快照之后写入的
	 * 经验在去重查询中不可见，导致重复晋升/重复入库。
	 */
	snapshotPath?: string;
}

interface ExperienceRow {
	id: string;
	type: Experience["type"];
	title: string;
	payload: string;
	quality: number;
	confidence?: number;
	rescore_excluded_batches?: number;
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
		// F2 (T3): 旧库/旧快照无新列 → 读回 COALESCE 默认（confidence=0.5, 排除计数=0）。
		confidence: row.confidence ?? 0.5,
		rescoreExcludedBatches: row.rescore_excluded_batches ?? 0,
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
	/**
	 * T4 (preview.html §9): final re-ranked scores of the retrieved items,
	 * positionally aligned with retrievedIds (retrieve()'s returned score).
	 * Written in the same phase-1 (retrieval) upsert; COALESCE merge keeps it
	 * from being clobbered by later phases.
	 */
	retrievedScores?: number[];
	retrievedKinds?: string[];
	hit?: boolean;
	/**
	 * F0 (issue-013): the card ids actually injected into the prompt
	 * (buildInjection's EVIDENCE pool + Method/Guard top-5 after truncation;
	 * SKILL/SOP live on separate channels and are excluded). Written in a
	 * phase-1.5 upsert after injection assembly; COALESCE merge keeps it
	 * from clobbering or being clobbered by the other phases.
	 */
	injectedIds?: string[];
	/**
	 * F0 (issue-013): caller-supplied task id (eval/campaign.py extra_body)
	 * joining task scores to requests; nullable — production pi clients that
	 * do not send one stay unaffected.
	 */
	taskId?: string;
	/**
	 * T4 (preview.html §9): injected-assembly token estimate (injection.ts
	 * ceil(chars/4) heuristic). Explicit 0 (injection off / nothing spliced)
	 * vs undefined (phase omits it) distinguished by the COALESCE sentinel;
	 * NULL for pre-T4 rows.
	 */
	injectedTokens?: number;
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
	/**
	 * F2 (T3): schema version for experiences.confidence /
	 * rescore_excluded_batches migrations; T4 adds request_traces.
	 * retrieved_scores / injected_tokens. initSchema ensures the columns
	 * (PRAGMA table_info + ALTER, M1 pattern) and stamps user_version.
	 */
	static readonly SCHEMA_VERSION = 2;

	private db: Database.Database;
	private readDb: Database.Database;

	constructor(path: string, opts: ExperienceStoreOptions = {}) {
		this.db = new Database(path);
		// M10: snapshot mode serves reads from a frozen copy of the experience
		// tables; the live db stays the single writer.
		this.readDb = opts.snapshotPath ? new Database(opts.snapshotPath, { readonly: true }) : this.db;
	}

	async initSchema(): Promise<void> {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS experiences (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL CHECK (type IN ('SKILL','SOP','ABILITY','EVIDENCE')),
				title TEXT NOT NULL,
				payload TEXT NOT NULL,
				quality REAL NOT NULL DEFAULT 0,
				-- F2 (T3): 实战归因置信度 [0,1]，默认 0.5；降权卡沉底（检索排序加权）。
				confidence REAL NOT NULL DEFAULT 0.5,
				-- F2 (T3): 复升排除计数——人工降级通道设置，每批递减，N 批后恢复复评资格。
				rescore_excluded_batches INTEGER NOT NULL DEFAULT 0,
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
			-- F0 (issue-013): injected_ids = card ids actually injected into the
			-- prompt; task_id = harness-supplied task id for attribution joins.
			CREATE TABLE IF NOT EXISTS request_traces (
				request_id TEXT PRIMARY KEY,
				ts TEXT NOT NULL,
				model TEXT NOT NULL,
				stream INTEGER NOT NULL DEFAULT 0,
				retrieved_count INTEGER NOT NULL DEFAULT 0,
				retrieved_ids TEXT NOT NULL DEFAULT '[]',
				-- T4 (preview.html §9): 重排后最终分数，与 retrieved_ids 按位对齐。
				retrieved_scores TEXT NOT NULL DEFAULT '[]',
				retrieved_kinds TEXT NOT NULL DEFAULT '[]',
				hit INTEGER NOT NULL DEFAULT 0,
				injected_ids TEXT NOT NULL DEFAULT '[]',
				-- T4 (preview.html §9): 注入组装 token 估计（ceil(chars/4) 启发式）；
				-- 可空：旧行/未到注入阶段保持 NULL，注入关闭显式写 0。
				injected_tokens INTEGER,
				task_id TEXT,
				finish_reason TEXT,
				prompt_tokens INTEGER,
				completion_tokens INTEGER,
				latency_ms INTEGER,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_request_traces_ts ON request_traces(ts);
		`);
		// F0 (issue-013): minimal migration for pre-F0 databases — the C-stage
		// request_traces lacks injected_ids/task_id. PRAGMA table_info check +
		// ALTER TABLE ADD COLUMN keeps old stores compatible; the NOT NULL
		// DEFAULT '[]' backfills existing rows so readers never see NULL. Only
		// the live db is migrated: initSchema never touches the snapshot db
		// (opened readonly, snapshot semantics preserved).
		const traceCols = this.db.prepare("PRAGMA table_info(request_traces)").all() as { name: string }[];
		const hasTraceCol = (name: string) => traceCols.some((c) => c.name === name);
		if (!hasTraceCol("injected_ids")) {
			this.db.exec("ALTER TABLE request_traces ADD COLUMN injected_ids TEXT NOT NULL DEFAULT '[]'");
		}
		if (!hasTraceCol("task_id")) {
			this.db.exec("ALTER TABLE request_traces ADD COLUMN task_id TEXT");
		}
		// F2 (T3): experiences 增 confidence/rescore_excluded_batches——PRAGMA + ALTER
		// 迁移（M1 模式）+ user_version 版本化；旧行读回列默认值（COALESCE 语义）。
		// T4: request_traces 增 retrieved_scores/injected_tokens——同模式，独立
		// 版本步（version < 2）；旧行 retrieved_scores 回填 '[]'、injected_tokens
		// 保持 NULL（NULL 兼容旧行）。快照（readDb）只读打开，从不被 ALTER
		// （M10 写侧-读侧分离）。
		const version = this.db.pragma("user_version", { simple: true }) as number;
		if (version < 1) {
			const expCols = this.db.prepare("PRAGMA table_info(experiences)").all() as { name: string }[];
			const hasExpCol = (name: string) => expCols.some((c) => c.name === name);
			if (!hasExpCol("confidence")) {
				this.db.exec("ALTER TABLE experiences ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5");
			}
			if (!hasExpCol("rescore_excluded_batches")) {
				this.db.exec("ALTER TABLE experiences ADD COLUMN rescore_excluded_batches INTEGER NOT NULL DEFAULT 0");
			}
		}
		if (version < 2) {
			const traceCols = this.db.prepare("PRAGMA table_info(request_traces)").all() as { name: string }[];
			const hasTraceCol = (name: string) => traceCols.some((c) => c.name === name);
			if (!hasTraceCol("retrieved_scores")) {
				this.db.exec("ALTER TABLE request_traces ADD COLUMN retrieved_scores TEXT NOT NULL DEFAULT '[]'");
			}
			if (!hasTraceCol("injected_tokens")) {
				this.db.exec("ALTER TABLE request_traces ADD COLUMN injected_tokens INTEGER");
			}
		}
		this.db.pragma(`user_version = ${ExperienceStore.SCHEMA_VERSION}`);
	}

	async insert(exp: Experience): Promise<void> {
		this.db
			.prepare(`
				INSERT INTO experiences (id, type, title, payload, quality, confidence, rescore_excluded_batches, status, source_session, source_entry_id, content_hash, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				exp.id,
				exp.type,
				exp.title,
				JSON.stringify(exp.payload),
				exp.quality,
				exp.confidence,
				exp.rescoreExcludedBatches,
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
		// issue-006: 写路径服务查询读 live 库（offline/etl.ts 入库去重）。
		const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as ExperienceRow | undefined;
		if (!row) return null;
		return rowToExperience(row);
	}

	async getByContentHash(contentHash: string): Promise<Experience | null> {
		// issue-006: 写路径服务查询读 live 库（offline/verifier.ts 晋升去重）——
		// 快照模式下读冻结库会漏掉快照之后写入的经验，造成重复晋升。
		const row = this.db.prepare("SELECT * FROM experiences WHERE content_hash = ?").get(contentHash) as
			| ExperienceRow
			| undefined;
		if (!row) return null;
		return rowToExperience(row);
	}

	async promoteToActive(id: string, quality: number): Promise<void> {
		this.db.prepare("UPDATE experiences SET status = 'active', quality = ? WHERE id = ?").run(quality, id);
	}

	/**
	 * F2 (T3): 人工确认降级通道——把指定 active 卡降为 dormant 并打复升排除标记。
	 * 不自动执行：只由离线归因脚本（eval/attribution.py --demote）在人工确认
	 * 待降级清单后调用。降级不动 quality/confidence（降权由 --apply 另行写）。
	 * 返回实际降级的行数（未知 id 忽略）。
	 */
	async demoteToDormant(ids: string[], rescoreExcludeBatches: number): Promise<number> {
		return this.db
			.prepare(
				"UPDATE experiences SET status = 'dormant', rescore_excluded_batches = ? WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active'",
			)
			.run(rescoreExcludeBatches, JSON.stringify(ids)).changes;
	}

	/**
	 * F2 (T3): 每运行一批进化，递减所有复升排除计数（>0 者 -1，钳到 0）——
	 * N 批后 dormant 卡恢复 runDormantRescore 自评复评资格。返回递减行数。
	 */
	async decrementRescoreExclusions(): Promise<number> {
		return this.db
			.prepare(
				"UPDATE experiences SET rescore_excluded_batches = rescore_excluded_batches - 1 WHERE rescore_excluded_batches > 0",
			)
			.run().changes;
	}

	async listActive(type: Experience["type"], limit: number): Promise<Experience[]> {
		const rows = this.readDb
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
		const rows = this.readDb
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
	 *
	 * F0 (issue-013): phase-1.5 (injection) writes injected_ids through the same
	 * upsert; the ON CONFLICT merge now also covers injected_ids/task_id via
	 * COALESCE, so no phase clobbers another and phase-1 fields (ts/model/
	 * retrieved_ids/hit) stay first-write-wins — the merge sentinel that
	 * prevents cross-day/cross-instance request_id collisions from silently
	 * discarding retrieval records.
	 */
	async recordRequestTrace(input: RequestTraceInput): Promise<void> {
		// injected_ids is NOT NULL with DEFAULT '[]', so the INSERT path binds the
		// empty-set default — but the ON CONFLICT path must distinguish "field
		// omitted" (phase-2 completion call) from "explicitly empty" (control arm
		// injection off): the former keeps the phase-1.5 value, the latter sets [].
		// A dedicated NULL-sentinel parameter in the DO UPDATE clause does that.
		// T4: retrieved_scores / injected_tokens 同款 sentinel 合并语义——
		// retrieved_scores 由 phase-1 写、其余 phase 省略不得覆盖；injected_tokens
		// 显式 0（注入关闭/无拼接）与省略（NULL 保持）分开。
		const injectedIdsUpdate = input.injectedIds === undefined ? null : JSON.stringify(input.injectedIds);
		const retrievedScoresUpdate = input.retrievedScores === undefined ? null : JSON.stringify(input.retrievedScores);
		const injectedTokensUpdate = input.injectedTokens === undefined ? null : input.injectedTokens;
		this.db
			.prepare(`
				INSERT INTO request_traces
					(request_id, ts, model, stream, retrieved_count, retrieved_ids, retrieved_scores, retrieved_kinds, hit,
					 injected_ids, injected_tokens, task_id, finish_reason, prompt_tokens, completion_tokens, latency_ms, error)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(request_id) DO UPDATE SET
					finish_reason = COALESCE(excluded.finish_reason, request_traces.finish_reason),
					prompt_tokens = COALESCE(excluded.prompt_tokens, request_traces.prompt_tokens),
					completion_tokens = COALESCE(excluded.completion_tokens, request_traces.completion_tokens),
					latency_ms = COALESCE(excluded.latency_ms, request_traces.latency_ms),
					error = COALESCE(excluded.error, request_traces.error),
					retrieved_scores = COALESCE(?, request_traces.retrieved_scores),
					injected_ids = COALESCE(?, request_traces.injected_ids),
					injected_tokens = COALESCE(?, request_traces.injected_tokens),
					task_id = COALESCE(excluded.task_id, request_traces.task_id)
			`)
			.run(
				input.requestId,
				input.ts ?? new Date().toISOString(),
				input.model ?? "",
				input.stream ? 1 : 0,
				input.retrievedCount ?? 0,
				JSON.stringify(input.retrievedIds ?? []),
				JSON.stringify(input.retrievedScores ?? []),
				JSON.stringify(input.retrievedKinds ?? []),
				input.hit ? 1 : 0,
				JSON.stringify(input.injectedIds ?? []),
				input.injectedTokens ?? null,
				input.taskId ?? null,
				input.finishReason ?? null,
				input.promptTokens ?? null,
				input.completionTokens ?? null,
				input.latencyMs ?? null,
				input.error ?? null,
				retrievedScoresUpdate,
				injectedIdsUpdate,
				injectedTokensUpdate,
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
				"SELECT request_id AS requestId, ts, model, stream, retrieved_count AS retrievedCount, retrieved_ids AS retrievedIds, retrieved_scores AS retrievedScores, COALESCE(injected_ids, '[]') AS injectedIds, injected_tokens AS injectedTokens, COALESCE(task_id, '') AS taskId, hit, finish_reason AS finishReason, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, latency_ms AS latencyMs, error FROM request_traces WHERE ts >= ? ORDER BY ts DESC LIMIT 20",
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
