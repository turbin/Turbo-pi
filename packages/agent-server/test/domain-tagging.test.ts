import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { etlSessionFiles } from "../src/offline/etl.ts";
import { collectTrajectories, type SessionTrajectory } from "../src/offline/pipeline.ts";
import { cardsToStaged } from "../src/offline/verifier.ts";
import { retrieve } from "../src/retrieval.ts";
import { createServer } from "../src/server.ts";
import type { Experience } from "../src/types.ts";

/**
 * F3 情景标签与检索过滤（T4，issue-012 采纳项 5 落地）。
 *
 * 覆盖点（plans §4 F3）：
 * 1. 检索域过滤：带 domain 标签的跨域卡不返回（跨域注入为零）；
 *    无标签卡不过滤（存量 920 卡向后兼容）；同域卡保留；
 * 2. ETL 打标路径：EVIDENCE 直插不经蒸馏——ETL 摄入时按 session 所属任务
 *    打域（复用 M1 task_id 透传 + 任务→域注册表）；
 * 3. collectTrajectories 离线侧同步：SessionTrajectory 携带 domain；
 * 4. cardsToStaged payload 映射 domain/task_pattern；
 * 5. 在线 domain 通道：/v1 请求带 domain → session 头 metadata + 检索过滤。
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

describe("T4: retrieval domain filter (cross-domain excluded, untagged passes)", () => {
	it("excludes a tagged cross-domain card and keeps same-domain + untagged cards", async () => {
		const store = await makeStore();
		await store.insert(
			makeExp("exp-alf", {
				title: "alfworld kitchen",
				payload: { text: "open drawer and clean", domain: "alfworld" },
			}),
		);
		await store.insert(
			makeExp("exp-off", {
				title: "office policy audit",
				payload: { text: "read policy and cross-check logs", domain: "office" },
			}),
		);
		await store.insert(
			makeExp("exp-old", {
				title: "legacy untagged",
				payload: { text: "policy audit checklist with backoff retry" },
			}),
		);

		const officeResults = await retrieve(store, "policy audit checklist", 8, "office");
		const officeIds = officeResults.map((r) => r.experience.id);
		expect(officeIds).toContain("exp-off");
		expect(officeIds).toContain("exp-old"); // 无标签卡不过滤（向后兼容）
		expect(officeIds).not.toContain("exp-alf"); // 跨域排除

		const alfResults = await retrieve(store, "kitchen drawer", 8, "alfworld");
		expect(alfResults.map((r) => r.experience.id)).toContain("exp-alf");
		expect(alfResults.map((r) => r.experience.id)).not.toContain("exp-off");
	});

	it("returns everything when no domain is requested (untagged and tagged alike)", async () => {
		const store = await makeStore();
		await store.insert(
			makeExp("exp-alf", { title: "alfworld", payload: { text: "open drawer", domain: "alfworld" } }),
		);
		await store.insert(makeExp("exp-off", { title: "office", payload: { text: "policy audit", domain: "office" } }));
		const results = await retrieve(store, "policy drawer audit", 8);
		expect(results.map((r) => r.experience.id)).toEqual(expect.arrayContaining(["exp-alf", "exp-off"]));
	});

	it("an empty-string tagged card is treated as untagged (registry default)", async () => {
		const store = await makeStore();
		await store.insert(makeExp("exp-empty", { title: "empty domain", payload: { text: "some text", domain: "" } }));
		const results = await retrieve(store, "some text", 8, "office");
		expect(results.map((r) => r.experience.id)).toContain("exp-empty");
	});
});

describe("T4: ETL domain tagging (EVIDENCE 直插路径)", () => {
	it("tags EVIDENCE candidates by session task_id through the task->domain registry", async () => {
		const dir = makeTempDir("etl-domain-");
		const path = join(dir, "session.jsonl");
		writeJsonl(path, [
			{
				type: "session",
				version: 3,
				id: "s-1",
				metadata: { task_id: "task_00091_security_policy_assessment_for_llm_assistant_input_trust_model" },
			},
			{
				type: "message",
				id: "m-1",
				message: {
					role: "assistant",
					content:
						"The compliance checklist marks CTL-002 as implemented but the incident log shows it failed twice.",
				},
			},
			{ type: "custom", customType: "response_completed" },
		]);
		const store = await makeStore();
		await etlSessionFiles([path], store);
		const dormant = await store.listDormant("EVIDENCE", 100);
		expect(dormant.length).toBeGreaterThan(0);
		for (const row of dormant) {
			expect((row.payload as Record<string, unknown>).domain).toBe("office");
		}
	});

	it("handles arm-prefixed session task ids (control-/experiment- naming)", async () => {
		const dir = makeTempDir("etl-domain-");
		const path = join(dir, "session.jsonl");
		writeJsonl(path, [
			{
				type: "session",
				version: 3,
				id: "s-1",
				metadata: { task_id: "experiment-task_00091_security_policy_assessment" },
			},
			{
				type: "message",
				id: "m-1",
				message: {
					role: "assistant",
					content: "Cross-checking the compliance checklist against the incident log now.",
				},
			},
			{ type: "custom", customType: "response_completed" },
		]);
		const store = await makeStore();
		await etlSessionFiles([path], store);
		const dormant = await store.listDormant("EVIDENCE", 100);
		expect(dormant.length).toBeGreaterThan(0);
		expect((dormant[0]!.payload as Record<string, unknown>).domain).toBe("office");
	});

	it("leaves the domain empty for sessions without a recognizable task id", async () => {
		const dir = makeTempDir("etl-domain-");
		const path = join(dir, "session.jsonl");
		writeJsonl(path, [
			{ type: "session", version: 3, id: "s-1", metadata: {} },
			{
				type: "message",
				id: "m-1",
				message: { role: "assistant", content: "A plain production session with no campaign task id." },
			},
			{ type: "custom", customType: "response_completed" },
		]);
		const store = await makeStore();
		await etlSessionFiles([path], store);
		const dormant = await store.listDormant("EVIDENCE", 100);
		expect(dormant.length).toBeGreaterThan(0);
		for (const row of dormant) {
			expect((row.payload as Record<string, unknown>).domain).toBe("");
		}
	});
});

describe("T4: collectTrajectories offline domain passthrough", () => {
	it("derives the domain from session metadata and passes it into the trajectory wire", async () => {
		const dir = makeTempDir("traj-domain-");
		writeJsonl(join(dir, "sess.jsonl"), [
			{
				type: "session",
				version: 3,
				id: "s-1",
				metadata: { task_id: "task_00002_workspace_onboarding_and_identity_scaffold_skill", domain: "office" },
			},
			{ type: "message", id: "m-1", message: { role: "user", content: "onboard the workspace" } },
			{ type: "message", id: "m-2", message: { role: "assistant", content: "creating the skill file" } },
		]);
		const trajectories = collectTrajectories(dir);
		expect(trajectories).toHaveLength(1);
		expect(trajectories[0]?.domain).toBe("office");
	});

	it("falls back to the task->domain registry when metadata lacks an explicit domain", async () => {
		const dir = makeTempDir("traj-domain-");
		writeJsonl(join(dir, "sess.jsonl"), [
			{
				type: "session",
				version: 3,
				id: "s-1",
				metadata: { task_id: "task_00091_security_policy_assessment_for_llm_assistant_input_trust_model" },
			},
			{ type: "message", id: "m-1", message: { role: "user", content: "assess the policy" } },
			{ type: "message", id: "m-2", message: { role: "assistant", content: "checking the compliance checklist" } },
		]);
		const trajectories: SessionTrajectory[] = collectTrajectories(dir);
		expect(trajectories[0]?.domain).toBe("office");
	});
});

describe("T4: cardsToStaged maps domain/task_pattern into the payload", () => {
	it("carries card domain and task_pattern into the staged payload", () => {
		const items = cardsToStaged([
			{
				taskId: "task-1",
				quality: 0.8,
				card: {
					name: "compliance audit",
					trigger: "Use when auditing a policy",
					procedure: "1) read 2) cross-check",
					boundary: "Must not skip evidence",
					role: "Method",
					evidence: { task_id: "task-1" },
					deliverables: ["1) audit report"],
					domain: "office",
					task_pattern: "compliance audit",
				},
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.payload?.domain).toBe("office");
		expect(items[0]?.payload?.task_pattern).toBe("compliance audit");
		// 缺省时为空串（旧格式卡兼容）。
		const legacy = cardsToStaged([
			{
				taskId: "t-2",
				quality: 0.8,
				card: {
					role: "Workflow",
					deliverables: ["x"],
					trigger: "Use when x",
					procedure: "1) y",
					boundary: "Must not z",
				},
			},
		]);
		expect(legacy[0]?.payload?.domain).toBe("");
		expect(legacy[0]?.payload?.task_pattern).toBe("");
	});
});

describe("T4: online domain channel (/v1 -> session metadata + filtered retrieval)", () => {
	function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
	}

	it("threads domain into session header metadata and excludes cross-domain cards from injection", async () => {
		const dir = makeTempDir("server-domain-");
		const sessionDir = join(dir, "sessions");
		const store = await makeStore();
		await store.initSchema();
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
		const mock = vi.fn(() =>
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
		);
		vi.stubGlobal("fetch", mock);
		const app = createServer({ store, gatewayUrl: "http://127.0.0.1:8787", sessionDir });

		const res = await app.inject({
			method: "POST",
			url: "/v1/chat/completions",
			payload: {
				model: "agent-auto",
				messages: [{ role: "user", content: "audit the security policy compliance checklist" }],
				domain: "office",
				task_id: "task_00091_x",
			},
		});
		expect(res.statusCode).toBe(200);

		// session 头 metadata 携带 domain。
		const files = readdirSync(sessionDir);
		const session = readFileSync(join(sessionDir, files[0]!), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const header = session.find((e) => e.type === "session") as { metadata?: Record<string, unknown> };
		expect(header?.metadata?.domain).toBe("office");

		// 注入集不含跨域 alfworld 卡（experience_injection 条目实测）。
		const injection = session.find((e) => e.type === "custom" && e.customType === "experience_injection") as {
			data?: { retrieved?: string[] };
		};
		expect(injection?.data?.retrieved).toBeDefined();
		expect(injection!.data!.retrieved).toContain("exp-off");
		expect(injection!.data!.retrieved).not.toContain("exp-alf");
		vi.unstubAllGlobals();
		await app.close();
	});
});

function writeJsonl(path: string, entries: Record<string, unknown>[]): void {
	writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
