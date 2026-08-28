/**
 * P3-T29: scaffold v1 configuration schema.
 *
 * The scaffold is the immutable, hashable contract that captures the
 * harness-level knobs that can be varied during Phase 3: system prompt
 * fragments, active tools, retrieval/injection limits, compaction/retry
 * policy, and the declared provider/model sampling matrix.
 */

export type InjectionPosition = "before_last_user" | "after_last_user";

export interface RetryPolicy {
	enabled: boolean;
	maxRetries: number;
	backoffMs: number;
}

export interface ScaffoldConfig {
	/** Ordered system-prompt fragments that define the agent persona. */
	systemPromptFragments: string[];
	/** Names of tools that are currently active. */
	activeTools: string[];
	/** Per-tool execution mode (e.g. "standard", "observe-only", "requires-approval"). */
	toolExecutionModes: Record<string, string>;
	/** Maximum candidates retrieved before re-ranking. */
	retrievalCandidateLimit: number;
	/** Maximum entries kept after re-ranking. */
	retrievalFinalLimit: number;
	/** Maximum Method/Guard cards injected per request. */
	methodGuardLimit: number;
	/** Maximum SKILL entries injected into the system prompt. */
	skillLimit: number;
	/** Maximum SOP entries injected as tool schemas. */
	sopLimit: number;
	/** Where injected context is placed relative to the last user message. */
	injectionPosition: InjectionPosition;
	/** Template name/path used to wrap injected context. */
	wrapperTemplate: string;
	/** Compaction threshold expressed as the reserve-token budget. */
	compactionThreshold: number;
	/** Retry policy for automatic assistant-error recovery. */
	retryPolicy: RetryPolicy;
	/** Identifier of the task-level detector / version contract in force. */
	taskLevelDetectorVersion: string;
	/**
	 * Declared provider -> model sampling matrix. A provider may map to a
	 * specific model id or to a wildcard/scope marker.
	 */
	providerModelSamplingMatrix: Record<string, string>;
}
