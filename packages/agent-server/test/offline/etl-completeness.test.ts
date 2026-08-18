import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { type EtlResult, etlSessionFiles } from "../../src/offline/etl.ts";

/**
 * 台账 7（T6）：ETL session 完整性校验——半截 session 整体隔离不摄入。
 *
 * 完整性判据（pi-native）：session 头存在 + 流闭合标记
 * （response_completed / error / aborted custom entry）齐全 = 完整；
 * 有头无闭合标记 = 半截（落盘中断），整体隔离；无头文件（legacy P0
 * 格式）无完整性信号，维持现状摄入。行级 malformed 跳过语义不变。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

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

const HEADER = { type: "session", version: 3, id: "s-1", metadata: { task_id: "task_00091_x" } };
const ASSISTANT = {
	type: "message",
	id: "m-2",
	parentId: "m-1",
	message: {
		role: "assistant",
		content:
			"The compliance checklist marks CTL-002 as implemented but the incident log shows it failed twice in production.",
	},
};
const COMPLETED = { type: "custom", customType: "response_completed" };

describe("T6: ETL session completeness (台账 7)", () => {
	it("isolates a half-written session (header, no closure marker) and reports it", async () => {
		const dir = makeTempDir("etl-half-");
		const path = writeJsonl(dir, "half.jsonl", [HEADER, ASSISTANT]);
		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([path], store);
		expect(result.inserted).toBe(0);
		expect(result.isolated).toEqual([path]);
		expect(await store.listDormant("EVIDENCE", 100)).toHaveLength(0);
	});

	it("mines a complete session (header + response_completed)", async () => {
		const dir = makeTempDir("etl-complete-");
		const path = writeJsonl(dir, "complete.jsonl", [HEADER, ASSISTANT, COMPLETED]);
		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([path], store);
		expect(result.inserted).toBeGreaterThan(0);
		expect(result.isolated).toEqual([]);
	});

	it("treats error/aborted-closed sessions as complete (stream parts still mined)", async () => {
		const dir = makeTempDir("etl-closed-");
		const path = writeJsonl(dir, "error.jsonl", [
			HEADER,
			{ type: "message", id: "m-1", message: { role: "user", content: "do it" } },
			{
				type: "custom",
				customType: "stream_event",
				data: { type: "text_delta", contentIndex: 0, delta: "partial analysis of the checklist with evidence" },
			},
			{ type: "custom", customType: "error", data: { message: "boom" } },
		]);
		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([path], store);
		expect(result.inserted).toBeGreaterThan(0);
		expect(result.isolated).toEqual([]);
	});

	it("keeps mining legacy-format files without a session header (no completeness signal)", async () => {
		const dir = makeTempDir("etl-legacy-");
		const path = writeJsonl(dir, "legacy.jsonl", [
			{
				type: "request",
				data: {
					body: { context: { messages: [{ role: "assistant", content: "legacy assistant text with evidence" }] } },
				},
			},
		]);
		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([path], store);
		expect(result.inserted).toBeGreaterThan(0);
		expect(result.isolated).toEqual([]);
	});

	it("isolates only the incomplete file in a mixed batch", async () => {
		const dir = makeTempDir("etl-mixed-");
		const good = writeJsonl(dir, "good.jsonl", [HEADER, ASSISTANT, COMPLETED]);
		const half = writeJsonl(dir, "half.jsonl", [HEADER, ASSISTANT]);
		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([good, half], store);
		expect(result.inserted).toBeGreaterThan(0);
		expect(result.isolated).toEqual([half]);
	});
});
