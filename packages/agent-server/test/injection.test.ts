import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../src/experience-store.ts";
import { buildInjection } from "../src/injection.ts";
import type { Experience, RetrievedExperience } from "../src/types.ts";

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

describe("buildInjection", () => {
	it("inserts evidence block before last user message", async () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [userMsg("first"), userMsg("second")],
			tools: [],
		};
		const result = await buildInjection(
			context,
			retrieved(makeExp({ type: "EVIDENCE", payload: { text: "量子计算利用量子比特。" } })),
		);
		expect(result.messages).toHaveLength(3);
		const injected = result.messages[result.messages.length - 2];
		expect(injected.role).toBe("user");
		expect(injected.content).toContain("量子计算");
		expect(injected.content).toContain("<Extra Info>");
		expect(result.messages[result.messages.length - 1].content).toBe("second");
		expect(result.systemPrompt).toBe("You are helpful.");
	});

	it("inserts Method and Guard blocks", async () => {
		const context: Context = { messages: [userMsg("do it")] };
		const result = await buildInjection(
			context,
			retrieved(
				makeExp({ id: "m1", type: "ABILITY", payload: { role: "Method", procedure: "先写测试，再实现。" } }),
				makeExp({ id: "g1", type: "ABILITY", payload: { role: "Guard", boundary: "不得提交密钥。" } }),
			),
		);
		const injected = result.messages[result.messages.length - 2];
		expect(injected.content).toContain("先写测试，再实现。");
		expect(injected.content).toContain("注意：不得提交密钥。");
	});

	it("filters out removed experiences", async () => {
		const context: Context = { messages: [userMsg("hello")] };
		const result = await buildInjection(
			context,
			retrieved(makeExp({ status: "removed", payload: { text: "stale evidence" } })),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("filters out dormant experiences", async () => {
		const context: Context = { messages: [userMsg("hello")] };
		const result = await buildInjection(
			context,
			retrieved(makeExp({ status: "dormant", payload: { text: "unverified candidate" } })),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("ignores non-Method/Guard abilities and malformed payloads", async () => {
		const context: Context = { messages: [userMsg("hello")] };
		const result = await buildInjection(
			context,
			retrieved(
				makeExp({ id: "a1", type: "ABILITY", payload: { role: "Other", procedure: "ignored" } }),
				makeExp({ id: "a2", type: "ABILITY", payload: { role: "Method" } }),
				makeExp({ id: "e1", type: "EVIDENCE", payload: {} }),
			),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("returns the context unchanged when there is nothing to inject", async () => {
		const context: Context = { systemPrompt: "sys", messages: [userMsg("hello")], tools: [] };
		const result = await buildInjection(context, []);
		expect(result.messages).toHaveLength(1);
		expect(result.systemPrompt).toBe("sys");
		expect(result.tools).toEqual([]);
	});

	it("does not insert a block when there is no user message", async () => {
		const context: Context = { messages: [] };
		const result = await buildInjection(context, retrieved(makeExp({ payload: { text: "evidence" } })));
		expect(result.messages).toHaveLength(0);
	});

	it("does not mutate the input context messages array", async () => {
		const messages = [userMsg("hello")];
		const context: Context = { messages };
		await buildInjection(context, retrieved(makeExp({ payload: { text: "evidence" } })));
		expect(messages).toHaveLength(1);
	});
});

describe("buildInjection with skill/SOP store", () => {
	function makeSkill(overrides: Partial<Experience>): Experience {
		return makeExp({
			id: "skill-1",
			type: "SKILL",
			title: "code-review",
			payload: { description: "How to review code" },
			...overrides,
		});
	}

	function makeSop(overrides: Partial<Experience>): Experience {
		return makeExp({
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
			...overrides,
		});
	}

	it("injects skill catalog into systemPrompt and SOP schemas into tools", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSkill({}));
		await store.insert(makeSop({}));

		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [userMsg("hello")],
			tools: [],
		};
		const result = await buildInjection(context, [], { store });
		expect(result.systemPrompt).toContain("You are helpful.");
		expect(result.systemPrompt).toContain("<available_skills>");
		expect(result.systemPrompt).toContain("code-review");
		expect(result.tools).toHaveLength(1);
		expect(result.tools?.[0]).toEqual({
			name: "get_weather",
			description: "Get weather",
			parameters: { type: "object", properties: { city: { type: "string" } } },
		});
		store.close();
	});

	it("uses the catalog as systemPrompt when the context has none", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSkill({}));

		const context: Context = { messages: [userMsg("hello")] };
		const result = await buildInjection(context, [], { store });
		expect(result.systemPrompt).toContain("<available_skills>");
		expect(result.systemPrompt).not.toContain("undefined");
		store.close();
	});

	it("dedups SOP tools against request tools by name, request tool wins", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSop({}));
		await store.insert(
			makeSop({
				id: "sop-2",
				title: "run_tests",
				payload: { schema: { name: "run_tests", description: "Run tests", parameters: {} } },
			}),
		);

		const context: Context = {
			messages: [userMsg("hello")],
			tools: [{ name: "get_weather", description: "client version", parameters: { type: "object" } as never }],
		};
		const result = await buildInjection(context, [], { store });
		expect(result.tools).toHaveLength(2);
		const names = result.tools?.map((t) => t.name);
		expect(names).toEqual(["get_weather", "run_tests"]);
		expect(result.tools?.[0].description).toBe("client version");
		store.close();
	});

	it("leaves systemPrompt and tools unchanged when the store has no active skills or SOPs", async () => {
		const store = new ExperienceStore(":memory:");
		await store.initSchema();
		await store.insert(makeSkill({ id: "skill-dormant", status: "dormant" }));
		await store.insert(makeSop({ id: "sop-removed", status: "removed" }));

		const context: Context = { systemPrompt: "sys", messages: [userMsg("hello")], tools: [] };
		const result = await buildInjection(context, [], { store });
		expect(result.systemPrompt).toBe("sys");
		expect(result.tools).toEqual([]);
		store.close();
	});
});
