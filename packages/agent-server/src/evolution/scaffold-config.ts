/**
 * P3-T29/T30: local scaffold configuration type and defaults.
 *
 * This is the agent-server copy of the scaffold contract. It mirrors the
 * coding-agent scaffold schema so that scaffold artifacts produced here can be
 * loaded by the runtime, while keeping the evolution control plane independent
 * of the client package.
 */

export type InjectionPosition = "before_last_user" | "after_last_user";

export interface RetryPolicy {
	enabled: boolean;
	maxRetries: number;
	backoffMs: number;
}

export interface ScaffoldConfig {
	systemPromptFragments: string[];
	activeTools: string[];
	toolExecutionModes: Record<string, string>;
	retrievalCandidateLimit: number;
	retrievalFinalLimit: number;
	methodGuardLimit: number;
	skillLimit: number;
	sopLimit: number;
	injectionPosition: InjectionPosition;
	wrapperTemplate: string;
	compactionThreshold: number;
	retryPolicy: RetryPolicy;
	taskLevelDetectorVersion: string;
	providerModelSamplingMatrix: Record<string, string>;
}

const DEFAULT_RETRIEVAL_CANDIDATE_LIMIT = 24;
const DEFAULT_RETRIEVAL_FINAL_LIMIT = 5;
const DEFAULT_METHOD_GUARD_LIMIT = 5;
const DEFAULT_SKILL_LIMIT = 10;
const DEFAULT_SOP_LIMIT = 15;
const DEFAULT_INJECTION_POSITION: InjectionPosition = "before_last_user";
const DEFAULT_WRAPPER_TEMPLATE = "default";
const DEFAULT_COMPACTION_THRESHOLD = 20000;
const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 3, backoffMs: 2000 };
const DEFAULT_TASK_LEVEL_DETECTOR_VERSION = "pending_0b";

export function createDefaultScaffoldConfig(): ScaffoldConfig {
	return {
		systemPromptFragments: ["You are an expert coding assistant operating inside pi."],
		activeTools: ["read", "bash", "edit", "write"],
		toolExecutionModes: { read: "standard", bash: "standard", edit: "standard", write: "standard" },
		retrievalCandidateLimit: DEFAULT_RETRIEVAL_CANDIDATE_LIMIT,
		retrievalFinalLimit: DEFAULT_RETRIEVAL_FINAL_LIMIT,
		methodGuardLimit: DEFAULT_METHOD_GUARD_LIMIT,
		skillLimit: DEFAULT_SKILL_LIMIT,
		sopLimit: DEFAULT_SOP_LIMIT,
		injectionPosition: DEFAULT_INJECTION_POSITION,
		wrapperTemplate: DEFAULT_WRAPPER_TEMPLATE,
		compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
		retryPolicy: { ...DEFAULT_RETRY_POLICY },
		taskLevelDetectorVersion: DEFAULT_TASK_LEVEL_DETECTOR_VERSION,
		providerModelSamplingMatrix: {},
	};
}

export function fillMissingFields(config: Partial<ScaffoldConfig>): ScaffoldConfig {
	const defaults = createDefaultScaffoldConfig();
	return {
		systemPromptFragments: config.systemPromptFragments ?? defaults.systemPromptFragments,
		activeTools: config.activeTools ?? defaults.activeTools,
		toolExecutionModes: config.toolExecutionModes ?? defaults.toolExecutionModes,
		retrievalCandidateLimit: config.retrievalCandidateLimit ?? defaults.retrievalCandidateLimit,
		retrievalFinalLimit: config.retrievalFinalLimit ?? defaults.retrievalFinalLimit,
		methodGuardLimit: config.methodGuardLimit ?? defaults.methodGuardLimit,
		skillLimit: config.skillLimit ?? defaults.skillLimit,
		sopLimit: config.sopLimit ?? defaults.sopLimit,
		injectionPosition: config.injectionPosition ?? defaults.injectionPosition,
		wrapperTemplate: config.wrapperTemplate ?? defaults.wrapperTemplate,
		compactionThreshold: config.compactionThreshold ?? defaults.compactionThreshold,
		retryPolicy: config.retryPolicy ?? { ...defaults.retryPolicy },
		taskLevelDetectorVersion: config.taskLevelDetectorVersion ?? defaults.taskLevelDetectorVersion,
		providerModelSamplingMatrix: config.providerModelSamplingMatrix ?? defaults.providerModelSamplingMatrix,
	};
}
