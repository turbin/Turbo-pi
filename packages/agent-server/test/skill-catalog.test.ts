import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { buildSkillCatalog } from "../src/skill-catalog.ts";
import type { Experience } from "../src/types.ts";

function makeSkill(overrides: Partial<Experience>): Experience {
	return {
		id: "skill-1",
		type: "SKILL",
		title: "code-review",
		payload: { sections: { overview: "How to review code" } },
		quality: 0.9,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active",
		sourceSession: "seed",
		sourceEntryId: "seed-1",
		contentHash: "hash-1",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("buildSkillCatalog", () => {
	it("returns active skills as XML catalog", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSkill({}));
		const result = await buildSkillCatalog(store, 10);
		expect(result.catalog).toContain("<available_skills>");
		expect(result.catalog).toContain("code-review");
		expect(result.skills).toHaveLength(1);
		store.close();
	});

	it("excludes non-SKILL and non-active experiences", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSkill({ id: "skill-1" }));
		await store.insert(makeSkill({ id: "skill-dormant", title: "dormant-skill", status: "dormant" }));
		await store.insert(makeSkill({ id: "sop-1", type: "SOP", title: "release-sop" }));
		const result = await buildSkillCatalog(store, 10);
		expect(result.skills.map((s) => s.id)).toEqual(["skill-1"]);
		expect(result.catalog).not.toContain("dormant-skill");
		expect(result.catalog).not.toContain("release-sop");
		store.close();
	});

	it("respects the limit", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		for (let i = 0; i < 5; i++) {
			await store.insert(makeSkill({ id: `skill-${i}`, title: `skill-${i}` }));
		}
		const result = await buildSkillCatalog(store, 2);
		expect(result.skills).toHaveLength(2);
		store.close();
	});

	it("escapes XML special characters in title and description", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(
			makeSkill({
				id: "skill-esc",
				title: 'a<b>&"c"',
				payload: { description: "use <tag> & 'quotes'" },
			}),
		);
		const result = await buildSkillCatalog(store, 10);
		expect(result.catalog).toContain('name="a&lt;b&gt;&amp;&quot;c&quot;"');
		expect(result.catalog).toContain("use &lt;tag&gt; &amp; &apos;quotes&apos;");
		store.close();
	});

	it("returns an empty catalog when no active skills exist", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const result = await buildSkillCatalog(store, 10);
		expect(result.catalog).toBe("<available_skills>\n\n</available_skills>");
		expect(result.skills).toHaveLength(0);
		store.close();
	});
});
