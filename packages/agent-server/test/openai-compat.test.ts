import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { toOpenAIRequest } from "../src/openai-compat.ts";
import type { InjectionPayload } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "gemma-4-12B-it-4bit",
	name: "Gemma 4 12B IT (4bit)",
	api: "openai-completions",
	provider: "local",
	baseUrl: "http://127.0.0.1:8367/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function userMsg(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function assistantMsg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "local",
		model: model.id,
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
	};
}

function toolResultMsg(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "get_weather",
		content: [{ type: "text", text: "sunny" }],
		isError: false,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("toOpenAIRequest", () => {
	it("maps InjectionPayload to OpenAI chat completion body", () => {
		const payload: InjectionPayload = {
			messages: [userMsg("hello")],
			systemPrompt: "You are helpful.",
			tools: [{ name: "get_weather", description: "Get weather", parameters: {} }],
			injectedIds: [],
			injectedTokens: 0,
		};
		const req = toOpenAIRequest(payload, model);
		expect(req.model).toBe("gemma-4-12B-it-4bit");
		expect(req.messages[0]).toEqual({ role: "system", content: "You are helpful." });
		expect(req.messages[1]).toEqual({ role: "user", content: "hello" });
		expect(req.tools).toHaveLength(1);
		expect(req.tools?.[0]).toEqual({
			type: "function",
			function: { name: "get_weather", description: "Get weather", parameters: {} },
		});
	});

	it("omits the system message and tools when absent", () => {
		const req = toOpenAIRequest({ messages: [userMsg("hi")], injectedIds: [], injectedTokens: 0 }, model);
		expect(req.messages).toHaveLength(1);
		expect(req.messages[0].role).toBe("user");
		expect(req.tools).toBeUndefined();
	});

	it("maps user content parts to OpenAI content parts", () => {
		const req = toOpenAIRequest(
			{
				messages: [
					userMsg([
						{ type: "text", text: "what is this?" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					]),
				],
				injectedIds: [],
				injectedTokens: 0,
			},
			model,
		);
		expect(req.messages[0].content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
		]);
	});

	it("maps assistant text and tool calls", () => {
		const req = toOpenAIRequest(
			{
				messages: [
					assistantMsg([
						{ type: "text", text: "Let me check." },
						{ type: "thinking", thinking: "hmm" },
						{ type: "toolCall", id: "call-1", name: "get_weather", arguments: { city: "Berlin" } },
					]),
				],
				injectedIds: [],
				injectedTokens: 0,
			},
			model,
		);
		const msg = req.messages[0];
		expect(msg.role).toBe("assistant");
		expect(msg.content).toBe("Let me check.");
		expect(msg.tool_calls).toEqual([
			{
				id: "call-1",
				type: "function",
				function: { name: "get_weather", arguments: JSON.stringify({ city: "Berlin" }) },
			},
		]);
	});

	it("maps tool results to tool messages keyed by tool_call_id", () => {
		const req = toOpenAIRequest({ messages: [toolResultMsg()], injectedIds: [], injectedTokens: 0 }, model);
		expect(req.messages[0]).toEqual({ role: "tool", content: "sunny", tool_call_id: "call-1" });
	});

	// Kimi Code and other OpenAI clients put the system prompt in the messages
	// array (and later assistant tool_calls/tool results in OpenAI shape); these
	// must pass through instead of falling into the toolResult branch, which
	// produced tool messages without tool_call_id (gateway 400).
	it("passes through system-role messages from OpenAI clients", () => {
		const payload = {
			messages: [
				{ role: "system", content: "You are Kimi Code." },
				userMsg("帮我 review 代码"),
			] as InjectionPayload["messages"],
			injectedIds: [],
			injectedTokens: 0,
		};
		const req = toOpenAIRequest(payload, model);
		expect(req.messages[0]).toEqual({ role: "system", content: "You are Kimi Code." });
		expect(req.messages[1]).toEqual({ role: "user", content: "帮我 review 代码" });
	});

	// M5 (adversarial review 2026-08-09): when the caller already has a system
	// message, the injected systemPrompt (skill catalog) must merge INTO it —
	// never become a second system message. Control arm is
	// [system(harness), user], so the experiment arm must stay
	// [system(harness + catalog), user(evidence), user], not
	// [system(catalog), system(harness), user(evidence), user]: the prompt
	// skeleton is then arm-symmetric and stable as the catalog grows.
	it("merges injected systemPrompt into the existing system message (M5)", () => {
		const payload = {
			messages: [
				{ role: "system", content: "You are the harness." },
				userMsg("do the task"),
			] as InjectionPayload["messages"],
			systemPrompt: "<available_skills>\n- skill-a\n</available_skills>",
			injectedIds: [],
			injectedTokens: 0,
		};
		const req = toOpenAIRequest(payload, model);
		const systemMessages = req.messages.filter((m) => m.role === "system");
		expect(systemMessages).toHaveLength(1);
		expect(req.messages[0]).toEqual({
			role: "system",
			content: "You are the harness.\n\n<available_skills>\n- skill-a\n</available_skills>",
		});
		expect(req.messages[1]).toEqual({ role: "user", content: "do the task" });
	});

	it("passes through OpenAI-shaped assistant tool_calls and tool_call_id", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: "",
					tool_calls: [{ id: "call-9", type: "function", function: { name: "get_time", arguments: "{}" } }],
				},
				{ role: "tool", content: "12:00", tool_call_id: "call-9" },
			] as unknown as InjectionPayload["messages"],
			injectedIds: [],
			injectedTokens: 0,
		};
		const req = toOpenAIRequest(payload, model);
		expect(req.messages[0].role).toBe("assistant");
		expect(req.messages[0].tool_calls).toHaveLength(1);
		expect(req.messages[1]).toEqual({ role: "tool", content: "12:00", tool_call_id: "call-9" });
	});

	// OpenAI clients send `content: null` on pure tool_calls turns; it must not
	// fall into the pi-ai content-part branch and crash on `.filter`.
	it("handles assistant messages with content: null and tool_calls", () => {
		const payload = {
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call-7", type: "function", function: { name: "get_time", arguments: "{}" } }],
				},
				{ role: "tool", content: "12:00", tool_call_id: "call-7" },
			] as unknown as InjectionPayload["messages"],
			injectedIds: [],
			injectedTokens: 0,
		};
		const req = toOpenAIRequest(payload, model);
		expect(req.messages[0]).toEqual({
			role: "assistant",
			content: "",
			tool_calls: [{ id: "call-7", type: "function", function: { name: "get_time", arguments: "{}" } }],
		});
		expect(req.messages[1]).toEqual({ role: "tool", content: "12:00", tool_call_id: "call-7" });
	});
});
