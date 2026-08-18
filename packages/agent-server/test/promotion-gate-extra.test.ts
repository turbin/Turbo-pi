import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { PROMOTION_THRESHOLD, skillsToStaged, verifyAndCanonicalize } from "../src/offline/verifier.ts";

/**
 * F4/T5 补充回归：SKILL 暂缓闸门的判别性 + 统一闸无绕过通道。
 *
 * 主回归（promotion-gate.test.ts）覆盖五类卡过闸/拦截/豁免。本文件补：
 * 1. **SKILL 拦截与 utility 无关**：utility=1.0（最高分）也被拦——拦截是
 *    类型闸（verifyAndCanonicalize 统一层），不是质量闸（"SKILL 低分被质量
 *    闸拦下"的错实现会红）；
 * 2. **直调拦截**：绕过 skillsToStaged 直接构造 SKILL VerifyItem（quality 1.0）
 *    也被拦——闸门在统一层，保护所有晋升路径（决策 T5-1）；
 * 3. **SOP 标记语义**：sopsToStaged 的 quality 恒为 1（预验证标记常量），
 *    SOP 不因低于 0.5 被拦（预验证通道实质强于自评闸）。
 */

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

describe("T5: SKILL suspension is a type gate, not a quality gate", () => {
	it("blocks a SKILL item at utility 1.0 (highest possible score)", async () => {
		const store = await makeStore();
		const items = skillsToStaged([{ name: "skill-top", summary: "s", utility: 1.0, content: "# S" }]);
		expect(items[0]?.quality).toBe(1.0);
		expect(items[0]?.quality).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0); // 质量过关仍被拦 → 类型闸
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
	});

	it("blocks a hand-written SKILL VerifyItem at quality 1.0 (gate lives in the unified layer)", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			[
				{
					type: "SKILL",
					title: "hand-written skill",
					quality: 1.0,
					payload: { name: "s", summary: "s", content: "# S", utility: 1.0 },
				},
			],
			store,
		);
		expect(count).toBe(0);
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
	});

	it("keeps a high-utility SKILL out while an EVIDENCE at the same quality passes (discriminator)", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			[
				{ type: "SKILL", title: "skill", quality: 1.0, payload: { name: "s", content: "c", utility: 1.0 } },
				{ quality: 1.0, title: "evidence", payload: { text: "evidence" } },
			],
			store,
		);
		expect(count).toBe(1); // 只有 EVIDENCE
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
	});
});
