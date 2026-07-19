import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionWriter } from "../src/session-writer.js";

describe("SessionWriter", () => {
	it("writes JSONL entries", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-server-"));
		const path = join(dir, "session.jsonl");
		const writer = new SessionWriter(path);
		writer.write({ type: "request", data: { model: "m" } });
		writer.write({ type: "response", data: { id: "1" } });
		await writer.close();
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).type).toBe("request");
		rmSync(dir, { recursive: true });
	});
});
