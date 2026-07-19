import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
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
	it("inserts evidence block before last user message", () => {
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [userMsg("first"), userMsg("second")],
			tools: [],
		};
		const result = buildInjection(
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

	it("inserts Method and Guard blocks", () => {
		const context: Context = { messages: [userMsg("do it")] };
		const result = buildInjection(
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

	it("filters out removed experiences", () => {
		const context: Context = { messages: [userMsg("hello")] };
		const result = buildInjection(
			context,
			retrieved(makeExp({ status: "removed", payload: { text: "stale evidence" } })),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("ignores non-Method/Guard abilities and malformed payloads", () => {
		const context: Context = { messages: [userMsg("hello")] };
		const result = buildInjection(
			context,
			retrieved(
				makeExp({ id: "a1", type: "ABILITY", payload: { role: "Other", procedure: "ignored" } }),
				makeExp({ id: "a2", type: "ABILITY", payload: { role: "Method" } }),
				makeExp({ id: "e1", type: "EVIDENCE", payload: {} }),
			),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("returns the context unchanged when there is nothing to inject", () => {
		const context: Context = { systemPrompt: "sys", messages: [userMsg("hello")], tools: [] };
		const result = buildInjection(context, []);
		expect(result.messages).toHaveLength(1);
		expect(result.systemPrompt).toBe("sys");
		expect(result.tools).toEqual([]);
	});

	it("does not insert a block when there is no user message", () => {
		const context: Context = { messages: [] };
		const result = buildInjection(context, retrieved(makeExp({ payload: { text: "evidence" } })));
		expect(result.messages).toHaveLength(0);
	});

	it("does not mutate the input context messages array", () => {
		const messages = [userMsg("hello")];
		const context: Context = { messages };
		buildInjection(context, retrieved(makeExp({ payload: { text: "evidence" } })));
		expect(messages).toHaveLength(1);
	});
});
