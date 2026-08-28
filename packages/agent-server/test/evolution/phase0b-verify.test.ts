import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Phase0bVerifyReport, runCli } from "../../src/evolution/cli.ts";
import { type EvolutionParameter, loadParameters } from "../../src/evolution/parameters.ts";

/**
 * P0b-T12: `verify-phase0b <dataDir>` reads the parameter registry from
 * <dataDir>/evolution.db (table `evolution_parameters`) when present, else
 * the built-in defaults, and exits 0/1/2. No TEK, no network.
 */

const CREATE_TABLE_SQL = `CREATE TABLE evolution_parameters (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	owner TEXT NOT NULL,
	value TEXT NOT NULL,
	rationale TEXT NOT NULL,
	version TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	fail_closed_default TEXT NOT NULL,
	status TEXT NOT NULL
)`;

function writeRegistryDb(dataDir: string, params: EvolutionParameter[]): void {
	const db = new Database(join(dataDir, "evolution.db"));
	try {
		db.exec(CREATE_TABLE_SQL);
		const insert = db.prepare(
			"INSERT INTO evolution_parameters (id, name, owner, value, rationale, version, expires_at, fail_closed_default, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const p of params) {
			insert.run(p.id, p.name, p.owner, p.value, p.rationale, p.version, p.expiresAt, p.failClosedDefault, p.status);
		}
	} finally {
		db.close();
	}
}

function parseReport(stdout: string): Phase0bVerifyReport {
	return JSON.parse(stdout) as Phase0bVerifyReport;
}

describe("verify-phase0b", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "pi-phase0b-verify-"));
	});

	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("exits 0 with valid defaults when no evolution.db exists", async () => {
		const result = await runCli(["verify-phase0b", dataDir]);
		expect(result.code).toBe(0);
		const report = parseReport(result.stdout);
		expect(report.ok).toBe(true);
		expect(report.missing).toEqual([]);
		expect(report.invalid).toEqual([]);
		expect(report.expired).toEqual([]);
	});

	it("exits 0 when evolution.db has no parameters table (defaults)", async () => {
		const db = new Database(join(dataDir, "evolution.db"));
		db.close();
		const result = await runCli(["verify-phase0b", dataDir]);
		expect(result.code).toBe(0);
		expect(parseReport(result.stdout).ok).toBe(true);
	});

	it("exits 1 with the missing list when a parameter is absent", async () => {
		writeRegistryDb(
			dataDir,
			loadParameters().filter((p) => p.id !== "P5"),
		);
		const result = await runCli(["verify-phase0b", dataDir]);
		expect(result.code).toBe(1);
		const report = parseReport(result.stdout);
		expect(report.ok).toBe(false);
		expect(report.missing).toEqual(["P5"]);
	});

	it("exits 1 with the expired list when a parameter is expired", async () => {
		writeRegistryDb(
			dataDir,
			loadParameters().map((p) =>
				p.id === "P3" ? { ...p, expiresAt: "2020-01-01T00:00:00.000Z", status: "expired" as const } : p,
			),
		);
		const result = await runCli(["verify-phase0b", dataDir]);
		expect(result.code).toBe(1);
		const report = parseReport(result.stdout);
		expect(report.ok).toBe(false);
		expect(report.expired).toEqual(["P3"]);
		expect(report.missing).toEqual([]);
	});

	it("exits 1 with the invalid list when a parameter row is malformed", async () => {
		writeRegistryDb(
			dataDir,
			loadParameters().map((p) => (p.id === "P8" ? { ...p, owner: "" } : p)),
		);
		const result = await runCli(["verify-phase0b", dataDir]);
		expect(result.code).toBe(1);
		const report = parseReport(result.stdout);
		expect(report.ok).toBe(false);
		expect(report.invalid).toEqual([{ id: "P8", errors: ["owner must be non-empty"] }]);
	});

	it("exits 2 on usage error (missing dataDir)", async () => {
		const result = await runCli(["verify-phase0b"]);
		expect(result.code).toBe(2);
	});

	it("exits 2 on unexpected flags", async () => {
		const result = await runCli(["verify-phase0b", dataDir, "--slot", "gen0"]);
		expect(result.code).toBe(2);
	});
});
