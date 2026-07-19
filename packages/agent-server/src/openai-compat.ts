import type { Message, Model } from "@earendil-works/pi-ai";
import type { InjectionPayload } from "./types.js";

export type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAIRequestMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | OpenAIContentPart[] | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

export interface OpenAITool {
	type: "function";
	function: { name: string; description: string; parameters: unknown };
}

/** OpenAI chat completion request body sent to the gateway's /v1/chat/completions. */
export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIRequestMessage[];
	tools?: OpenAITool[];
}

/**
 * Map an injected context (SPEC §4.2) to an OpenAI-compatible chat completion
 * request body for the local model server behind the Python gateway.
 *
 * Kept self-contained instead of reusing pi-ai's provider internals: those are
 * shaped by provider-specific compat flags this proxy does not need. Thinking
 * blocks are dropped; toolResult images are dropped because OpenAI tool
 * messages carry text only.
 */
export function toOpenAIRequest(payload: InjectionPayload, model: Model<"openai-completions">): OpenAIChatRequest {
	const messages: OpenAIRequestMessage[] = [];
	if (payload.systemPrompt) {
		messages.push({ role: "system", content: payload.systemPrompt });
	}
	for (const msg of payload.messages) {
		messages.push(toOpenAIMessage(msg));
	}

	const request: OpenAIChatRequest = { model: model.id, messages };
	if (payload.tools && payload.tools.length > 0) {
		request.tools = payload.tools.map((t) => ({
			type: "function",
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
	}
	return request;
}

function toOpenAIMessage(msg: Message): OpenAIRequestMessage {
	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			return { role: "user", content: msg.content };
		}
		const content: OpenAIContentPart[] = msg.content.map((part) =>
			part.type === "text"
				? { type: "text", text: part.text }
				: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
		);
		return { role: "user", content };
	}

	if (msg.role === "assistant") {
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		const toolCalls = msg.content.filter((part) => part.type === "toolCall").map(toOpenAIToolCall);
		const message: OpenAIRequestMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") };
		if (toolCalls.length) message.tool_calls = toolCalls;
		return message;
	}

	// toolResult
	const text = msg.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	return { role: "tool", content: text, tool_call_id: msg.toolCallId };
}

function toOpenAIToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): OpenAIToolCall {
	return {
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	};
}
