import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { runDailyEvolution } from "../src/offline/scheduler.ts";
import { retrieve } from "../src/retrieval.ts";
import type { Experience } from "../src/types.ts";

/**
 * T3 补充回归：复升排除全生命周期 + 检索加权冷启动语义。
 *
 * 主回归文件（attribution-confidence.test.ts）覆盖：迁移/往返/快照/降级通道/
 * 递减单步/加权排序/跳过+递减一步。本文件补：
 * 1. **N=3 全生命周期**：递减 3 批后恢复复评资格（主文件只断言 3→2）；
 * 2. **冷启动语义锁**：新卡（0.5）与满额奖励卡（1.0）等相关性时奖励卡优先；
 *    但相关性优势可补偿（新卡不被"系统性压死"——决策 T3-4 语义锁定）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-t3x-"));
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

describe("T3: rescore exclusion full lifecycle (N=3 countdown to eligibility)", () => {
	it("re-verifies a demoted row after N batches have counted down", async () => {
		const dir = makeTempDir();
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const epoch = new Date(1_800_000_000_000).toISOString();
		await store.insert(
			makeExp("exp-x", {
				status: "dormant",
				rescoreExcludedBatches: 3,
				createdAt: epoch,
				payload: { text: "excluded evidence", task: "t" },
			}),
		);

		const rescored: string[][] = [];
		const rescoreFn = async (candidates: { content_hash: string }[]) => {
			rescored.push(candidates.map((c) => c.content_hash));
			return new Map(candidates.map((c) => [c.content_hash, 0.9]));
		};
		const runOnce = () =>
			runDailyEvolution(store, {
				inputDir: join(dir, "sessions"),
				outputDir: join(dir, "evolution"),
				etlFn: async () => 0,
				pipelineFn: async () => ({ skills: 0, sops: 0, cards: 0 }),
				promoteFn: async () => 0,
				rescoreFn,
				now: () => 1_800_000_000_000,
			});

		// 前 3 批：排除标记卡被跳过（无候选 → rescoreFn 不被调用），计数 3→2→1→0。
		await runOnce();
		expect((await store.getById("exp-x"))?.rescoreExcludedBatches).toBe(2);
		await runOnce();
		expect((await store.getById("exp-x"))?.rescoreExcludedBatches).toBe(1);
		await runOnce();
		expect((await store.getById("exp-x"))?.rescoreExcludedBatches).toBe(0);
		expect(rescored).toEqual([]); // 全程无自评复评调用

		// 第 4 批：计数已为 0 → 恢复自评复评资格，正常复评并晋升。
		await runOnce();
		expect(rescored).toEqual([["hash-exp-x"]]);
		expect((await store.getById("exp-x"))?.status).toBe("active");
	});
});

describe("T3: retrieval cold-start semantics (decision T3-4)", () => {
	it("a fully rewarded card outranks a new card at equal relevance", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeExp("exp-new", {
				title: "retry backoff",
				payload: { text: "retry with backoff on flaky failures" },
				confidence: 0.5,
			}),
		);
		await store.insert(
			makeExp("exp-rewarded", {
				title: "retry backoff",
				payload: { text: "retry with backoff on flaky failures" },
				confidence: 1.0,
			}),
		);
		const results = await retrieve(store, "retry backoff", 2);
		// 等相关性：confidence 加权后奖励卡优先（语义锁定，非缺陷）。
		expect(results.map((r) => r.experience.id)).toEqual(["exp-rewarded", "exp-new"]);
	});

	it("a new card with a relevance advantage still surfaces above a rewarded card", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		// 新卡相关性显著更高（标题+正文全词命中）；奖励卡仅部分命中。
		await store.insert(
			makeExp("exp-new", {
				title: "retry with exponential backoff on flaky api failures",
				payload: { text: "retry with exponential backoff on flaky api failures" },
				confidence: 0.5,
			}),
		);
		await store.insert(makeExp("exp-rewarded", { title: "retry", payload: { text: "retry" }, confidence: 1.0 }));
		const results = await retrieve(store, "retry with exponential backoff on flaky api failures", 2);
		// cosine 优势补偿 confidence 差距：新卡不被系统性压死。
		expect(results.map((r) => r.experience.id)).toEqual(["exp-new", "exp-rewarded"]);
	});
});
