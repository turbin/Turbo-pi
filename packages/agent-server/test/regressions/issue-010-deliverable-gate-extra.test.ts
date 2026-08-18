import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import { cardsToStaged, verifyAndCanonicalize } from "../../src/offline/verifier.ts";

/**
 * issue-010 补充回归：TS 闸门边界锁（normalizeDeliverables + 角色路由）。
 *
 * 主回归文件（issue-010-card-deliverable-gate.test.ts）覆盖缺字段/空数组/
 * 非数组/空串/非字符串。本文件补：
 * 1. 纯空白串交付项（"   "）必须被拒（实现用 trim()，需测试锁定）；
 * 2. 混合"合法 + 空白串"清单整体拒绝（全项校验语义）；
 * 3. 角色缺失的旧格式卡路由到 EVIDENCE → 豁免交付闸（现状锁定：五元组
 *    role 必填，缺 role 视为旧模板异常卡，按 EVIDENCE 处理不阻断晋升）。
 */

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

function stagedCard(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "task-010x",
		quality: 0.8,
		card: {
			name: "assess with evidence appendix",
			trigger: "Use when auditing a security policy",
			procedure: "1) read policy 2) cross-check logs 3) write the assessment file",
			boundary: "Must not present findings without evidence",
			role: "Method",
			evidence: { task_id: "task-010x", verifier_score: 0.8 },
			...overrides,
		},
	};
}

describe("issue-010: normalizeDeliverables edge cases", () => {
	it("drops deliverables lists containing whitespace-only items", () => {
		const items = cardsToStaged([
			stagedCard({ deliverables: ["   "] }),
			stagedCard({ deliverables: ["1) write report.md", " \t "] }),
		]);
		expect(items).toHaveLength(0);
	});

	it("drops a Method card whose deliverables list is valid but the card would be gated at promotion", async () => {
		// 门禁语义与 promote 通路一致：闸门拦住的卡即使 quality 高于阈值也不入库。
		const store = await makeStore();
		const items = cardsToStaged([stagedCard({ deliverables: ["   "] })]);
		expect(items).toHaveLength(0);
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0);
	});

	it("routes role-less old-format cards to EVIDENCE and exempts them from the gate", async () => {
		// 现状锁定：五元组 role 必填；缺 role 的异常旧卡按 EVIDENCE 路由，
		// 不因交付闸阻断晋升（该豁免只影响异常输入，正常 Method/Guard 仍被拦）。
		const items = cardsToStaged([stagedCard({ role: undefined })]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("EVIDENCE");
		expect(items[0]?.payload?.deliverables).toEqual([]);
	});
});
