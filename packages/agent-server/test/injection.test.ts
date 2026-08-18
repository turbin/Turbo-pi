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
		confidence: 0.5,
		rescoreExcludedBatches: 0,
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

describe("buildInjection Method/Guard quality caps", () => {
	function methodExp(id: string, quality: number, procedure: unknown = `PROC-${id}`): Experience {
		return makeExp({ id, type: "ABILITY", quality, payload: { role: "Method", procedure } });
	}

	function guardExp(id: string, quality: number, boundary: unknown = `BOUND-${id}`): Experience {
		return makeExp({ id, type: "ABILITY", quality, payload: { role: "Guard", boundary } });
	}

	async function injectedContent(...experiences: Experience[]): Promise<string> {
		const context: Context = { messages: [userMsg("hello")] };
		const result = await buildInjection(context, retrieved(...experiences));
		const injected = result.messages[result.messages.length - 2];
		return typeof injected?.content === "string" ? injected.content : "";
	}

	function methodLines(content: string): string[] {
		return content.split("\n").filter((line) => line.startsWith("PROC-"));
	}

	function guardLines(content: string): string[] {
		return content.split("\n").filter((line) => line.startsWith("注意：BOUND-"));
	}

	// Case 1: 7 Methods, shuffled input -> top 5 by quality, descending.
	it("caps Method entries at 5, keeping the highest qualities in descending order", async () => {
		const shuffled = [0.8, 0.5, 0.95, 0.6, 0.9, 0.55, 0.7];
		const content = await injectedContent(...shuffled.map((q) => methodExp(`m-${q}`, q)));
		expect(methodLines(content)).toEqual([0.95, 0.9, 0.8, 0.7, 0.6].map((q) => `PROC-m-${q}`));
		expect(content).not.toContain("PROC-m-0.55");
		expect(content).not.toContain("PROC-m-0.5");
	});

	// Case 2: 7 Guards, shuffled input -> top 5 by quality, descending.
	it("caps Guard entries at 5, keeping the highest qualities in descending order", async () => {
		const shuffled = [0.8, 0.5, 0.95, 0.6, 0.9, 0.55, 0.7];
		const content = await injectedContent(...shuffled.map((q) => guardExp(`g-${q}`, q)));
		expect(guardLines(content)).toEqual([0.95, 0.9, 0.8, 0.7, 0.6].map((q) => `注意：BOUND-g-${q}`));
		expect(content).not.toContain("BOUND-g-0.55");
		expect(content).not.toContain("BOUND-g-0.5");
	});

	// Case 3: exactly 5 Methods (off-by-one boundary) -> all injected, no truncation.
	it("injects all 5 Methods when exactly at the limit", async () => {
		const content = await injectedContent(...[0.9, 0.8, 0.7, 0.6, 0.5].map((q) => methodExp(`m-${q}`, q)));
		expect(methodLines(content)).toHaveLength(5);
		expect(content).toContain("PROC-m-0.5");
	});

	// Case 4: fewer than the limit -> everything injected.
	it("injects all Methods when below the limit", async () => {
		const content = await injectedContent(...[0.9, 0.7, 0.5].map((q) => methodExp(`m-${q}`, q)));
		expect(methodLines(content)).toHaveLength(3);
	});

	// Case 5: no Method/Guard entries -> no Method/Guard block, no empty block.
	it("produces no Method/Guard block when there are none", async () => {
		const context: Context = { messages: [userMsg("hello")] };
		const empty = await buildInjection(context, retrieved());
		expect(empty.messages).toHaveLength(1);

		const content = await injectedContent(makeExp({ type: "EVIDENCE", payload: { text: "证据文本" } }));
		expect(content).toContain("<Extra Info>");
		expect(methodLines(content)).toHaveLength(0);
		expect(guardLines(content)).toHaveLength(0);
		expect(content).not.toContain("注意：");
	});

	// Case 6: quality ties keep their relative input order (stable sort), total still <= 5.
	it("keeps a stable relative order for quality ties", async () => {
		const content = await injectedContent(
			methodExp("top", 0.9),
			methodExp("tie-first", 0.8),
			methodExp("mid", 0.7),
			methodExp("tie-second", 0.8),
			methodExp("low", 0.6),
			methodExp("cut", 0.5),
		);
		expect(methodLines(content)).toEqual(["PROC-top", "PROC-tie-first", "PROC-tie-second", "PROC-mid", "PROC-low"]);
	});

	// Case 7: empty/non-string procedure is filtered before ranking, so it cannot consume a slot.
	it("filters malformed Method procedures before applying the limit", async () => {
		const content = await injectedContent(
			methodExp("empty", 0.99, ""),
			methodExp("non-string", 0.98, 42),
			methodExp("m-0.9", 0.9),
			methodExp("m-0.8", 0.8),
			methodExp("m-0.7", 0.7),
			methodExp("m-0.6", 0.6),
			methodExp("m-0.5", 0.5),
		);
		expect(methodLines(content)).toEqual(["PROC-m-0.9", "PROC-m-0.8", "PROC-m-0.7", "PROC-m-0.6", "PROC-m-0.5"]);
	});

	// Case 8: dormant Method entries stay out and do not count toward the 5.
	it("excludes dormant Method entries from the capped set", async () => {
		const content = await injectedContent(
			makeExp({
				id: "dormant",
				type: "ABILITY",
				quality: 0.99,
				confidence: 0.5,
				rescoreExcludedBatches: 0,
				status: "dormant",
				payload: { role: "Method", procedure: "PROC-dormant" },
			}),
			...[0.9, 0.8, 0.7, 0.6].map((q) => methodExp(`m-${q}`, q)),
		);
		expect(methodLines(content)).toHaveLength(4);
		expect(content).not.toContain("PROC-dormant");
	});

	// Case 9: Method and Guard caps are independent.
	it("caps Method and Guard independently", async () => {
		const methods = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5].map((q) => methodExp(`m-${q}`, q));
		const guards = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5].map((q) => guardExp(`g-${q}`, q));
		const content = await injectedContent(...methods, ...guards);
		expect(methodLines(content)).toHaveLength(5);
		expect(guardLines(content)).toHaveLength(5);
		expect(content).not.toContain("PROC-m-0.5");
		expect(content).not.toContain("BOUND-g-0.5");
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
