import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { logTrace } from "../src/observability.ts";
import { createServer } from "../src/server.ts";

const GATEWAY_URL = "http://127.0.0.1:8787";

describe("web monitor", () => {
	let dir: string;
	let store: ExperienceStore;
	let logPath: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-webmon-"));
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
		logPath = join(dir, "logs", "agent-server.log");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("GET /api/status/chain reports self, gateway, omlx and evolution", async () => {
		await store.insertCheckpoint({
			id: "ckpt-1",
			kind: "evolution",
			epoch: Date.now(),
			metric: 238,
			snapshot: "{}",
			createdAt: new Date().toISOString(),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				if (url.includes(":8787")) {
					return { ok: true, status: 200, json: async () => ({ data: [{ id: "agent-local" }] }) };
				}
				// omlx answers 401 (auth required) — any HTTP response means alive.
				return { ok: false, status: 401, json: async () => ({}) };
			}),
		);
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir: join(dir, "sessions"), logPath });

		const resp = await server.inject({ method: "GET", url: "/api/status/chain" });

		expect(resp.statusCode).toBe(200);
		const body = resp.json();
		expect(body.self.ok).toBe(true);
		expect(typeof body.self.uptimeS).toBe("number");
		expect(body.gateway.ok).toBe(true);
		expect(body.gateway.status).toBe(200);
		expect(body.gateway.models).toEqual(["agent-local"]);
		expect(body.omlx.ok).toBe(true);
		expect(body.omlx.status).toBe(401);
		expect(body.evolution.metric).toBe(238);
	});

	it("GET /api/status/chain marks unreachable services as down", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir: join(dir, "sessions"), logPath });

		const resp = await server.inject({ method: "GET", url: "/api/status/chain" });

		const body = resp.json();
		expect(body.self.ok).toBe(true);
		expect(body.gateway.ok).toBe(false);
		expect(body.omlx.ok).toBe(false);
		expect(body.evolution).toBeNull();
	});

	it("logTrace appends to the file sink and GET /api/logs tails it", async () => {
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir: join(dir, "sessions"), logPath });

		logTrace("req-1", "retrieval", { hit: 1, retrieved: 8 });
		logTrace("req-1", "done", { finish: "stop", tokens: "10/3" });

		const content = readFileSync(logPath, "utf-8");
		expect(content).toContain("req=req-1 phase=retrieval");
		expect(content).toContain("req=req-1 phase=done");

		const resp = await server.inject({ method: "GET", url: "/api/logs?lines=10" });
		expect(resp.statusCode).toBe(200);
		const lines = resp.json().lines as string[];
		// Line 0 is the startup line written by createServer.
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("phase=startup");
		expect(lines[1]).toContain("phase=retrieval");
		expect(lines[2]).toContain("phase=done");
	});

	it("GET /api/logs respects the lines limit and tolerates a missing file", async () => {
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir: join(dir, "sessions"), logPath });

		// Missing file (deleted after the startup line was written): empty list, not an error.
		rmSync(logPath, { force: true });
		let resp = await server.inject({ method: "GET", url: "/api/logs" });
		expect(resp.statusCode).toBe(200);
		expect(resp.json().lines).toEqual([]);

		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, Array.from({ length: 5 }, (_, i) => `line-${i}`).join("\n") + "\n");
		// lines=3 returns the LAST 3 lines in chronological order.
		resp = await server.inject({ method: "GET", url: "/api/logs?lines=3" });
		expect(resp.json().lines).toEqual(["line-2", "line-3", "line-4"]);
	});

	it("GET /dashboard serves the monitor page by default", async () => {
		const server = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir: join(dir, "sessions"), logPath });

		const resp = await server.inject({ method: "GET", url: "/dashboard" });

		expect(resp.statusCode).toBe(200);
		expect(resp.headers["content-type"]).toContain("text/html");
		expect(resp.body).toContain("/api/status/chain");
		expect(resp.body).toContain("/api/logs");
		expect(resp.body).toContain("/api/stats/hit-rate");
	});

	it("web=off disables dashboard, logs and chain with 404", async () => {
		const server = createServer({
			store,
			gatewayUrl: GATEWAY_URL,
			sessionDir: join(dir, "sessions"),
			logPath,
			web: false,
		});

		for (const url of ["/dashboard", "/api/logs", "/api/status/chain"]) {
			const resp = await server.inject({ method: "GET", url });
			expect(resp.statusCode).toBe(404);
		}
		// Data APIs stay available regardless of the web switch.
		const stats = await server.inject({ method: "GET", url: "/api/stats/hit-rate" });
		expect(stats.statusCode).toBe(200);
	});
});
