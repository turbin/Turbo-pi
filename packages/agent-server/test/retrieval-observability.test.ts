import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, UserMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { buildInjection } from "../src/injection.ts";
import { retrieve } from "../src/retrieval.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

/**
 * T4（preview.html §9 Memory 层可观测性）：request_traces 增
 * retrieved_scores（JSON，与 retrieved_ids 按位对齐的重排后分数）与
 * injected_tokens（注入组装 token 估计，ceil(chars/4) 启发式），
 * 使 "Library changed → retrieval → score" 链条可分析。
 * 纯观测字段：不改检索/注入行为。
 */

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-t4-"));
	tempDirs.push(dir);
	return dir;
}

function makeExp(id: string, title: string, text: string): Experience {
	return {
		id,
		type: "EVIDENCE",
		title,
		payload: { text },
		quality: 0.8,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "session-1",
		sourceEntryId: `entry-${id}`,
		contentHash: `hash-${id}`,
		createdAt: new Date().toISOString(),
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

function mockGatewayFetch(body: ReadableStream<Uint8Array> | null) {
	const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", body });
	vi.stubGlobal("fetch", mock);
	return mock;
}

function traceRows(dbPath: string): Record<string, unknown>[] {
	return new Database(dbPath)
		.prepare(
			"SELECT request_id AS requestId, retrieved_ids AS retrievedIds, retrieved_scores AS retrievedScores, injected_tokens AS injectedTokens FROM request_traces",
		)
		.all() as Record<string, unknown>[];
}

describe("T4: retrieved_scores / injected_tokens migration (M1 pattern + user_version)", () => {
	it("migrates an old-schema db: new columns exist, old rows keep NULL/[] defaults", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "old.db");
		{
			// 模拟 T4 以前旧库：request_traces 无 retrieved_scores/injected_tokens。
			const db = new Database(dbPath);
			db.exec(`
				CREATE TABLE experiences (
					id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
					payload TEXT NOT NULL, quality REAL NOT NULL DEFAULT 0,
					confidence REAL NOT NULL DEFAULT 0.5,
					rescore_excluded_batches INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'active', branch_path TEXT,
					times_selected INTEGER NOT NULL DEFAULT 0,
					source_session TEXT NOT NULL, source_entry_id TEXT NOT NULL,
					content_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				CREATE TABLE request_traces (
					request_id TEXT PRIMARY KEY, ts TEXT NOT NULL, model TEXT NOT NULL,
					stream INTEGER NOT NULL DEFAULT 0, retrieved_count INTEGER NOT NULL DEFAULT 0,
					retrieved_ids TEXT NOT NULL DEFAULT '[]', retrieved_kinds TEXT NOT NULL DEFAULT '[]',
					hit INTEGER NOT NULL DEFAULT 0, injected_ids TEXT NOT NULL DEFAULT '[]',
					task_id TEXT, finish_reason TEXT, prompt_tokens INTEGER,
					completion_tokens INTEGER, latency_ms INTEGER, error TEXT
				);
			`);
			db.pragma("user_version = 1"); // F2 迁移已做过（confidence 列在）
			db.prepare(
				"INSERT INTO request_traces (request_id, ts, model, retrieved_count, retrieved_ids, hit) VALUES ('old-req', '2026-08-01T00:00:00Z', 'm', 2, '[\"e1\",\"e2\"]', 1)",
			).run();
			db.close();
		}

		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		const db = new Database(dbPath);
		const cols = db.prepare("PRAGMA table_info(request_traces)").all() as { name: string }[];
		expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["retrieved_scores", "injected_tokens"]));
		expect(db.pragma("user_version", { simple: true })).toBe(2);
		const old = db
			.prepare("SELECT retrieved_scores AS s, injected_tokens AS t FROM request_traces WHERE request_id = 'old-req'")
			.get() as { s: string; t: number | null };
		expect(old.s).toBe("[]"); // NOT NULL DEFAULT '[]' 回填
		expect(old.t).toBeNull(); // 旧行 injected_tokens 保持 NULL（NULL 兼容旧行）
		db.close();

		// 读路径：迁移后经 getHitRateStats（生产读入口）读取旧行不炸——
		// retrieved_scores 回填 '[]'、injected_tokens 为 NULL，字段齐全。
		const stats = await store.getHitRateStats(24, new Date("2026-08-01T01:00:00Z"));
		expect(stats.recent).toHaveLength(1);
		const oldRead = stats.recent[0] as { requestId: string; retrievedScores: string; injectedTokens: number | null };
		expect(oldRead.requestId).toBe("old-req");
		expect(oldRead.retrievedScores).toBe("[]");
		expect(oldRead.injectedTokens).toBeNull();

		// 幂等：重复 initSchema 不炸、不重复 ALTER。
		await store.initSchema();
		const cols2 = new Database(dbPath).prepare("PRAGMA table_info(request_traces)").all() as { name: string }[];
		expect(cols2.map((c) => c.name)).toEqual(expect.arrayContaining(["retrieved_scores", "injected_tokens"]));
		store.close();
	});
});

describe("T4: retrieved_scores land in request_traces aligned with retrieved_ids", () => {
	it("records the final re-ranked scores via the /v1 streaming path", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "experience.db");
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(makeExp("exp-1", "量子计算入门", "量子计算 的 量子计算 实验"));
		await store.insert(makeExp("exp-2", "量子计算进阶", "量子计算 算法"));
		mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir: join(dir, "sessions") });
		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: { model: "agent-auto", stream: true, messages: [{ role: "user", content: "量子计算" }] },
		});
		expect(res.statusCode).toBe(200);
		await app.close();

		// 期望分数 = retrieve() 的重排后最终分（cosine × confidence），顺序一致。
		const expected = await retrieve(store, "量子计算", 8);
		expect(expected.length).toBeGreaterThanOrEqual(2);
		const rows = traceRows(dbPath);
		expect(rows).toHaveLength(1);
		const ids = JSON.parse(rows[0]!.retrievedIds as string) as string[];
		const scores = JSON.parse(rows[0]!.retrievedScores as string) as number[];
		expect(ids).toEqual(expected.map((r) => r.experience.id));
		// 按位对齐：等长、每项分数一致、单调递减（重排序）。
		expect(scores).toEqual(expected.map((r) => r.score));
		expect(scores.length).toBe(ids.length);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
		// 注入组装也落库：token 估计为非负整数。
		expect(rows[0]!.injectedTokens).toBeTypeOf("number");
		expect(rows[0]!.injectedTokens as number).toBeGreaterThan(0);
		expect(Number.isInteger(rows[0]!.injectedTokens)).toBe(true);
		store.close();
	});

	it("injection-off control arm writes empty scores and injected_tokens=0", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "experience.db");
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(makeExp("exp-1", "量子计算入门", "量子计算 的 量子计算 实验"));
		mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir: join(dir, "sessions") });
		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: {
				model: "agent-auto",
				stream: true,
				injection: false,
				messages: [{ role: "user", content: "量子计算" }],
			},
		});
		expect(res.statusCode).toBe(200);
		await app.close();

		const rows = traceRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.retrievedIds as string)).toEqual([]);
		expect(JSON.parse(rows[0]!.retrievedScores as string)).toEqual([]);
		expect(rows[0]!.injectedTokens).toBe(0);
		store.close();
	});
});

describe("T4: /api/stream path lands the same observability fields (§9 双路径)", () => {
	const streamPayload = {
		model: { id: "agent-auto", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:8367/v1" },
		context: { messages: [{ role: "user", content: "量子计算" }] },
		options: {},
	};

	it("records retrieved_scores aligned with retrieved_ids and injected_tokens", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "experience.db");
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(makeExp("exp-1", "量子计算入门", "量子计算 的 量子计算 实验"));
		await store.insert(makeExp("exp-2", "量子计算进阶", "量子计算 算法"));
		mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir: join(dir, "sessions") });
		const res = await app.inject({ method: "POST", url: "/api/stream", payload: streamPayload });
		expect(res.statusCode).toBe(200);
		await app.close();

		const expected = await retrieve(store, "量子计算", 8);
		expect(expected.length).toBeGreaterThanOrEqual(2);
		const rows = traceRows(dbPath);
		expect(rows).toHaveLength(1);
		const ids = JSON.parse(rows[0]!.retrievedIds as string) as string[];
		const scores = JSON.parse(rows[0]!.retrievedScores as string) as number[];
		expect(ids).toEqual(expected.map((r) => r.experience.id));
		expect(scores).toEqual(expected.map((r) => r.score)); // 按位对齐
		expect(scores.length).toBe(ids.length);
		expect(scores).toEqual([...scores].sort((a, b) => b - a)); // 重排后单调
		expect(rows[0]!.injectedTokens as number).toBeGreaterThan(0);
		expect(Number.isInteger(rows[0]!.injectedTokens)).toBe(true);
		store.close();
	});

	it("injection-off control arm writes empty scores and injected_tokens=0", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "experience.db");
		const store = new ExperienceStore(dbPath);
		await store.initSchema();
		await store.insert(makeExp("exp-1", "量子计算入门", "量子计算 的 量子计算 实验"));
		mockGatewayFetch(
			sseStream([
				'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
				'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
				"data: [DONE]\n\n",
			]),
		);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir: join(dir, "sessions") });
		const res = await app.inject({
			method: "POST",
			url: "/api/stream",
			payload: { ...streamPayload, options: { injection: false } },
		});
		expect(res.statusCode).toBe(200);
		await app.close();

		const rows = traceRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.retrievedIds as string)).toEqual([]);
		expect(JSON.parse(rows[0]!.retrievedScores as string)).toEqual([]);
		expect(rows[0]!.injectedTokens).toBe(0);
		store.close();
	});
});

describe("T4: phase merge keeps phase-1/1.5 observability fields", () => {
	it("completion-phase upsert does not clobber retrieved_scores / injected_tokens", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.recordRequestTrace({
			requestId: "req-1",
			ts: "2026-08-19T00:00:00.000Z",
			model: "m",
			stream: true,
			retrievedCount: 2,
			retrievedIds: ["exp-a", "exp-b"],
			retrievedScores: [0.9, 0.42],
			retrievedKinds: ["EVIDENCE:null"],
			hit: true,
		});
		await store.recordRequestTrace({ requestId: "req-1", injectedIds: ["exp-a"], injectedTokens: 12 });
		// phase-2（completion）省略观测字段：COALESCE 合并不得覆盖 phase-1/1.5 值。
		await store.recordRequestTrace({
			requestId: "req-1",
			finishReason: "stop",
			promptTokens: 10,
			completionTokens: 5,
		});
		const stats = await store.getHitRateStats(24, new Date("2026-08-19T01:00:00.000Z"));
		const recent = stats.recent[0] as { retrievedScores: string; injectedTokens: number | null };
		expect(recent.retrievedScores).toBe(JSON.stringify([0.9, 0.42]));
		expect(recent.injectedTokens).toBe(12);
		store.close();
	});
});

describe("T4: injection token estimate (ceil(chars/4) heuristic)", () => {
	function userMsg(content: string): UserMessage {
		return { role: "user", content, timestamp: Date.now() };
	}

	function retrievedExps(...experiences: Experience[]) {
		return experiences.map((experience) => ({ experience, score: 1 }));
	}

	it("estimates ceil(chars/4) over the spliced block text", async () => {
		const text = "量子计算利用量子比特进行并行计算。";
		const context: Context = { systemPrompt: "s", messages: [userMsg("请完成任务")], tools: [] };
		const result = await buildInjection(context, retrievedExps(makeExp("exp-1", "量子计算", text)));
		const spliced = result.messages.find((m) => m.role === "user" && m.timestamp !== undefined);
		const splicedText = typeof spliced?.content === "string" ? spliced.content : "";
		expect(result.injectedTokens).toBe(Math.ceil(splicedText.length / 4));
		expect(result.injectedTokens).toBeGreaterThan(0);
	});

	it("returns 0 when nothing is spliced (no blocks / no user message)", async () => {
		// 无匹配证据：blocks 为空 → 不注入，估计 0。
		const context: Context = { messages: [userMsg("do it")] };
		const none = await buildInjection(context, []);
		expect(none.injectedTokens).toBe(0);
		expect(none.injectedIds).toEqual([]);
		// 无 user 消息：无法拼接 → 0。
		const noUser: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "12:00" }],
					isError: false,
					timestamp: 1,
				},
			],
		};
		const skipped = await buildInjection(noUser, retrievedExps(makeExp("exp-1", "t", "some evidence text")));
		expect(skipped.injectedTokens).toBe(0);
		expect(skipped.injectedIds).toEqual([]);
	});
});
