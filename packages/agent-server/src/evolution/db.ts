import Database from "better-sqlite3";
import { APPEND_ONLY_TRIGGERS_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

/**
 * Phase 0a T1: evolution.db connection and migration entry.
 *
 * One instance per database file. Every connection enables foreign key
 * enforcement — SQLite defaults it OFF, and the frozen schema (§6) relies on
 * FK as part of its fail-closed contract (A2).
 */
export class EvolutionDb {
	readonly db: Database.Database;

	constructor(path: string) {
		this.db = new Database(path);
		this.db.pragma("foreign_keys = ON");
	}

	/**
	 * Migration entry: idempotently create tables, indexes and append-only
	 * triggers, then stamp `user_version`. Safe to call on every startup and
	 * in tests; future versions branch on `user_version` here.
	 */
	migrate(): void {
		this.db.exec(SCHEMA_SQL);
		this.db.exec(APPEND_ONLY_TRIGGERS_SQL);
		const version = this.db.pragma("user_version", { simple: true }) as number;
		if (version < SCHEMA_VERSION) {
			this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
		}
	}

	close(): void {
		this.db.close();
	}
}

/** Open (create if needed) an evolution.db and bring it to the current schema. */
export function openEvolutionDb(path: string): EvolutionDb {
	const evo = new EvolutionDb(path);
	evo.migrate();
	return evo;
}
