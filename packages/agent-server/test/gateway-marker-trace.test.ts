import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

/**
 * 台账 2（T6）：x-gateway marker 携带 trace_id 后的 agent-server 消费侧。
 *
 * handleStream 路径（/api/stream 与 /v1 非流式共用）此前不写独立的
 * gateway_marker 会话条目（仅 /v1 流式内联路径写）——补上：done 事件的
 * x_gateway（含 gateway trace_id）必须作为 gateway_marker custom entry
 * 落库，与 gateway model_runs 的逐请求对账键由此成立（双印证）。
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

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function makeExp(id: string): Experience {
	return {
		id,
		type: "EVIDENCE",
		title: `title-${id}`,
		payload: { text: `text-${id}` },
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

describe("T6: gateway marker trace_id lands in the session (handleStream path)", () => {
	it("writes a gateway_marker custom entry carrying trace_id on /api/stream", async () => {
		const dir = makeTempDir("marker-trace-");
		const sessionDir = join(dir, "sessions");
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeExp("exp-1"));

		const marker = {
			escalated: false,
			reason: null,
			provider: "omlx",
			local_provider: "omlx",
			trace_id: "chatcmpl-7f3c9a1b2d4e5f6a7b8c9d0e",
		};
		const mock = vi.fn(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				body: sseStream([
					`: x-gateway ${JSON.stringify(marker)}\n\n`,
					'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
					'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
					"data: [DONE]\n\n",
				]),
			}),
		);
		vi.stubGlobal("fetch", mock);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir });

		const resp = await app.inject({
			method: "POST",
			url: "/api/stream",
			payload: {
				model: { id: "agent-auto", api: "openai-completions", provider: "local", baseUrl: "http://x/v1" },
				context: { messages: [{ role: "user", content: "hi" }] },
				options: {},
			},
		});
		expect(resp.statusCode).toBe(200);

		const files = readdirSync(sessionDir);
		const entries = readFileSync(join(sessionDir, files[0]!), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const markerEntry = entries.find((e) => e.type === "custom" && e.customType === "gateway_marker") as
			| { data?: Record<string, unknown> }
			| undefined;
		expect(markerEntry).toBeDefined();
		expect(markerEntry!.data?.trace_id).toBe("chatcmpl-7f3c9a1b2d4e5f6a7b8c9d0e");
		expect(markerEntry!.data?.escalated).toBe(false);
		vi.unstubAllGlobals();
		await app.close();
	});
});
