import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { createServer } from "../../src/server.ts";
import type { Experience } from "../../src/types.ts";

/**
 * issue-013 回归：requestId 碰撞致 request_traces 跨日静默合并。
 *
 * 根因：requestId 取自 Fastify 每进程 base-36 计数器（server.ts），实例
 * 重启即重置、8789/8790 双实例同日各自从 1 起；recordRequestTrace 两阶段
 * upsert 的 ON CONFLICT 只更新 completion 字段——跨日/跨实例请求被静默
 * 合并成一行，D2-D7 检索记录全失。
 *
 * 修复（F0 批次）：requestId 改 randomUUID；落实际注入集（injected_ids）；
 * task_id 透传（harness→session 头→request_traces）；/api/stream 纳入
 * trace 落库；旧库最小迁移（PRAGMA + ALTER TABLE ADD COLUMN）。
 *
 * 本文件断言（先红后绿）：
 * 1. 相邻两次请求 requestId 不同且为 UUID（非 req-N 计数器序列）；
 * 2. 两阶段 upsert 不覆盖 retrieved/injected 字段（合并哨兵）；
 * 3. injected_ids ⊆ retrieved_ids（真实请求链路）；
 * 4. task_id 从请求体透传到 session 头 metadata 与 trace 行（可空）；
 * 5. /api/stream 纳入 trace 落库（不再豁免）；
 * 6. 旧库迁移：缺列库 initSchema 后自动补列，旧行读回安全默认值。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATEWAY_URL = "http://127.0.0.1:8787";

function makeExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "exp-1",
		type: "EVIDENCE",
		title: "你好问候偏好",
		payload: { text: "用户说你好时偏好简洁的中文回复" },
		quality: 0.9,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "sess-0",
		sourceEntryId: "entry-0",
		contentHash: "hash-0",
		createdAt: "2026-07-19T00:00:00.000Z",
		...overrides,
	};
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function mockGatewayFetch(bodyFactory: () => ReadableStream<Uint8Array>, ok = true, status = 200) {
	// Fresh Response per fetch call: a consumed SSE body stream cannot be replayed.
	const mock = vi.fn(() =>
		Promise.resolve({ ok, status, statusText: ok ? "OK" : "Internal Server Error", body: bodyFactory() }),
	);
	vi.stubGlobal("fetch", mock);
	return mock;
}

describe("issue-013: request id collision and trace merge", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-issue013-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function readSessionEntries(): Record<string, any>[] {
		const files = readdirSync(sessionDir);
		expect(files).toHaveLength(1);
		return readFileSync(join(sessionDir, files[0]), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	function postChatCompletion(payload: Record<string, unknown>) {
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });
		return app.inject({ method: "POST", url: "/v1/chat/completions", payload });
	}

	it("assigns a fresh UUID request id per request, not a per-process counter", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(() => sseStream(sseChunks));

		const res1 = await postChatCompletion({ model: "agent-auto", messages: [{ role: "user", content: "hi" }] });
		const res2 = await postChatCompletion({ model: "agent-auto", messages: [{ role: "user", content: "hi" }] });
		expect(res1.statusCode).toBe(200);
		expect(res2.statusCode).toBe(200);

		const id1 = res1.headers["x-request-id"];
		const id2 = res2.headers["x-request-id"];
		// 非计数器序列：必须是 UUID（旧代码是 Fastify 每进程 req-N 计数器）。
		expect(id1).toMatch(UUID_RE);
		expect(id2).toMatch(UUID_RE);
		expect(id1).not.toMatch(/^req-\d+$/);
		expect(id2).not.toMatch(/^req-\d+$/);
		expect(id1).not.toBe(id2);

		// 两条请求各自成行（旧代码跨日/跨实例同 id 会静默合并成一行）。
		const stats = await store.getHitRateStats(1);
		const rows = stats.recent.filter((r) => r.requestId === id1 || r.requestId === id2);
		expect(rows).toHaveLength(2);
	});

	it("two-phase upsert keeps retrieved_ids and injected_ids without clobbering", async () => {
		// 阶段一：检索落 retrieved_ids（首写值不可被覆盖）。
		await store.recordRequestTrace({
			requestId: "req-2p",
			ts: "2026-08-10T00:00:00.000Z",
			model: "m",
			stream: true,
			retrievedCount: 2,
			retrievedIds: ["exp-a", "exp-b"],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
		});
		// 阶段一点五：注入组装后补写 injected_ids。
		await store.recordRequestTrace({ requestId: "req-2p", injectedIds: ["exp-a"] });
		// 阶段二：completion 字段。
		await store.recordRequestTrace({ requestId: "req-2p", finishReason: "stop", promptTokens: 10, latencyMs: 5 });

		const stats = await store.getHitRateStats(24 * 30, new Date("2026-08-11T00:00:00.000Z"));
		expect(stats.total).toBe(1);
		const row = stats.recent[0];
		expect(JSON.parse(row.retrievedIds as string)).toEqual(["exp-a", "exp-b"]);
		expect(JSON.parse(row.injectedIds as string)).toEqual(["exp-a"]);
		expect(row.finishReason).toBe("stop");
		expect(row.promptTokens).toBe(10);
		expect(row.latencyMs).toBe(5);
	});

	it("colliding ids never merge phase-1 fields (merge sentinel)", async () => {
		// 旧代码故障场景：跨日/跨实例同 id 重写阶段一 → ON CONFLICT 只更新
		// completion 字段，ts/retrieved_ids 永久保留首写值 → D2-D7 检索记录全失。
		await store.recordRequestTrace({
			requestId: "req-merge",
			ts: "2026-08-10T00:00:00.000Z",
			model: "m1",
			retrievedCount: 1,
			retrievedIds: ["exp-day1"],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
		});
		await store.recordRequestTrace({
			requestId: "req-merge",
			ts: "2026-08-11T00:00:00.000Z",
			model: "m2",
			retrievedCount: 2,
			retrievedIds: ["exp-day2"],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
		});
		// 阶段一字段保持首写值：合并哨兵保证同 id 冲突时检索记录不被覆盖。
		const stats = await store.getHitRateStats(24 * 30, new Date("2026-08-12T00:00:00.000Z"));
		expect(stats.total).toBe(1);
		const row = stats.recent[0];
		expect(row.ts).toBe("2026-08-10T00:00:00.000Z");
		expect(JSON.parse(row.retrievedIds as string)).toEqual(["exp-day1"]);
		expect(row.model).toBe("m1");
	});

	it("records injected card ids as a subset of retrieved ids through the real server", async () => {
		await store.insert(
			makeExperience({
				id: "exp-ev",
				title: "你好问候偏好",
				payload: { text: "用户说你好时偏好简洁的中文回复" },
			}),
		);
		await store.insert(
			makeExperience({
				id: "exp-method",
				type: "ABILITY",
				title: "你好任务处理流程",
				payload: { role: "Method", procedure: "1) 先确认输入 2) 再逐步执行" },
			}),
		);
		await store.insert(
			makeExperience({
				id: "exp-guard",
				type: "ABILITY",
				title: "你好边界",
				payload: { role: "Guard", boundary: "不得在未确认前直接输出" },
			}),
		);
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(() => sseStream(sseChunks));

		const res = await postChatCompletion({ model: "agent-auto", messages: [{ role: "user", content: "你好" }] });
		expect(res.statusCode).toBe(200);

		const stats = await store.getHitRateStats(1);
		const row = stats.recent[0];
		expect(row.retrievedCount).toBeGreaterThan(0);
		const retrieved = JSON.parse(row.retrievedIds as string) as string[];
		const injected = JSON.parse(row.injectedIds as string) as string[];
		// 实际注入集非空且是检索集的子集（注入只可能来自检索结果）。
		expect(injected.length).toBeGreaterThan(0);
		expect(retrieved).toEqual(expect.arrayContaining(injected));

		// 对照臂（injection off）：无注入集。
		await postChatCompletion({
			model: "agent-auto",
			messages: [{ role: "user", content: "你好" }],
			injection: false,
		});
		const control = (await store.getHitRateStats(1)).recent[0];
		expect(control.retrievedCount).toBe(0);
		expect(JSON.parse(control.injectedIds as string)).toEqual([]);
	});

	it("threads task_id into session metadata and the trace row (nullable for plain clients)", async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(() => sseStream(sseChunks));

		const res = await postChatCompletion({
			model: "agent-auto",
			messages: [{ role: "user", content: "do it" }],
			task_id: "task_00042",
		});
		expect(res.statusCode).toBe(200);
		const requestId = res.headers["x-request-id"];

		const stats = await store.getHitRateStats(1);
		const row = stats.recent.find((r) => r.requestId === requestId)!;
		expect(row).toBeDefined();
		expect(row.taskId).toBe("task_00042");

		// session 头 metadata 携带 taskId（F2 归因 join 键）。
		const sessionHeader = readSessionEntries()[0];
		expect(sessionHeader.metadata.taskId).toBe("task_00042");

		// 不带 task_id 的客户端（生产 pi）不受影响：taskId 为空。
		mockGatewayFetch(() => sseStream(sseChunks));
		const resPlain = await postChatCompletion({ model: "agent-auto", messages: [{ role: "user", content: "hi" }] });
		const plainRow = (await store.getHitRateStats(1)).recent.find(
			(r) => r.requestId === resPlain.headers["x-request-id"],
		)!;
		expect(plainRow.taskId).toBe("");
	});

	it("records request traces for /api/stream with a UUID request id (no longer exempt)", async () => {
		await store.insert(makeExperience());
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
			"data: [DONE]\n\n",
		];
		mockGatewayFetch(() => sseStream(sseChunks));
		const app = createServer({ store, gatewayUrl: GATEWAY_URL, sessionDir });

		const resp = await app.inject({
			method: "POST",
			url: "/api/stream",
			payload: {
				model: {
					id: "agent-auto",
					api: "openai-completions",
					provider: "local",
					baseUrl: "http://127.0.0.1:8367/v1",
				},
				context: { messages: [{ role: "user", content: "你好" }] },
				options: {},
				taskId: "task-stream-1",
			},
		});
		expect(resp.statusCode).toBe(200);
		const requestId = resp.headers["x-request-id"];
		expect(requestId).toMatch(UUID_RE);

		const stats = await store.getHitRateStats(1);
		const row = stats.recent.find((r) => r.requestId === requestId)!;
		expect(row).toBeDefined();
		expect(row.hit).toBe(1);
		expect(row.retrievedCount).toBe(1);
		expect(row.taskId).toBe("task-stream-1");
		const streamRetrieved = JSON.parse(row.retrievedIds as string) as string[];
		const streamInjected = JSON.parse(row.injectedIds as string) as string[];
		expect(streamRetrieved).toEqual(expect.arrayContaining(streamInjected));
		await app.close();
	});

	it("migrates an old-schema db by adding injected_ids/task_id with safe defaults", async () => {
		const dbPath = join(dir, "old.db");
		{
			// 模拟 C 阶段及以前的旧库：request_traces 无 injected_ids/task_id 列。
			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE request_traces (
					request_id TEXT PRIMARY KEY,
					ts TEXT NOT NULL,
					model TEXT NOT NULL,
					stream INTEGER NOT NULL DEFAULT 0,
					retrieved_count INTEGER NOT NULL DEFAULT 0,
					retrieved_ids TEXT NOT NULL DEFAULT '[]',
					retrieved_kinds TEXT NOT NULL DEFAULT '[]',
					hit INTEGER NOT NULL DEFAULT 0,
					finish_reason TEXT,
					prompt_tokens INTEGER,
					completion_tokens INTEGER,
					latency_ms INTEGER,
					error TEXT
				);
			`);
			db.prepare(
				"INSERT INTO request_traces (request_id, ts, model) VALUES ('old-1', '2026-08-01T00:00:00.000Z', 'm')",
			).run();
			db.close();
		}

		const oldStore = new ExperienceStore(dbPath);
		await oldStore.initSchema();

		// 迁移补列。
		const cols = new Database(dbPath).prepare("PRAGMA table_info(request_traces)").all() as { name: string }[];
		expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["injected_ids", "task_id"]));

		// 旧行读回安全默认值；新字段可正常写入。
		await oldStore.recordRequestTrace({
			requestId: "new-1",
			ts: "2026-08-01T12:00:00.000Z",
			model: "m",
			retrievedCount: 1,
			retrievedIds: ["a"],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
			injectedIds: ["a"],
			taskId: "task-9",
		});
		const stats = await oldStore.getHitRateStats(24 * 60, new Date("2026-08-02T00:00:00.000Z"));
		const oldRow = stats.recent.find((r) => r.requestId === "old-1")!;
		const newRow = stats.recent.find((r) => r.requestId === "new-1")!;
		expect(JSON.parse(oldRow.injectedIds as string)).toEqual([]);
		expect(oldRow.taskId).toBe("");
		expect(JSON.parse(newRow.injectedIds as string)).toEqual(["a"]);
		expect(newRow.taskId).toBe("task-9");
		oldStore.close();
	});
});
