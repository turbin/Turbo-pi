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
