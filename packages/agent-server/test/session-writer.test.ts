import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionWriter } from "../src/session-writer.ts";

/**
 * The target format is the pi-native session JSONL written by
 * `packages/agent/src/harness/session/jsonl-storage.ts`: a `session` header
 * (version 3) followed by tree entries (`{type, id, parentId, timestamp, ...}`)
 * with ISO 8601 timestamps and messages nested under a `message` payload.
 */
describe("SessionWriter (pi-native session JSONL)", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-"));
		path = join(dir, "session.jsonl");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function readEntries(writer: SessionWriter): Promise<Record<string, unknown>[]> {
		await writer.close();
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("writes a version-3 session header as the first line", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-1", cwd: "/tmp/work", timestamp: "2026-07-21T00:00:00.000Z" });
		const [header] = await readEntries(writer);
		expect(header).toEqual({
			type: "session",
			version: 3,
			id: "s-1",
			timestamp: "2026-07-21T00:00:00.000Z",
			cwd: "/tmp/work",
		});
	});

	it("includes optional parentSession and metadata in the header", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({
			id: "s-2",
			cwd: "/tmp/work",
			parentSession: "/sessions/parent.jsonl",
			metadata: { model: "agent-auto" },
		});
		const [header] = await readEntries(writer);
		expect(header?.parentSession).toBe("/sessions/parent.jsonl");
		expect(header?.metadata).toEqual({ model: "agent-auto" });
	});

	it("writes message entries with a nested message payload and ISO timestamp", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-3", cwd: "/tmp/work" });
		const id = writer.writeMessage({ role: "user", content: "hello", timestamp: 1 });
		const [, entry] = await readEntries(writer);
		expect(entry?.type).toBe("message");
		expect(entry?.id).toBe(id);
		expect(entry?.parentId).toBeNull();
		expect(typeof entry?.timestamp).toBe("string");
		expect(entry?.message).toEqual({ role: "user", content: "hello", timestamp: 1 });
	});

	it("chains parentId across entries so the file replays as a tree", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-4", cwd: "/tmp/work" });
		const userId = writer.writeMessage({ role: "user", content: "hi", timestamp: 1 });
		const injectionId = writer.writeCustomEntry("experience_injection", { retrieved: ["exp-1"] });
		const assistantId = writer.writeMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "openai-completions",
			provider: "local",
			model: "agent-auto",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const entries = await readEntries(writer);
		expect(new Set(entries.slice(1).map((e) => e.id)).size).toBe(3);
		expect(entries[1]?.parentId).toBeNull();
		expect(entries[2]?.parentId).toBe(userId);
		expect(entries[3]?.parentId).toBe(injectionId);
		expect(entries[3]?.id).toBe(assistantId);
	});

	it("writes custom entries with customType and data, and omits data when undefined", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-5", cwd: "/tmp/work" });
		writer.writeCustomEntry("experience_injection", { retrieved: ["exp-1"] });
		writer.writeCustomEntry("response_started");
		const [, withData, withoutData] = await readEntries(writer);
		expect(withData).toMatchObject({
			type: "custom",
			customType: "experience_injection",
			data: { retrieved: ["exp-1"] },
		});
		expect(withoutData).toMatchObject({ type: "custom", customType: "response_started" });
		expect("data" in (withoutData ?? {})).toBe(false);
	});

	it("defaults the header timestamp to now", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-6", cwd: "/tmp/work" });
		const [header] = await readEntries(writer);
		expect(typeof header?.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(header?.timestamp as string))).toBe(false);
	});

	it("rejects entries written before the session header", async () => {
		const writer = new SessionWriter(path);
		expect(() => writer.writeMessage({ role: "user", content: "hi", timestamp: 1 })).toThrow(/header/);
		expect(() => writer.writeCustomEntry("x")).toThrow(/header/);
		await writer.close();
	});

	it("rejects a second session header", async () => {
		const writer = new SessionWriter(path);
		writer.writeSessionHeader({ id: "s-7", cwd: "/tmp/work" });
		expect(() => writer.writeSessionHeader({ id: "s-8", cwd: "/tmp/work" })).toThrow(/header/);
		await writer.close();
	});
});
