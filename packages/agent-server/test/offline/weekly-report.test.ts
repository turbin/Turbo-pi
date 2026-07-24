import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { generateWeeklyReport } from "../../src/offline/weekly-report.ts";

function insertRow(
	db: Database.Database,
	row: {
		id: string;
		type: string;
		title?: string;
		payload?: Record<string, unknown>;
		quality?: number;
		status?: string;
		contentHash?: string;
		createdAt?: string;
	},
): void {
	db.prepare(
		`INSERT INTO experiences (id, type, title, payload, quality, status, source_session, source_entry_id, content_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
	).run(
		row.id,
		row.type,
		row.title ?? row.id,
		JSON.stringify(row.payload ?? {}),
		row.quality ?? 0.6,
		row.status ?? "active",
		row.contentHash ?? row.id,
		row.createdAt ?? "2026-07-24T00:00:00Z",
	);
}

function insertCheckpoint(db: Database.Database, id: string, epoch: number, metric: number): void {
	db.prepare(
		"INSERT INTO checkpoints (id, kind, epoch, metric, snapshot, created_at) VALUES (?, 'evolution', ?, ?, '{}', '')",
	).run(id, epoch, metric);
}

describe("generateWeeklyReport", () => {
	let dir: string;
	let db: Database.Database;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-report-"));
		const store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
		store.close();
		db = new Database(join(dir, "experience.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders inventory, quality buckets and checkpoint history", () => {
		insertRow(db, { id: "m1", type: "ABILITY", payload: { role: "Method" }, quality: 0.7 });
		insertRow(db, { id: "e1", type: "EVIDENCE", payload: { text: "t" }, quality: 0.55 });
		insertCheckpoint(db, "ckpt-1", 1784790000000, 4);
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("ABILITY");
		expect(report).toContain("Method");
		expect(report).toContain("ckpt-1");
		expect(report).toContain("0.6-0.8");
	});

	it("flags truncation review when Method+Guard stock reaches 6", () => {
		for (let i = 0; i < 6; i++) insertRow(db, { id: `m${i}`, type: "ABILITY", payload: { role: "Method" } });
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("截断评审");
	});

	it("does not flag truncation review below 6 Method+Guard", () => {
		for (let i = 0; i < 5; i++) insertRow(db, { id: `m${i}`, type: "ABILITY", payload: { role: "Method" } });
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).not.toContain("截断评审：触发");
	});

	it("flags coexisting-row review when a taskId has both ABILITY and EVIDENCE", () => {
		insertRow(db, { id: "a1", type: "ABILITY", payload: { role: "Method", taskId: "t-1" } });
		insertRow(db, { id: "e1", type: "EVIDENCE", payload: { taskId: "t-1" } });
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("并存行");
		expect(report).toContain("t-1");
	});

	it("flags C-heavy review when no new ABILITY in the trailing 28 days with checkpoints present", () => {
		insertRow(db, { id: "old", type: "ABILITY", payload: { role: "Method" }, createdAt: "2026-06-01T00:00:00Z" });
		insertCheckpoint(db, "ckpt-1", 1784790000000, 0);
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("C-重评审");
	});

	it("flags rescore remediation when dormant backlog exceeds 100", () => {
		for (let i = 0; i < 101; i++) {
			insertRow(db, { id: `d${i}`, type: "EVIDENCE", status: "dormant", payload: { text: `t${i}` } });
		}
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("rescore 治理");
	});

	it("renders an empty database without crashing and without false flags", () => {
		const report = generateWeeklyReport(db, new Date("2026-07-24T12:00:00Z"));
		expect(report).toContain("库存概览");
		expect(report).not.toContain("截断评审：触发");
		expect(report).not.toContain("C-重评审：触发");
		expect(report).not.toContain("rescore 治理：触发");
	});
});
