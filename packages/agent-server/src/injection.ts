import type { Context, Tool } from "@earendil-works/pi-ai";
import type { ExperienceStore } from "./experience-store.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";
import { buildSopSchemas } from "./sop-schema.ts";
import type { InjectionPayload, RetrievedExperience } from "./types.ts";

/** SPEC §4.1: skill catalog is capped at 10 entries; SOP tool schemas at 15. */
const SKILL_CATALOG_LIMIT = 10;
const SOP_SCHEMA_LIMIT = 15;

/**
 * Assemble the replay injection payload: evidence pool, Method, and Guard
 * blocks are merged into one synthetic user message inserted before the last
 * real user message (SPEC §5.1 step 4). When a store is provided, the SKILL
 * catalog is appended to the system prompt as `<available_skills>` and SOP
 * tool schemas are merged into the tool list (SPEC §4.1).
 *
 * `ExperienceStore.search` already filters to `status='active'` at the SQL
 * level (P2 Task 2); the belt-and-suspenders filter below also drops any
 * non-active rows a caller passed in directly.
 */
export async function buildInjection(
	context: Context,
	retrieved: RetrievedExperience[],
	opts: { store?: ExperienceStore } = {},
): Promise<InjectionPayload> {
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

	let systemPrompt = context.systemPrompt;
	let tools = context.tools;

	if (opts.store) {
		const { catalog, skills } = await buildSkillCatalog(opts.store, SKILL_CATALOG_LIMIT);
		if (skills.length) {
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${catalog}` : catalog;
		}
		const sopSchemas = await buildSopSchemas(opts.store, SOP_SCHEMA_LIMIT);
		if (sopSchemas.length) {
			// SOP tools are standalone additions; on a name collision the
			// client-declared request tool wins (it is what the caller expects).
			const requestToolNames = new Set((tools ?? []).map((t) => t.name));
			const sopTools: Tool[] = sopSchemas
				.filter((t) => !requestToolNames.has(t.function.name))
				.map((t) => ({
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters as Tool["parameters"],
				}));
			tools = [...(tools ?? []), ...sopTools];
		}
	}

	return { messages, systemPrompt, tools };
}
