/**
 * P3-T29: resolve the immutable scaffold configuration from a running
 * AgentSession.
 *
 * This module reads only public AgentSession surfaces (getters, tool names,
 * settings, version contract and current model) and builds a deterministic
 * ScaffoldConfig. Paths that vary per session directory are normalized to a
 * fixed placeholder so the same logical scaffold yields the same fingerprint.
 */

import type { AgentSession } from "../agent-session.ts";
import { fingerprintScaffoldConfig } from "./fingerprint.ts";
import type { InjectionPosition, ScaffoldConfig } from "./schema.ts";

const DEFAULT_RETRIEVAL_CANDIDATE_LIMIT = 24;
const DEFAULT_RETRIEVAL_FINAL_LIMIT = 5;
const DEFAULT_METHOD_GUARD_LIMIT = 5;
const DEFAULT_SKILL_LIMIT = 10;
const DEFAULT_SOP_LIMIT = 15;
const DEFAULT_INJECTION_POSITION: InjectionPosition = "before_last_user";
const DEFAULT_WRAPPER_TEMPLATE = "default";

function normalizeSystemPrompt(text: string, cwd: string): string {
	const normalizedCwd = cwd.replace(/\\/g, "/");
	// Replace the session-specific cwd so the same logical scaffold is stable
	// across different temporary session directories.
	let result = text.replaceAll(normalizedCwd, "<cwd>");
	if (normalizedCwd.endsWith("/")) {
		result = result.replaceAll(normalizedCwd.slice(0, -1), "<cwd>");
	} else {
		result = result.replaceAll(`${normalizedCwd}/`, "<cwd>/");
	}
	return result;
}

function buildToolExecutionModes(toolNames: string[]): Record<string, string> {
	const modes: Record<string, string> = {};
	for (const name of toolNames) {
		modes[name] = "standard";
	}
	return modes;
}

function buildSamplingMatrix(session: AgentSession): Record<string, string> {
	const matrix: Record<string, string> = {};
	const model = session.model;
	if (model) {
		matrix[model.provider] = model.id;
	}
	return matrix;
}

/**
 * Extract a deterministic ScaffoldConfig from the given AgentSession.
 *
 * The returned config contains all fields required by the Phase 3 scaffold
 * contract. Dynamic paths are normalized; fields that are not yet externally
 * configurable (retrieval limits, injection position, wrapper template) use
 * their Phase 2 fixed defaults.
 */
export function resolveScaffoldConfig(session: AgentSession): ScaffoldConfig {
	const cwd = session.sessionManager.getCwd();
	const rawSystemPrompt = session.systemPrompt;
	const activeTools = session.getActiveToolNames().slice().sort();
	const retrySettings = session.settingsManager.getRetrySettings();
	const compactionSettings = session.settingsManager.getCompactionSettings();

	return {
		systemPromptFragments: [normalizeSystemPrompt(rawSystemPrompt, cwd)],
		activeTools,
		toolExecutionModes: buildToolExecutionModes(activeTools),
		retrievalCandidateLimit: DEFAULT_RETRIEVAL_CANDIDATE_LIMIT,
		retrievalFinalLimit: DEFAULT_RETRIEVAL_FINAL_LIMIT,
		methodGuardLimit: DEFAULT_METHOD_GUARD_LIMIT,
		skillLimit: DEFAULT_SKILL_LIMIT,
		sopLimit: DEFAULT_SOP_LIMIT,
		injectionPosition: DEFAULT_INJECTION_POSITION,
		wrapperTemplate: DEFAULT_WRAPPER_TEMPLATE,
		compactionThreshold: compactionSettings.reserveTokens,
		retryPolicy: {
			enabled: retrySettings.enabled,
			maxRetries: retrySettings.maxRetries,
			backoffMs: retrySettings.baseDelayMs,
		},
		taskLevelDetectorVersion: session.taskLevelDetectorVersion,
		providerModelSamplingMatrix: buildSamplingMatrix(session),
	};
}

/** Convenience helper: resolve + fingerprint in one call. */
export function resolveScaffoldFingerprint(session: AgentSession): string {
	return fingerprintScaffoldConfig(resolveScaffoldConfig(session));
}
