import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import {
	cardsToStaged,
	PROMOTION_THRESHOLD,
	SOP_PREVETTED_QUALITY,
	skillsToStaged,
	sopsToStaged,
	verifyAndCanonicalize,
} from "../src/offline/verifier.ts";

/**
 * F4 晋升机制统一（T5，用户 08-14 裁决 3 / 台账 5 / 红线 3 修订）。
 *
 * 设计原则（plans §4.5）：每类卡晋升必须过"与任务结果挂钩的可执行验证判据"，
 * 阈值/尺度可按类标定，但不存在绕过验证的通道：
 * - Method/Guard（ABILITY）：F1 交付物检查 + F2 实战归因信号（过闸）；
 * - EVIDENCE：维持 0.5 闸（过闸）；
 * - SOP：生命周期管线预验证，quality=1 直通语义 = "预验证通过标记"（豁免）；
 * - SKILL：benchmark 恒为空、无验证对象 → **暂缓入库**（拦截）。
 *
 * 本文件锁定五类卡的过闸/拦截/豁免路径（回归哨兵）。
 */

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

function methodCard(taskId: string, quality: number, role: "Method" | "Guard") {
	return cardsToStaged([
		{
			taskId,
			quality,
			card: {
				name: `card-${taskId}`,
				trigger: "Use when x",
				procedure: "1) y",
				boundary: "Must not z",
				role,
				evidence: { task_id: taskId, verifier_score: quality },
				deliverables: ["1) result file"],
				domain: "office",
			},
		},
	]);
}

describe("T5: unified verifiable promotion gate (五类卡)", () => {
	it("SOP enters at the pre-vetted quality marker (quality=1 直通 = 预验证通过标记)", () => {
		expect(SOP_PREVETTED_QUALITY).toBe(1);
		const items = sopsToStaged([{ name: "sop_a", code: "def a(): ...", docstring: "doc", schema: {}, tools: [] }]);
		expect(items[0]?.quality).toBe(SOP_PREVETTED_QUALITY);
		expect(items[0]?.quality).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
	});

	it("SKILL items are suspended from promotion (暂缓入库 until a verification channel exists)", async () => {
		const store = await makeStore();
		const items = skillsToStaged([{ name: "skill-1", summary: "retry", utility: 0.9, content: "# Skill" }]);
		expect(items).toHaveLength(1);
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0); // 闸门拦截：无验证对象的 utility 分不入库
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
	});

	it("EVIDENCE passes the 0.5 gate", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			[{ quality: 0.8, title: "evidence", payload: { text: "evidence text" } }],
			store,
		);
		expect(count).toBe(1);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
	});

	it("Method cards pass the gate with F1 deliverables + F2 confidence default", async () => {
		const store = await makeStore();
		const items = methodCard("t-m", 0.8, "Method");
		expect(items).toHaveLength(1);
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		const active = await store.listActive("ABILITY", 10);
		expect(active).toHaveLength(1);
		expect(active[0]?.confidence).toBe(0.5);
	});

	it("Guard cards pass the gate (same channel as Method)", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(methodCard("t-g", 0.7, "Guard"), store);
		expect(count).toBe(1);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(1);
	});

	it("five-class mixed batch: SKILL blocked, SOP/EVIDENCE/Method/Guard promoted", async () => {
		const store = await makeStore();
		const items = [
			...skillsToStaged([{ name: "skill-x", summary: "s", utility: 0.9, content: "# S" }]),
			...sopsToStaged([{ name: "sop_x", code: "def x(): ...", docstring: "d", schema: {}, tools: [] }]),
			{ quality: 0.6, title: "evidence", payload: { text: "evidence" } },
			...methodCard("t-m2", 0.8, "Method"),
			...methodCard("t-g2", 0.7, "Guard"),
		];
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(4); // SOP + EVIDENCE + Method + Guard；SKILL 拦截
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
		expect(await store.listActive("SOP", 10)).toHaveLength(1);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(2);
	});
});
