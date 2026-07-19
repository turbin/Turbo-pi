import type { Context } from "@earendil-works/pi-ai";
import type { InjectionPayload, RetrievedExperience } from "./types.ts";

/**
 * Assemble the replay injection payload: evidence pool, Method, and Guard
 * blocks are merged into one synthetic user message inserted before the last
 * real user message (SPEC §5.1 step 4). Skill catalog (`<available_skills>`)
 * and SOP tool-schema injection are deferred to P1.
 *
 * `ExperienceStore.search` does not filter by status, so `removed`
 * experiences are dropped here before they can reach the prompt.
 */
export function buildInjection(context: Context, retrieved: RetrievedExperience[]): InjectionPayload {
	// Only replay verifier-approved experiences; dormant/removed stay out of the prompt (SPEC §5.2).
	const active = retrieved.filter((r) => r.experience.status === "active");

	const evidence: string[] = [];
	const methods: string[] = [];
	const guards: string[] = [];
	for (const r of active) {
		const { type, payload } = r.experience;
		if (type === "EVIDENCE") {
			if (typeof payload.text === "string" && payload.text) evidence.push(payload.text);
		} else if (type === "ABILITY" && payload.role === "Method") {
			if (typeof payload.procedure === "string" && payload.procedure) methods.push(payload.procedure);
		} else if (type === "ABILITY" && payload.role === "Guard") {
			if (typeof payload.boundary === "string" && payload.boundary) guards.push(`注意：${payload.boundary}`);
		}
	}

	const blocks: string[] = [];
	if (evidence.length) blocks.push(`<Extra Info>\n${evidence.join("\n")}\n</Extra Info>`);
	if (methods.length) blocks.push(methods.join("\n"));
	if (guards.length) blocks.push(guards.join("\n"));

	const messages = [...context.messages];
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	if (blocks.length && lastUserIdx >= 0) {
		messages.splice(lastUserIdx, 0, { role: "user", content: blocks.join("\n\n"), timestamp: Date.now() });
	}

	// TODO(P1): skill catalog -> systemPrompt <available_skills>, SOP schemas -> tools.
	return { messages, systemPrompt: context.systemPrompt, tools: context.tools };
}
