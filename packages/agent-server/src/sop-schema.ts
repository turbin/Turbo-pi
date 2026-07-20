import type { ExperienceStore } from "./experience-store.ts";
import type { OpenAITool } from "./openai-compat.ts";

/**
 * Assemble OpenAI function tool schemas from active SOP experiences (SPEC §4.1).
 * Hard-capped by `limit` (spec: ≤15); listActive returns highest quality first.
 */
export async function buildSopSchemas(store: ExperienceStore, limit: number): Promise<OpenAITool[]> {
	const sops = await store.listActive("SOP", limit);
	return sops.map((s) => {
		const schema = s.payload.schema as Record<string, unknown> | undefined;
		return {
			type: "function",
			function: {
				name: String(schema?.name ?? s.title),
				description: String(schema?.description ?? ""),
				parameters: schema?.parameters ?? {},
			},
		};
	});
}
