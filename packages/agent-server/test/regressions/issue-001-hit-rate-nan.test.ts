import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_PAGE_HTML } from "../../src/dashboard-page.ts";
import { ExperienceStore } from "../../src/experience-store.ts";
import { createServer } from "../../src/server.ts";
import { STATS_PAGE_HTML } from "../../src/stats-page.ts";

/**
 * Regression for doc/issues-snapshot/issue-001-hit-rate-nan.md (2026-08-05,
 * user report): the stats/dashboard pages rendered "命中率 NaN%" and an empty
 * by-kind table because the page JS read snake_case fields (hit_rate/by_kind)
 * while /api/stats/hit-rate returns camelCase (hitRate/byKind).
 *
 * Contract: every top-level field the pages dereference on the hit-rate
 * response must exist in the API payload with the right type.
 */
describe("issue-001: hit-rate page/API field contract", () => {
	let dir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-issue001-"));
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("API returns numeric hitRate and byKind array (camelCase contract)", async () => {
		await store.recordRequestTrace({
			requestId: "req-1",
			model: "agent-local",
			stream: true,
			retrievedCount: 2,
			retrievedIds: ["a", "b"],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
		});
		const server = createServer({ store, sessionDir: join(dir, "sessions"), logPath: join(dir, "log.txt") });

		const resp = await server.inject({ method: "GET", url: "/api/stats/hit-rate?window_hours=24" });

		expect(resp.statusCode).toBe(200);
		const body = resp.json();
		expect(typeof body.hitRate).toBe("number");
		expect(body.hitRate).toBe(1);
		expect(Array.isArray(body.byKind)).toBe(true);
		expect(body.byKind[0]).toMatchObject({ kind: "EVIDENCE:null", cnt: 1 });
	});

	it("pages reference the camelCase fields, never the snake_case ghosts", () => {
		for (const page of [STATS_PAGE_HTML, DASHBOARD_PAGE_HTML]) {
			expect(page).toContain("d.hitRate");
			expect(page).not.toContain("d.hit_rate");
		}
		// Only the stats page renders the by-kind table.
		expect(STATS_PAGE_HTML).toContain("d.byKind");
		expect(STATS_PAGE_HTML).not.toContain("d.by_kind");
	});
});
