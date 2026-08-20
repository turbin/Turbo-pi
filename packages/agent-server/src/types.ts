import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface StreamRequest {
	model: Model<any>;
	context: Context;
	options: ProxyStreamOptions;
	/** F0 (issue-013): caller-supplied task id, threaded into session metadata + request_traces. Optional. */
	taskId?: string;
	/**
	 * F3 (T4): caller-supplied domain (alfworld/office/...), threaded into
	 * session header metadata and used to filter retrieval (cross-domain
	 * tagged cards are excluded; untagged cards always pass). Optional —
	 * plain pi clients without a domain see unfiltered retrieval.
	 */
	domain?: string;
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
	/**
	 * F2 (T3): real-world attribution confidence in [0,1]. Default 0.5 for
	 * new/old rows (COALESCE default); the offline eval/attribution.py raises
	 * it on success evidence (cap 1.0) and lowers it on demotion events
	 * (>= 3 failed task-days). Retrieval ranks by quality*confidence so
	 * demoted cards sink. quality itself stays the verifier score (untouched).
	 */
	confidence: number;
	/**
	 * F2 (T3): remaining evolution runs during which this row is excluded
	 * from runDormantRescore self-re-evaluation (复升排除, N pre-registered
	 * batches) — set by the manual demotion channel (eval/attribution.py
	 * --demote), decremented once per runDailyEvolution batch.
	 */
	rescoreExcludedBatches: number;
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
	/**
	 * F0 (issue-013): ids of the cards actually injected into the prompt —
	 * EVIDENCE texts that entered the pool plus Method/Guard entries surviving
	 * the top-5 truncation. SKILL/SOP live on separate channels (catalog /
	 * tool schemas) and are explicitly excluded from this attribution set.
	 * Empty when nothing was spliced into the messages.
	 */
	injectedIds: string[];
	/**
	 * T4 (preview.html §9): injected-assembly token estimate (heuristic
	 * ceil(chars/4), see injection.ts) covering the same spliced block text
	 * as injectedIds — written to request_traces.injected_tokens. 0 when
	 * nothing was spliced.
	 */
	injectedTokens: number;
}
