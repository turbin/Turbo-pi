import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { createServer } from "../src/server.ts";

const DUMP_PATH = "/tmp/agent-server-request.json";

function makeStore(): ExperienceStore {
	const store = new ExperienceStore(":memory:");
	void store.initSchema();
	return store;
}

function postChatCompletion(app: ReturnType<typeof createServer>) {
	return app.inject({
		method: "POST",
		url: "/v1/chat/completions",
		payload: { model: "agent-auto", messages: [{ role: "user", content: "hi" }] },
	});
}

describe("server /v1/chat/completions debug dump", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(DUMP_PATH, { force: true });
	});

	it("does not dump the request body to /tmp by default", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "");
		rmSync(DUMP_PATH, { force: true });
		// No gateway is listening, so the request fails downstream with 502;
		// the dump (or its absence) happens before that.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = createServer({ store: makeStore(), gatewayUrl: "http://127.0.0.1:1" });
		const res = await postChatCompletion(app);
		expect(res.statusCode).toBe(502);
		expect(existsSync(DUMP_PATH)).toBe(false);
		await app.close();
	});

	it("dumps the request body when AGENT_SERVER_DEBUG_DUMP=1", async () => {
		vi.stubEnv("AGENT_SERVER_DEBUG_DUMP", "1");
		rmSync(DUMP_PATH, { force: true });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no gateway"));
		const app = createServer({ store: makeStore(), gatewayUrl: "http://127.0.0.1:1" });
		const res = await postChatCompletion(app);
		expect(res.statusCode).toBe(502);
		expect(existsSync(DUMP_PATH)).toBe(true);
		await app.close();
	});
});
