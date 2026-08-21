import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { type EtlResult, etlSessionFiles } from "../../src/offline/etl.ts";

/**
 * issue-018 回归：合成器（eval/synthesize_campaign_sessions.py）输出必须带
 * 与 session-writer v3 线上一致的 response_completed 闭合条目——否则 T6 完整
 * 性判据（etl.ts）判为"半截"整体隔离，dormant 挖掘断流（D1 实战 etlIsolated
 * =32/32, etlInserted=0）。
 *
 * fixture 按合成器新输出形态构造（synthesize_task 逐行验证过）：
 *   头 {"type":"session","version":3,"id":"<prefix>-<arm>-<task_id>",
 *       "metadata":{task_id,arm,day,score,domain}}（无 id/parentId/timestamp）
 *   消息 {"type":"message","message":{role,content}}（无 id/parentId/timestamp）
 *   闭合 {"type":"custom","customType":"response_completed",
 *       "id":"<uuid>","parentId":null,"timestamp":"<iso>"}
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

/** 与 synthesize_task 输出逐行同构的合成 session。 */
function synthSessionLines(): string[] {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "campaign-d1-experiment-task_00001_x",
			metadata: { task_id: "task_00001_x", arm: "experiment", day: 1, score: 0.8, domain: "office" },
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "system",
				content: "You are an office-automation agent. Complete the task using the bash tool.",
			},
		}),
		JSON.stringify({ type: "message", message: { role: "user", content: "do the thing" } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content:
					"The compliance checklist marks CTL-002 as implemented but the incident log shows it failed twice in production.",
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: "file.txt" },
		}),
		JSON.stringify({
			type: "custom",
			customType: "response_completed",
			id: "bfc00e7f-6b59-4884-994e-ce8a4c921305",
			parentId: null,
			timestamp: "2026-08-21T01:07:25.920717+00:00",
		}),
	];
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

describe("issue-018: synth session closure marker restores ETL intake", () => {
	it("mines a synthesizer-format session (header + messages + response_completed)", async () => {
		const dir = makeTempDir("issue018-");
		const path = join(dir, "experiment-task_00001_x.jsonl");
		writeFileSync(path, `${synthSessionLines().join("\n")}\n`);

		const store = await makeStore();
		const result: EtlResult = await etlSessionFiles([path], store);
		expect(result.inserted).toBeGreaterThanOrEqual(1);
		expect(result.isolated).toEqual([]);
	});

	it("closure entry matches the online session-writer shape (id/parentId/timestamp)", () => {
		const lines = synthSessionLines();
		const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
		expect(last.type).toBe("custom");
		expect(last.customType).toBe("response_completed");
		expect(typeof last.id).toBe("string");
		expect(last.parentId).toBeNull();
		expect(typeof last.timestamp).toBe("string");
	});
});
