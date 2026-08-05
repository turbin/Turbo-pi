import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface StreamRequest {
	model: Model<any>;
	context: Context;
	options: ProxyStreamOptions;
}

export interface ProxyStreamOptions extends Partial<SimpleStreamOptions> {
	sessionId?: string;
	authToken?: string;
	/** OpenAI stop sequences, forwarded to the gateway unchanged. */
	stop?: string | string[];
	/** Vendor-specific thinking-mode switch (e.g. DeepSeek {type: "disabled"}), forwarded opaquely. */
	thinking?: Record<string, unknown>;
	/**
	 * Experience injection switch. When false, retrieval/injection are skipped
	 * and the model sees exactly the caller's context, while session recording
	 * and request traces continue unchanged (control arms run through the same
	 * code path). Defaults to the server-level setting (env
	 * AGENT_SERVER_INJECTION, default on); an explicit boolean overrides it.
	 */
	injection?: boolean;
}

export interface Experience {
	id: string;
	type: "SKILL" | "SOP" | "ABILITY" | "EVIDENCE";
	title: string;
	payload: Record<string, unknown>;
	quality: number;
	status: "active" | "dormant" | "removed";
	sourceSession: string;
	sourceEntryId: string;
	contentHash: string;
	createdAt: string;
}

export interface RetrievedExperience {
	experience: Experience;
	score: number;
}

export interface InjectionPayload {
	messages: Context["messages"];
	systemPrompt?: string;
	tools?: Context["tools"];
}
