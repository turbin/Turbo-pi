import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { createServer } from "../../src/server.ts";
import type { Experience } from "../../src/types.ts";

/**
 * issue-013 补充：/api/stream trace 行的两阶段契约（O spec R1 + 决策 T0-6）。
 *
 * 决策记录 T0-6 声明 /api/stream "纳入 trace 落库（与 /v1 同口径）……与 /v1
 * 同契约"，且理由 3 称 "handleStream 已有完整检索字段与两阶段 upsert，仅需
 * 传入 requestId"。但 handleStream 只写阶段一（检索）与阶段一点五（注入集），
 * 从不写阶段二（completion：finish_reason/tokens/latency）——/api/stream 的
 * trace 行这三列永远为 NULL，/v1 路径（traceStreamCompletion）则完整。
 *
 * 本测试锁定"与 /v1 同契约"：/api/stream 完成后 trace 行必须带 completion
 * 字段。对当前实现为红（缺陷证据）；修复 proxy-handler 阶段二后转绿。
 */

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

describe("issue-013: /api/stream trace row carries the completion phase", () => {
	let dir: string;
	let sessionDir: string;
	let store: ExperienceStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "agent-server-issue013-completion-"));
		sessionDir = join(dir, "sessions");
		store = new ExperienceStore(join(dir, "experience.db"));
		await store.initSchema();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("records finish_reason/tokens/latency on the /api/stream trace row (two-phase contract)", async () => {
		await store.insert(makeExperience());
		const chunks = [
			'data: {"choices":[{"delta":{"content":"你好！"}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
			"data: [DONE]\n\n",
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					body: sseStream(chunks),
				}),
			),
		);
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
			},
		});
		expect(resp.statusCode).toBe(200);
		expect(resp.body).toContain('"type":"done"');

		const requestId = resp.headers["x-request-id"];
		const stats = await store.getHitRateStats(1);
		const row = stats.recent.find((r) => r.requestId === requestId)!;
		expect(row).toBeDefined();
		// 与 /v1 同契约（O spec R1 两阶段）：completion 字段必须落库，
		// 而不是永远 NULL（当前实现缺陷——见文件头注释）。
		expect(row.finishReason).toBe("stop");
		expect(row.promptTokens).toBe(10);
		expect(row.completionTokens).toBe(3);
		expect(row.latencyMs).toBeGreaterThanOrEqual(0);
		await app.close();
	});
});
