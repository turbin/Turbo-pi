import type { Message, Model } from "@earendil-works/pi-ai";
import type { InjectionPayload } from "./types.ts";

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
	for (const msg of payload.messages) {
		messages.push(toOpenAIMessage(msg));
	}
	if (payload.systemPrompt) {
		// M5 (adversarial review 2026-08-09): merge the injected systemPrompt
		// (skill catalog) into the caller's existing system message instead of
		// prepending a second one. Control arms are [system(harness), user]; a
		// separate catalog system message would make experiment arms
		// [system(catalog), system(harness), ...] — an arm-asymmetric skeleton
		// that also grows with the catalog. Only when the caller has no system
		// message at all does the systemPrompt stand alone.
		const firstSystem = messages.find((m) => m.role === "system");
		if (firstSystem) {
			firstSystem.content = `${firstSystem.content}\n\n${payload.systemPrompt}`;
		} else {
			messages.unshift({ role: "system", content: payload.systemPrompt });
		}
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

/**
 * What {@link toOpenAIMessage} actually accepts at runtime: pi-ai Context
 * messages or the normalized OpenAI-style messages OpenAI-compatible clients
 * send (server.ts forwards these after joining content part arrays into
 * strings). The declared parameter type used to claim pi-ai only, which was
 * dishonest about the OpenAI-shaped pass-through path.
 */
export type OpenAIInputMessage = Message | OpenAIRequestMessage;

function toOpenAIMessage(msg: OpenAIInputMessage): OpenAIRequestMessage {
	// OpenAI clients (e.g. Kimi Code) send the system prompt as a message and
	// keep history in OpenAI shape; pass these through instead of letting them
	// fall into the toolResult branch (which produced tool messages without
	// tool_call_id, rejected by the gateway with a 400).
	const role = (msg as { role: string }).role;
	if (role === "system") {
		const content = (msg as { content: unknown }).content;
		const text = Array.isArray(content)
			? content.map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? ""))).join("")
			: String(content ?? "");
		return { role: "system", content: text };
	}

	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			return { role: "user", content: msg.content };
		}
		const content: OpenAIContentPart[] = (msg.content ?? []).map((part) => {
			if (part.type === "text") return { type: "text", text: part.text };
			if (part.type === "image_url") return part; // already OpenAI-shaped
			return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
		});
		return { role: "user", content };
	}

	if (msg.role === "assistant") {
		// OpenAI clients send `content: null` on pure tool_calls turns; treat it as "".
		if (typeof msg.content === "string" || msg.content == null) {
			const message: OpenAIRequestMessage = { role: "assistant", content: msg.content ?? "" };
			const rawCalls = (msg as { tool_calls?: OpenAIToolCall[] }).tool_calls;
			if (rawCalls?.length) message.tool_calls = rawCalls;
			return message;
		}
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		const toolCalls = msg.content.filter((part) => part.type === "toolCall").map(toOpenAIToolCall);
		const message: OpenAIRequestMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") };
		if (toolCalls.length) message.tool_calls = toolCalls;
		return message;
	}

	// toolResult (pi-ai) / tool (OpenAI-style)
	const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? (msg as { tool_call_id?: string }).tool_call_id;
	if (typeof msg.content === "string") {
		return { role: "tool", content: msg.content, tool_call_id: toolCallId };
	}
	const text = (msg.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
	return { role: "tool", content: text, tool_call_id: toolCallId };
}

function toOpenAIToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): OpenAIToolCall {
	return {
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.arguments) },
	};
}
