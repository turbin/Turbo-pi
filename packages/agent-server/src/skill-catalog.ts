import type { ExperienceStore } from "./experience-store.ts";
import type { Experience } from "./types.ts";

export interface SkillCatalogResult {
	catalog: string;
	skills: Experience[];
}

export async function buildSkillCatalog(store: ExperienceStore, limit: number): Promise<SkillCatalogResult> {
	const skills = await store.listActive("SKILL", limit);
	const lines = skills.map((s) => {
		const name = escapeXml(s.title);
		const description = escapeXml(String(s.payload.description ?? ""));
		return `<skill name="${name}">${description}</skill>`;
	});
	const catalog = `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
	return { catalog, skills };
}

function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, (ch) => {
		switch (ch) {
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case "&":
				return "&amp;";
			case '"':
				return "&quot;";
			case "'":
				return "&apos;";
			default:
				return ch;
		}
	});
}
