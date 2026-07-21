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
