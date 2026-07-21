import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { etlSessionFiles } from "../../src/offline/etl.ts";

function writeJsonl(dir: string, name: string, entries: Record<string, unknown>[]): string {
	const path = join(dir, name);
	writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return path;
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

describe("etlSessionFiles", () => {
	it("extracts evidence candidates from pi-native session JSONL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-pi-native-"));
		const path = writeJsonl(dir, "session.jsonl", [
			{ type: "session", version: 3, id: "s-1", timestamp: "2026-07-20T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-20T00:00:01Z",
				message: { role: "user", content: "how do I fix the flaky test?", timestamp: 1 },
			},
			{
				type: "message",
				id: "m-2",
				parentId: "m-1",
				timestamp: "2026-07-20T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "The test flakes because the mock clock is shared across cases. Reset it in beforeEach to isolate every run.",
						},
					],
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m-3",
				parentId: "m-2",
				timestamp: "2026-07-20T00:00:03Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "bash",
					content: [{ type: "text", text: "vitest run passed: 42 tests, 0 failures after the fix." }],
					timestamp: 3,
				},
			},
		]);
		const store = await makeStore();
		const count = await etlSessionFiles([path], store);
		expect(count).toBeGreaterThan(0);

		const candidates = await store.search("mock", 10);
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.type).toBe("EVIDENCE");
			expect(c.status).toBe("dormant");
			expect(c.quality).toBe(0);
			expect(c.sourceSession).toBe(path);
			expect(typeof c.payload.text).toBe("string");
		}
		store.close();
	});

	it("extracts evidence candidates from the custom proxy-handler JSONL format", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-custom-"));
		const path = writeJsonl(dir, "session.jsonl", [
			{
				type: "request",
				data: {
					body: {
						model: { provider: "openai", id: "m" },
						context: {
							messages: [
								{ role: "user", content: "deploy the service" },
								{
									role: "assistant",
									content: [
										{
											type: "text",
											text: "First run the migration script before deploying the new version.",
										},
									],
								},
								{
									role: "toolResult",
									toolCallId: "tc-1",
									toolName: "bash",
									content: [{ type: "text", text: "migration completed: 3 statements applied successfully." }],
								},
							],
						},
						options: {},
					},
					retrieved: [],
				},
			},
			{ type: "response_started", data: {} },
			{ type: "event", data: { type: "start" } },
			{ type: "event", data: { type: "text_start", contentIndex: 0 } },
			{
				type: "event",
				data: { type: "text_delta", contentIndex: 0, delta: "Deployment finished without errors. " },
			},
			{ type: "event", data: { type: "text_delta", contentIndex: 0, delta: "Health checks all passed." } },
			{ type: "event", data: { type: "text_end", contentIndex: 0 } },
			{ type: "event", data: { type: "done", reason: "stop", usage: {} } },
			{ type: "response_completed", data: {} },
		]);
		const store = await makeStore();
		const count = await etlSessionFiles([path], store);
		expect(count).toBeGreaterThan(0);

		const fromRequest = await store.search("migration", 10);
		expect(fromRequest.length).toBeGreaterThan(0);
		const fromStream = await store.search("Deployment", 10);
		expect(fromStream.length).toBeGreaterThan(0);
		store.close();
	});

	it("mines the streamed reply from stream_event custom entries (Task 8 format)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-stream-event-"));
		const path = writeJsonl(dir, "session.jsonl", [
			{ type: "session", version: 3, id: "s-9", timestamp: "2026-07-21T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-21T00:00:01Z",
				message: { role: "user", content: "deploy the service", timestamp: 1 },
			},
			{
				type: "custom",
				id: "c-1",
				parentId: "m-1",
				timestamp: "2026-07-21T00:00:02Z",
				customType: "experience_injection",
				data: { retrieved: [] },
			},
			{
				type: "custom",
				id: "c-2",
				parentId: "c-1",
				timestamp: "2026-07-21T00:00:03Z",
				customType: "response_started",
			},
			{
				type: "custom",
				id: "c-3",
				parentId: "c-2",
				timestamp: "2026-07-21T00:00:04Z",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "Deployment finished without errors. " },
			},
			{
				type: "custom",
				id: "c-4",
				parentId: "c-3",
				timestamp: "2026-07-21T00:00:05Z",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "Health checks all passed." },
			},
			{
				type: "custom",
				id: "c-5",
				parentId: "c-4",
				timestamp: "2026-07-21T00:00:06Z",
				customType: "response_completed",
			},
		]);
		const store = await makeStore();
		const count = await etlSessionFiles([path], store);
		expect(count).toBeGreaterThan(0);
		const fromStream = await store.search("Deployment", 10);
		expect(fromStream.length).toBeGreaterThan(0);
		store.close();
	});

	it("mines the reply exactly once when both an assistant message entry and stream_event customs exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-dedup-"));
		const path = writeJsonl(dir, "session.jsonl", [
			{ type: "session", version: 3, id: "s-10", timestamp: "2026-07-21T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-21T00:00:01Z",
				message: { role: "user", content: "deploy the service", timestamp: 1 },
			},
			{
				type: "custom",
				id: "c-1",
				parentId: "m-1",
				timestamp: "2026-07-21T00:00:02Z",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "Deployment finished without errors. " },
			},
			{
				type: "custom",
				id: "c-2",
				parentId: "c-1",
				timestamp: "2026-07-21T00:00:03Z",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "Health checks all passed." },
			},
			{
				type: "message",
				id: "m-2",
				parentId: "c-2",
				timestamp: "2026-07-21T00:00:04Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Deployment finished without errors. Health checks all passed." }],
					timestamp: 2,
				},
			},
			{
				type: "custom",
				id: "c-3",
				parentId: "m-2",
				timestamp: "2026-07-21T00:00:05Z",
				customType: "response_completed",
			},
		]);
		const store = await makeStore();
		// Two sentences, mined from the message entry only — the stream_event
		// customs of the same reply must not be mined a second time.
		const count = await etlSessionFiles([path], store);
		expect(count).toBe(2);
		const fromMessage = await store.search("Deployment", 10);
		expect(fromMessage).toHaveLength(1);
		expect(fromMessage[0].sourceEntryId).toBe("m-2");
		const health = await store.search("Health", 10);
		expect(health).toHaveLength(1);
		expect(health[0].sourceEntryId).toBe("m-2");
		store.close();
	});

	it("is idempotent: rerunning on the same file inserts nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-idem-"));
		const path = writeJsonl(dir, "session.jsonl", [
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-07-20T00:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Always pin direct dependencies to exact versions in this repo." }],
					timestamp: 1,
				},
			},
		]);
		const store = await makeStore();
		const first = await etlSessionFiles([path], store);
		const second = await etlSessionFiles([path], store);
		expect(first).toBeGreaterThan(0);
		expect(second).toBe(0);
		store.close();
	});

	it("skips malformed lines and filters out short fragments", async () => {
		const dir = mkdtempSync(join(tmpdir(), "etl-robust-"));
		const path = join(dir, "session.jsonl");
		writeFileSync(
			path,
			[
				"{not json",
				JSON.stringify({
					type: "message",
					id: "m-1",
					parentId: null,
					timestamp: "2026-07-20T00:00:00Z",
					message: {
						role: "assistant",
						content: "ok. Sure! The cache must be invalidated after each schema change.",
						timestamp: 1,
					},
				}),
				"",
			].join("\n"),
		);
		const store = await makeStore();
		const count = await etlSessionFiles([path], store);
		expect(count).toBe(1);
		const found = await store.search("cache", 10);
		expect(found).toHaveLength(1);
		expect(found[0].payload.text).toContain("cache must be invalidated");
		store.close();
	});
});
