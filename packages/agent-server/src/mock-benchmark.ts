import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExperienceStore } from "./experience-store.ts";
import { createServer } from "./server.ts";
import type { StreamEvent } from "./toolcall-validator.ts";
import type { Experience } from "./types.ts";

/** Metrics of the mock benchmark run, matching `benchmark/results/report.md`. */
export interface MockBenchmarkMetrics {
	/** Fraction of the 12 seeded EVIDENCE entries recalled into the injection pool by their query. */
	evidence_recall_at_12: number;
	/** Mean extra prompt tokens per query caused by replay injection (seeded run minus baseline run). */
	replay_token_overhead: number;
	/** Mean number of experiences retrieved per evidence query. */
	pool_size: number;
	/** Fraction of toolCall scenarios with the expected terminal event (valid -> done, truncated -> error). */
	toolcall_pass_rate: number;
}

interface SeedEntry {
	key: string;
	title: string;
	text: string;
}

/**
 * 12 EVIDENCE entries (SPEC §7 mock benchmark). Each carries one unique
 * keyword so its benchmark query retrieves exactly that entry: English
 * keywords match FTS directly, CJK queries are prefixes of the entry's leading
 * CJK run (unicode61 stores a CJK run as one token, see retrieval.ts).
 */
const EVIDENCE: SeedEntry[] = [
	{ key: "backpressure", title: "backpressure 流控策略", text: "backpressure 出现时先降并发再加重试" },
	{ key: "idempotent", title: "idempotent 写入设计", text: "idempotent 写入用幂等键去重" },
	{ key: "checkpoint", title: "checkpoint 恢复流程", text: "checkpoint 损坏时回退到上一个有效点" },
	{ key: "throttle", title: "throttle 限流阈值", text: "throttle 触发后按令牌桶限速" },
	{ key: "deadlock", title: "deadlock 排查步骤", text: "deadlock 先抓线程栈再分析锁顺序" },
	{ key: "failover", title: "failover 切换顺序", text: "failover 先切只读流量再切写流量" },
	{ key: "retry", title: "retry 退避参数", text: "retry 使用指数退避最多三次" },
	{ key: "sharding", title: "sharding 分片键选择", text: "sharding 分片键选高基数字段" },
	{ key: "snapshot", title: "snapshot 一致性级别", text: "snapshot 读取默认最终一致" },
	{ key: "timeout", title: "timeout 预算分配", text: "timeout 预算按调用链逐级递减" },
	{ key: "缓存雪崩", title: "缓存雪崩处理策略", text: "缓存雪崩时加随机过期抖动" },
	{ key: "库存超卖", title: "库存超卖防护方案", text: "库存超卖用乐观锁加条件更新" },
];

/** Noise entries that share generic words with queries but no unique keyword. */
const NOISE: SeedEntry[] = [
	{ key: "noise-1", title: "通用的处理流程", text: "通用的处理流程先记录日志" },
	{ key: "noise-2", title: "常见的策略说明", text: "常见的策略需要定期评审" },
	{ key: "noise-3", title: "系统的设计原则", text: "系统的设计追求简单可靠" },
];

interface BenchmarkQuery {
	query: string;
	targetId: string;
}

const TOOLCALL_MARKER = "[toolcall]";
const TRUNCATED_MARKER = "[truncated]";

const MODEL = {
	id: "mock-bench-model",
	api: "openai-completions",
	provider: "mock",
	baseUrl: "http://127.0.0.1:0/v1",
} as const;

const READ_TOOL = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
};

/**
 * Run the P0 pipeline end-to-end against a mock gateway (SPEC §7): seed an
 * in-memory ExperienceStore, drive `POST /api/stream` via fastify inject, and
 * compute metrics from the emitted SSE events and the recorded session JSONL.
 *
 * Deterministic by construction: the mock gateway estimates prompt tokens as
 * chars/4 and always emits a finish_reason, and every query targets a unique
 * FTS keyword. The temporary session directory is removed before returning.
 */
export async function runMockBenchmark(): Promise<MockBenchmarkMetrics> {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-bench-"));
	const gateway = await startMockGateway();
	const sessionDir = join(dir, "sessions");
	const baselineDir = join(dir, "baseline");

	const store = new ExperienceStore(":memory:");
	const baselineStore = new ExperienceStore(":memory:");
	await store.initSchema();
	await baselineStore.initSchema();
	const queries: BenchmarkQuery[] = [];
	for (const [i, entry] of EVIDENCE.entries()) {
		const id = `ev-${i}`;
		await store.insert(makeExperience(id, entry));
		queries.push({ query: queryFor(entry), targetId: id });
	}
	for (const [i, entry] of NOISE.entries()) {
		await store.insert(makeExperience(`noise-${i}`, entry));
	}

	const server = createServer({ store, gatewayUrl: gateway.url, sessionDir });
	const baseline = createServer({ store: baselineStore, gatewayUrl: gateway.url, sessionDir: baselineDir });

	try {
		let recallHits = 0;
		let poolTotal = 0;
		let overheadTotal = 0;
		for (const q of queries) {
			const seededEvents = await postStream(server, q.query);
			const baselineEvents = await postStream(baseline, q.query);
			const seededDone = expectDone(seededEvents);
			const baselineDone = expectDone(baselineEvents);
			overheadTotal += seededDone.usage.input - baselineDone.usage.input;

			const retrieved = readRetrievedIds(sessionDir, q.query);
			poolTotal += retrieved.length;
			if (retrieved.includes(q.targetId)) recallHits++;
		}

		let toolcallPassed = 0;
		const validEvents = await postStream(server, `${TOOLCALL_MARKER} 读取配置`, [READ_TOOL]);
		if (expectDone(validEvents).reason === "toolUse") toolcallPassed++;
		const truncatedEvents = await postStream(server, `${TRUNCATED_MARKER} 读取配置`, [READ_TOOL]);
		if (truncatedEvents.some((e) => e.type === "error") && !truncatedEvents.some((e) => e.type === "done")) {
			toolcallPassed++;
		}

		return {
			evidence_recall_at_12: round3(recallHits / queries.length),
			replay_token_overhead: round3(overheadTotal / queries.length),
			pool_size: round3(poolTotal / queries.length),
			toolcall_pass_rate: round3(toolcallPassed / 2),
		};
	} finally {
		await server.close();
		await baseline.close();
		store.close();
		baselineStore.close();
		await gateway.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Render metrics as the `benchmark/results/report.md` markdown table. */
export function renderReport(metrics: MockBenchmarkMetrics): string {
	return [
		"# Mock Benchmark Report",
		"",
		"P0 pipeline (streamFn proxy + evidence replay + session JSONL + toolCall validation) against a mock gateway.",
		"",
		"| metric | value |",
		"|---|---|",
		`| evidence_recall@12 | ${metrics.evidence_recall_at_12} |`,
		`| replay_token_overhead | ${metrics.replay_token_overhead} |`,
		`| pool_size | ${metrics.pool_size} |`,
		`| toolcall_pass_rate | ${metrics.toolcall_pass_rate} |`,
		"",
	].join("\n");
}

function makeExperience(id: string, entry: SeedEntry): Experience {
	return {
		id,
		type: "EVIDENCE",
		title: entry.title,
		payload: { text: entry.text },
		quality: 0.9,
		status: "active",
		sourceSession: "bench",
		sourceEntryId: id,
		contentHash: id,
		createdAt: "2026-07-19T00:00:00.000Z",
	};
}

/** Query text that retrieves exactly this entry (see EVIDENCE comment). */
function queryFor(entry: SeedEntry): string {
	return /[一-鿿]/.test(entry.key) ? entry.key : `${entry.key} 怎么处理`;
}

interface DoneEvent {
	reason: string;
	usage: { input: number };
}

async function postStream(
	server: ReturnType<typeof createServer>,
	query: string,
	tools?: (typeof READ_TOOL)[],
): Promise<StreamEvent[]> {
	const resp = await server.inject({
		method: "POST",
		url: "/api/stream",
		payload: {
			model: MODEL,
			context: { messages: [{ role: "user", content: query }], ...(tools ? { tools } : {}) },
			options: {},
		},
	});
	if (resp.statusCode !== 200) throw new Error(`benchmark request failed: ${resp.statusCode} ${resp.body}`);
	return resp.body
		.split("\n\n")
		.map((frame) => frame.trim())
		.filter((frame) => frame.startsWith("data:"))
		.map((frame) => JSON.parse(frame.slice(5).trim()) as StreamEvent);
}

function expectDone(events: StreamEvent[]): DoneEvent {
	const done = events.find((e) => e.type === "done");
	if (!done || done.type !== "done") {
		throw new Error(`benchmark stream did not end in done: ${JSON.stringify(events.map((e) => e.type))}`);
	}
	return done;
}

/** Find the session JSONL for `query` and return its recorded retrieved IDs. */
function readRetrievedIds(sessionDir: string, query: string): string[] {
	for (const file of readdirSync(sessionDir)) {
		const first = readFileSync(join(sessionDir, file), "utf-8").split("\n", 1)[0];
		const entry = JSON.parse(first) as {
			type: string;
			data: { body?: { context?: { messages?: { content?: string }[] } }; retrieved?: string[] };
		};
		const messages = entry.data.body?.context?.messages ?? [];
		if (messages.some((m) => m.content === query)) {
			return entry.data.retrieved ?? [];
		}
	}
	throw new Error(`no session recorded for query: ${query}`);
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Mock agent-gateway: serves POST /v1/chat/completions as SSE. Prompt tokens
 * are estimated as chars/4 (deterministic, so replay_token_overhead is exact).
 * The last user message selects the scenario: [toolcall] emits a valid read
 * toolCall, [truncated] emits a toolCall cut off by finish_reason=length,
 * anything else gets a short text reply. Every stream emits a finish_reason.
 */
function startMockGateway(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createHttpServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: { role: string; content: string | null }[] };
			const promptTokens =
				Math.ceil(
					body.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0) / 4,
				) +
				body.messages.length * 4;
			const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
			const text = typeof lastUser?.content === "string" ? lastUser.content : "";

			const chunks: object[] = [];
			let finishReason = "stop";
			if (text.startsWith(TOOLCALL_MARKER)) {
				chunks.push({
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"/etc/config"}' } },
								],
							},
						},
					],
				});
				finishReason = "tool_calls";
			} else if (text.startsWith(TRUNCATED_MARKER)) {
				chunks.push({
					choices: [
						{
							delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] },
						},
					],
				});
				finishReason = "length";
			} else {
				chunks.push({ choices: [{ delta: { content: "收到" } }] });
			}
			chunks.push({
				choices: [{ delta: {}, finish_reason: finishReason }],
				usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
			});

			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				reject(new Error("mock gateway has no address"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

// Run directly (`tsx src/mock-benchmark.ts`) to regenerate benchmark/results/report.md.
if (process.argv[1]?.endsWith("mock-benchmark.ts")) {
	const metrics = await runMockBenchmark();
	const reportPath = fileURLToPath(new URL("../benchmark/results/report.md", import.meta.url));
	mkdirSync(dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, renderReport(metrics));
	console.log(`wrote ${reportPath}`);
	console.log(renderReport(metrics));
}
