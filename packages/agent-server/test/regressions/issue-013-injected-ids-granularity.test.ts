import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildInjection } from "../../src/injection.ts";
import type { Experience, RetrievedExperience } from "../../src/types.ts";

/**
 * issue-013 补充回归：injected_ids 口径细粒度（决策记录 T0-2）。
 *
 * issue-013 回归主文件只断言 injected_ids ⊆ retrieved_ids——"换一个把全部
 * retrieved id 都当注入集记录的错实现"也能过。本文件把口径逐条锁死：
 * - EVIDENCE：过滤后实际进入 `<Extra Info>` 池的全部卡 id（malformed 排除）；
 * - Method/Guard：排序截取 top-5 **之后**的 id（与内容组装同一集合）；
 * - SKILL/SOP 显式排除（独立通道：catalog / tool schemas）；
 * - 无 blocks（全部 malformed / 检索为空）或无 user 消息可 splice → []。
 */

function userMsg(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function makeExp(overrides: Partial<Experience>): Experience {
	return {
		id: overrides.id ?? "exp-1",
		type: overrides.type ?? "EVIDENCE",
		title: overrides.title ?? "title",
		payload: overrides.payload ?? {},
		quality: overrides.quality ?? 0.8,
		status: overrides.status ?? "active",
		sourceSession: "session-1",
		sourceEntryId: "entry-1",
		contentHash: "hash-1",
		createdAt: new Date().toISOString(),
	};
}

function retrieved(...experiences: Experience[]): RetrievedExperience[] {
	return experiences.map((experience) => ({ experience, score: 1 }));
}

describe("issue-013: injected_ids granularity (decision T0-2)", () => {
	it("records only the top-5 Method/Guard ids plus the full EVIDENCE pool", async () => {
		// 8 Method + 8 Guard（超过 5 上限）+ 3 EVIDENCE：注入集必须是
		// 3 证据 + 各 top-5，而不是全部 19 个 retrieved id。
		const context: Context = { messages: [userMsg("do it")] };
		const methods = Array.from({ length: 8 }, (_, i) => ({
			id: `method-${i}`,
			quality: (i + 1) / 10, // 0.1..0.8，quality 越高越靠前
		}));
		const guards = Array.from({ length: 8 }, (_, i) => ({
			id: `guard-${i}`,
			quality: (i + 1) / 10,
		}));
		const result = await buildInjection(
			context,
			retrieved(
				makeExp({ id: "ev-1", type: "EVIDENCE", payload: { text: "evidence one" } }),
				makeExp({ id: "ev-2", type: "EVIDENCE", payload: { text: "evidence two" } }),
				makeExp({ id: "ev-3", type: "EVIDENCE", payload: { text: "evidence three" } }),
				...methods.map((m) =>
					makeExp({
						id: m.id,
						type: "ABILITY",
						payload: { role: "Method", procedure: `proc ${m.id}` },
						quality: m.quality,
					}),
				),
				...guards.map((g) =>
					makeExp({
						id: g.id,
						type: "ABILITY",
						payload: { role: "Guard", boundary: `bd ${g.id}` },
						quality: g.quality,
					}),
				),
			),
		);
		// 全部证据入池（不截断）。
		expect(result.injectedIds).toEqual(expect.arrayContaining(["ev-1", "ev-2", "ev-3"]));
		// Method/Guard 只取 quality 最高的 5 个（0.8..0.4 → method-7..method-3）。
		// 注意 sort 原地修改，截断集合先拷贝再排。
		const topMethodIds = [...methods]
			.sort((a, b) => b.quality - a.quality)
			.slice(0, 5)
			.map((m) => m.id);
		const topGuardIds = [...guards]
			.sort((a, b) => b.quality - a.quality)
			.slice(0, 5)
			.map((g) => g.id);
		expect(result.injectedIds).toEqual(expect.arrayContaining(topMethodIds));
		expect(result.injectedIds).toEqual(expect.arrayContaining(topGuardIds));
		expect(result.injectedIds).toHaveLength(3 + 5 + 5);
		// 被截掉的 6 个（method-0..2、guard-0..2）绝不入集。
		const truncated = [...methods.slice(0, 3), ...guards.slice(0, 3)].map((x) => x.id);
		expect(result.injectedIds).not.toEqual(expect.arrayContaining(truncated));
		// 注入集与检索集严格区分（错实现"全量 retrieved 当注入集"在此失败）。
		expect(result.injectedIds.length).toBeLessThan(19);
	});

	it("excludes SKILL and SOP ids (separate channels)", async () => {
		const context: Context = { messages: [userMsg("do it")] };
		const result = await buildInjection(
			context,
			retrieved(
				makeExp({ id: "ev-1", type: "EVIDENCE", payload: { text: "evidence one" } }),
				makeExp({ id: "skill-1", type: "SKILL", payload: { text: "skill body" } }),
				makeExp({ id: "sop-1", type: "SOP", payload: { text: "sop body" } }),
			),
		);
		expect(result.injectedIds).toEqual(["ev-1"]);
		expect(result.injectedIds).not.toContain("skill-1");
		expect(result.injectedIds).not.toContain("sop-1");
	});

	it("excludes malformed payloads from the injected set", async () => {
		const context: Context = { messages: [userMsg("do it")] };
		const result = await buildInjection(
			context,
			retrieved(
				makeExp({ id: "ev-bad", type: "EVIDENCE", payload: { text: "" } }),
				makeExp({ id: "ev-no-text", type: "EVIDENCE", payload: {} }),
				makeExp({ id: "m-bad", type: "ABILITY", payload: { role: "Method", procedure: "" } }),
				makeExp({ id: "g-bad", type: "ABILITY", payload: { role: "Guard", boundary: "" } }),
				makeExp({ id: "ev-ok", type: "EVIDENCE", payload: { text: "good evidence" } }),
			),
		);
		expect(result.injectedIds).toEqual(["ev-ok"]);
	});

	it("returns [] when nothing was spliced (no user message / no blocks)", async () => {
		// AssistantMessage 必填字段补全（tsgo 类型检查）；断言本体未动。
		const noUser = await buildInjection(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						api: "openai-completions",
						provider: "local",
						model: "agent-auto",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			},
			retrieved(makeExp({ id: "ev-1", type: "EVIDENCE", payload: { text: "evidence one" } })),
		);
		expect(noUser.injectedIds).toEqual([]);

		const allMalformed = await buildInjection(
			{ messages: [userMsg("do it")] },
			retrieved(makeExp({ id: "ev-bad", type: "EVIDENCE", payload: { text: "" } })),
		);
		expect(allMalformed.injectedIds).toEqual([]);

		const emptyRetrieval = await buildInjection({ messages: [userMsg("do it")] }, []);
		expect(emptyRetrieval.injectedIds).toEqual([]);
	});
});
