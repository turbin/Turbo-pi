import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { buildSopSchemas } from "../src/sop-schema.ts";
import type { Experience } from "../src/types.ts";

function makeSop(overrides: Partial<Experience>): Experience {
	return {
		id: "sop-1",
		type: "SOP",
		title: "get_weather",
		payload: {
			schema: {
				name: "get_weather",
				description: "Get weather",
				parameters: { type: "object", properties: { city: { type: "string" } } },
			},
		},
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

describe("buildSopSchemas", () => {
	it("returns active SOPs as OpenAI function schemas", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSop({}));
		const schemas = await buildSopSchemas(store, 15);
		expect(schemas).toHaveLength(1);
		expect(schemas[0].type).toBe("function");
		expect(schemas[0].function.name).toBe("get_weather");
		expect(schemas[0].function.description).toBe("Get weather");
		expect(schemas[0].function.parameters).toEqual({
			type: "object",
			properties: { city: { type: "string" } },
		});
		store.close();
	});

	it("excludes non-SOP and non-active experiences", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSop({ id: "sop-1" }));
		await store.insert(makeSop({ id: "sop-dormant", title: "dormant_sop", status: "dormant" }));
		await store.insert(makeSop({ id: "skill-1", type: "SKILL", title: "some_skill" }));
		const schemas = await buildSopSchemas(store, 15);
		expect(schemas).toHaveLength(1);
		expect(schemas[0].function.name).toBe("get_weather");
		store.close();
	});

	it("respects the limit, highest quality first", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		for (let i = 0; i < 5; i++) {
			await store.insert(
				makeSop({
					id: `sop-${i}`,
					title: `sop_${i}`,
					payload: { schema: { name: `sop_${i}` } },
					quality: i / 10,
				}),
			);
		}
		const schemas = await buildSopSchemas(store, 2);
		expect(schemas).toHaveLength(2);
		expect(schemas[0].function.name).toBe("sop_4");
		expect(schemas[1].function.name).toBe("sop_3");
		store.close();
	});

	it("defaults description and parameters when missing from the schema", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSop({ payload: { schema: { name: "bare_sop" } } }));
		const schemas = await buildSopSchemas(store, 15);
		expect(schemas).toHaveLength(1);
		expect(schemas[0].function.description).toBe("");
		expect(schemas[0].function.parameters).toEqual({});
		store.close();
	});

	it("returns an empty array when no active SOPs exist", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		const schemas = await buildSopSchemas(store, 15);
		expect(schemas).toEqual([]);
		store.close();
	});
});
