import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { domainForTask } from "../src/offline/task-domain.ts";
import { retrieve } from "../src/retrieval.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

/**
 * F3/T4 补充回归：检索过滤判别性 / /api/stream 域通道 / 注册表边界。
 *
 * 主回归（domain-tagging.test.ts）覆盖跨域排除/无标签放行/ETL/collect/
 * 映射//v1 集成。本文件补：
 * 1. **排除语义判别**：跨域卡即使相关性+置信度都更高也必须缺席（"降权式"
 *    错实现——跨域卡排到末尾仍出现在结果里——会红）；
 * 2. **空池行为**：带 domain 过滤后候选池为空 → 返回 []（不崩溃）；
 * 3. /api/stream 域通道：body.domain → session 元数据 + 注入集不含跨域卡
 *    （主回归只测 /v1）；
 * 4. **注册表词边界语义锁**（与 Python 侧 parity 测试同期望表）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllGlobals();
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeExp(id: string, overrides: Partial<Experience> = {}): Experience {
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
		...overrides,
	};
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

describe("T4: domain filter is exclusion, not re-ranking", () => {
	it("excludes a cross-domain card even when it is the best textual match with the highest confidence", async () => {
		const store = await makeStore();
		await store.insert(
			makeExp("exp-alf-best", {
				title: "security policy compliance audit",
				payload: { text: "security policy compliance audit checklist cross-check logs", domain: "alfworld" },
				confidence: 1.0,
			}),
		);
		await store.insert(
			makeExp("exp-off", {
				title: "policy audit",
				payload: { text: "policy audit", domain: "office" },
				confidence: 0.5,
			}),
		);
		const results = await retrieve(store, "security policy compliance audit checklist cross-check logs", 8, "office");
		const ids = results.map((r) => r.experience.id);
		// 排除语义：跨域卡必须缺席（即使 cosine×confidence 本应排第一）；
		// "跨域卡降权排底"的错实现在此红。
		expect(ids).not.toContain("exp-alf-best");
		expect(ids).toContain("exp-off");
	});

	it("returns an empty result set when the filtered pool is empty (no crash)", async () => {
		const store = await makeStore();
		await store.insert(
			makeExp("exp-alf", { title: "kitchen", payload: { text: "open drawer and clean", domain: "alfworld" } }),
		);
		const results = await retrieve(store, "open drawer and clean", 8, "office");
		expect(results).toEqual([]);
		// 同查询不带 domain 参数 → 不过滤（候选池原样）。
		const unfiltered = await retrieve(store, "open drawer and clean", 8);
		expect(unfiltered.map((r) => r.experience.id)).toEqual(["exp-alf"]);
	});
});

describe("T4: /api/stream domain channel", () => {
	function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
	}

	it("threads domain into session metadata and excludes cross-domain cards from injection", async () => {
		const dir = makeTempDir("stream-domain-");
		const sessionDir = join(dir, "sessions");
		const store = await makeStore();
		await store.insert(
			makeExp("exp-alf", {
				type: "ABILITY",
				title: "alfworld drawer",
				payload: { role: "Method", procedure: "open the drawer and clean it", domain: "alfworld" },
			}),
		);
		await store.insert(
			makeExp("exp-off", {
				type: "ABILITY",
				title: "office audit",
				payload: {
					role: "Method",
					procedure: "cross-check the compliance checklist against logs",
					domain: "office",
				},
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					body: sseStream([
						'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
						'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
						"data: [DONE]\n\n",
					]),
				}),
			),
		);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir });
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
				context: { messages: [{ role: "user", content: "audit the security policy compliance checklist" }] },
				options: {},
				taskId: "task_00091_x",
				domain: "office",
			},
		});
		expect(resp.statusCode).toBe(200);

		const files = readdirSync(sessionDir);
		const session = readFileSync(join(sessionDir, files[0]!), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const header = session.find((e) => e.type === "session") as { metadata?: Record<string, unknown> };
		expect(header?.metadata?.domain).toBe("office");
		const injection = session.find((e) => e.type === "custom" && e.customType === "experience_injection") as {
			data?: { retrieved?: string[] };
		};
		expect(injection!.data!.retrieved).toContain("exp-off");
		expect(injection!.data!.retrieved).not.toContain("exp-alf");
		await app.close();
	});
});

describe("T4: task->domain registry word-boundary semantics (TS copy)", () => {
	it("matches only canonical task_<digits> prefixes and arm-prefixed forms", () => {
		expect(domainForTask("task_00091_security_policy_assessment")).toBe("office");
		expect(domainForTask("experiment-task_00091_x")).toBe("office");
		expect(domainForTask("control-task_2_foo")).toBe("office");
		expect(domainForTask("alfworld_pick_clean")).toBe("alfworld");
		// 词字符前缀不命中（与 Python 侧 parity 测试同一期望表）。
		expect(domainForTask("mytask_00001")).toBe("");
		expect(domainForTask("footask_7_bar")).toBe("");
		expect(domainForTask("x_task_5_y")).toBe("");
		expect(domainForTask("")).toBe("");
	});
});
