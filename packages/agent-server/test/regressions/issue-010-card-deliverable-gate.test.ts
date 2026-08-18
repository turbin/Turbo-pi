import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import {
	cardsToStaged,
	promoteStagedOutputs,
	skillsToStaged,
	sopsToStaged,
	verifyAndCanonicalize,
} from "../../src/offline/verifier.ts";

/**
 * issue-010 回归：交付物维度闸门（F1 批次，T2 任务）。
 *
 * 根因：Method 卡只提炼"过程步骤"、不提炼"任务交付物要求"，验证闸门也不
 * 验证按卡执行能否产出交付物——照卡执行挤占交付本能（D3 重复集分数连续
 * 下滑，task_00091 分析完整但 security_policy_assessment.md 从未落盘）。
 *
 * 修复（本文件断言的 TS 侧）：
 * 1. cardsToStaged 把卡 deliverables 清单映射进 payload（schema 第三处）；
 * 2. Method/Guard（ABILITY）卡必须携带**非空** deliverables 数组，否则
 *    不晋升（旧模板卡/空清单卡在闸门处拦截）——Python 打分侧另有
 *    无交付轨迹 quality 封顶 <0.5（python/tests/test_issue010_*.py）；
 * 3. SOP/SKILL/EVIDENCE 显式豁免（SOP quality=1 预验证通道、SKILL
 *    utility、EVIDENCE 无交付物概念，均不受交付检查影响）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-issue010-"));
	tempDirs.push(dir);
	return dir;
}

async function makeStore(): Promise<ExperienceStore> {
	const store = new ExperienceStore(":memory:");
	await store.initSchema();
	return store;
}

function stagedCard(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "task-010",
		quality: 0.8,
		card: {
			name: "assess with evidence appendix",
			trigger: "Use when auditing a security policy",
			procedure: "1) read policy 2) cross-check logs 3) write the assessment file",
			boundary: "Must not present findings without evidence",
			role: "Method",
			evidence: { task_id: "task-010", verifier_score: 0.8 },
			...overrides,
		},
	};
}

describe("issue-010: cardsToStaged maps the deliverables dimension", () => {
	it("carries a non-empty deliverables array into the ABILITY payload", () => {
		const items = cardsToStaged([
			stagedCard({ deliverables: ["1) write security_policy_assessment.md", "2) include the evidence appendix"] }),
		]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("ABILITY");
		expect(items[0]?.payload?.deliverables).toEqual([
			"1) write security_policy_assessment.md",
			"2) include the evidence appendix",
		]);
	});

	it("maps deliverables for EVIDENCE-routed cards too (Workflow/unknown role)", () => {
		const items = cardsToStaged([
			stagedCard({ role: "Workflow", deliverables: ["1) final report"] }),
			stagedCard({ role: "UnknownRole", deliverables: ["1) final report"] }),
		]);
		expect(items).toHaveLength(2);
		expect(items.every((i) => i.type === "EVIDENCE")).toBe(true);
		expect(items.every((i) => Array.isArray(i.payload?.deliverables))).toBe(true);
	});
});

describe("issue-010: Method/Guard cards without a non-empty deliverables list are gated out", () => {
	it("drops a Method card whose deliverables field is missing (old-template card)", () => {
		const items = cardsToStaged([stagedCard()]);
		expect(items).toHaveLength(0);
	});

	it("drops a Method card with an empty deliverables array", () => {
		const items = cardsToStaged([stagedCard({ deliverables: [] })]);
		expect(items).toHaveLength(0);
	});

	it("drops a Method card with a malformed deliverables payload (non-array / empty strings)", () => {
		const items = cardsToStaged([
			stagedCard({ deliverables: "write report.md" }),
			stagedCard({ deliverables: ["ok", ""] }),
			stagedCard({ deliverables: ["ok", 42] }),
		]);
		expect(items).toHaveLength(0);
	});

	it("drops a Guard card without deliverables", () => {
		const items = cardsToStaged([stagedCard({ role: "Guard" })]);
		expect(items).toHaveLength(0);
	});

	it("does not promote a gated Method card into the store even above the quality threshold", async () => {
		const store = await makeStore();
		const items = cardsToStaged([stagedCard()]);
		expect(items).toHaveLength(0);
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(0);
		expect(await store.listActive("ABILITY", 10)).toHaveLength(0);
	});
});

describe("issue-010: SOP/SKILL/EVIDENCE are explicitly exempt from the deliverable check", () => {
	it("keeps SOP promotion without deliverables while SKILL stays suspended (T5 gate)", async () => {
		const store = await makeStore();
		const items = [
			...skillsToStaged([{ name: "skill-010", summary: "retry", utility: 0.9, content: "# Skill" }]),
			...sopsToStaged([{ name: "sop_010", code: "def s(): ...", docstring: "doc", schema: {}, tools: [] }]),
		];
		expect(items).toHaveLength(2);
		const count = await verifyAndCanonicalize(items, store);
		// SOP 预验证直通照常晋升（豁免交付检查）；SKILL 被 T5 统一闸暂缓。
		expect(count).toBe(1);
		expect(await store.listActive("SKILL", 10)).toHaveLength(0);
		expect(await store.listActive("SOP", 10)).toHaveLength(1);
	});

	it("keeps a Workflow card (EVIDENCE) without deliverables promotable", async () => {
		const store = await makeStore();
		const items = cardsToStaged([stagedCard({ role: "Workflow" })]);
		expect(items).toHaveLength(1);
		expect(items[0]?.type).toBe("EVIDENCE");
		const count = await verifyAndCanonicalize(items, store);
		expect(count).toBe(1);
		expect(await store.listActive("EVIDENCE", 10)).toHaveLength(1);
	});

	it("promotes raw EVIDENCE items without any deliverables field", async () => {
		const store = await makeStore();
		const count = await verifyAndCanonicalize(
			[{ quality: 0.9, title: "plain evidence", payload: { text: "plain evidence" } }],
			store,
		);
		expect(count).toBe(1);
	});
});

describe("issue-010: promoteStagedOutputs integration (cards.json stage)", () => {
	it("promotes only Method/Guard cards carrying deliverables from a staged cards.json", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "skills.json"), JSON.stringify([]));
		writeFileSync(join(dir, "sops.json"), JSON.stringify([]));
		writeFileSync(
			join(dir, "cards.json"),
			JSON.stringify([
				{
					taskId: "t-old",
					quality: 0.9,
					card: {
						name: "old template method card",
						trigger: "Use when x",
						procedure: "1) analyze",
						boundary: "Must not skip analysis",
						role: "Method",
						evidence: { task_id: "t-old", verifier_score: 0.9 },
					},
				},
				{
					taskId: "t-new",
					quality: 0.8,
					card: {
						name: "new template guard card",
						trigger: "Use when y",
						procedure: "1) verify",
						boundary: "Must not push without review",
						role: "Guard",
						evidence: { task_id: "t-new", verifier_score: 0.8 },
						deliverables: ["1) reviewed diff", "2) merge commit"],
					},
				},
			]),
		);

		const store = await makeStore();
		const count = await promoteStagedOutputs(dir, store);
		// 旧模板 Method 卡（无 deliverables）被闸门拦截；新模板 Guard 卡晋升。
		expect(count).toBe(1);
		const abilities = await store.listActive("ABILITY", 10);
		expect(abilities).toHaveLength(1);
		expect(abilities[0]?.title).toBe("new template guard card");
		expect((abilities[0]?.payload as Record<string, unknown>).deliverables).toEqual([
			"1) reviewed diff",
			"2) merge commit",
		]);
	});
});
