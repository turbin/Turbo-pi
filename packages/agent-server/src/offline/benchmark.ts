import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Derive a benchmark.json from session JSONL files.
 *
 * Uses the same extraction logic as {@link collectTrajectories}: first user
 * message becomes `question`, a rule-based keyword scan extracts a `concept`,
 * and sessions with explicit error signals or no assistant message are either
 * skipped or marked `solvable: false`.
 */

export interface BenchmarkSample {
	id: string;
	concept: string;
	question: string;
	solvable: boolean;
}

export interface BenchmarkFile {
	initial_skill: string;
	iterations?: number;
	samples: BenchmarkSample[];
}

export interface BenchmarkDeriveOptions {
	/** Maximum number of samples to output (default 50). */
	maxSamples?: number;
	/** Default initial_skill text. */
	initialSkill?: string;
	/** Default iterations for skill_evolution. */
	iterations?: number;
}

const DEFAULT_INITIAL_SKILL =
	"# Task Skill\n\nFollow the repo conventions: pinned deps, minimal diffs, run checks before committing.\n";

/**
 * Extract a concept tag from the user question using simple rule-based heuristics.
 * No LLM calls — deterministic and cheap.
 */
function extractConcept(question: string): string {
	// Strip common prefixes like "what is", "how to", "fix", etc.
	const cleaned = question
		.replace(/^(what|how|why|when|where|who)\s+(is|are|do|does|can|should|would|will)\s+/i, "")
		.replace(/^(fix|debug|solve|implement|add|create|build|write|refactor|optimize|update|remove|delete)\s+/i, "")
		.trim();

	// Try to find a two-word noun phrase: adjective? noun
	const nounPhrase = cleaned.match(/\b([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+){0,2})\b/);
	if (nounPhrase) return nounPhrase[1].toLowerCase().replace(/\s+/g, " ");

	// Fallback: first two significant words
	const words = cleaned
		.split(/\s+/)
		.filter((w) => w.length > 2 && !/^(the|and|for|with|that|this|from|have|been|not|but|its|are|was|all)$/i.test(w));
	return words.slice(0, 2).join(" ") || "generic task";
}

/**
 * Read session JSONL files from `sessionDir`, extract the first user message
 * and concept, and produce a benchmark JSON.
 *
 * Sessions are skipped when they contain no user message at all.
 * Sessions with an error custom entry or no assistant message are marked
 * `solvable: false`. Duplicate questions (exact match) are deduplicated.
 */
export function deriveBenchmark(sessionDir: string, options: BenchmarkDeriveOptions = {}): BenchmarkFile {
	const maxSamples = options.maxSamples ?? 50;
	const initialSkill = options.initialSkill ?? DEFAULT_INITIAL_SKILL;

	const files = readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();

	const samples: BenchmarkSample[] = [];
	const seen = new Set<string>();

	for (const file of files) {
		if (samples.length >= maxSamples) break;
		const path = join(sessionDir, file);
		const sessionId = basename(file, ".jsonl");
		const entry = _parseSession(path);

		if (!entry.question) continue; // No user message → skip
		const key = entry.question.trim().toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);

		samples.push({
			id: entry.id || sessionId,
			concept: extractConcept(entry.question),
			question: entry.question,
			solvable: entry.solvable,
		});
	}

	return { initial_skill: initialSkill, iterations: 3, samples };
}

function _parseSession(path: string): { id?: string; question: string; solvable: boolean } {
	let question = "";
	let hasAssistant = false;
	let hasError = false;
	let sessionId: string | undefined;

	const lines = readFileSync(path, "utf-8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		const type = String(entry.type ?? "");
		if (type === "session") {
			sessionId = String(entry.id ?? "");
			continue;
		}
		if (type === "custom") {
			const customType = String(entry.customType ?? "");
			if (customType === "error") hasError = true;
			continue;
		}
		if (type !== "message") continue;

		const message = entry.message as Record<string, unknown> | undefined;
		if (!message) continue;

		const role = String(message.role ?? "");
		if (role === "user" && !question) {
			question = extractTextContent(message.content);
		}
		if (role === "assistant") {
			hasAssistant = true;
		}
	}

	return {
		id: sessionId,
		question,
		solvable: !hasError && hasAssistant,
	};
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((p: unknown) => {
				if (typeof p === "string") return p;
				if (p && typeof p === "object") {
					const part = p as { text?: string; type?: string };
					return part.text ?? "";
				}
				return "";
			})
			.join("")
			.trim();
	}
	return "";
}

// ---------------------------------------------------------------------------
// CLI entry point
//
//   node --import tsx src/offline/benchmark.ts var/sessions benchmark.json
//
// Called from package root (packages/agent-server).
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const args = process.argv.slice(2);
	if (args.length < 2) {
		console.error("Usage: node --import tsx src/offline/benchmark.ts <sessionDir> <outputPath>");
		process.exit(1);
	}
	const [sessionDir, outputPath] = args;
	const benchmark = deriveBenchmark(sessionDir);
	writeFileSync(outputPath, JSON.stringify(benchmark, null, 2), "utf-8");
	console.log(`Wrote ${benchmark.samples.length} samples to ${outputPath}`);
}
