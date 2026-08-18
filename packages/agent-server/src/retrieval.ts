import type { ExperienceStore } from "./experience-store.ts";
import type { RetrievedExperience } from "./types.ts";

const CJK_RE = /[一-鿿]/;
const TOKEN_RE = /[一-鿿]+|[a-zA-Z0-9]+/g;

/**
 * Retrieve experiences relevant to `query`: FTS bm25 fetches up to
 * `min(limit * 3, 24)` candidates, then a cosine score over token
 * overlap re-ranks them and the top `limit` are returned.
 *
 * F2 (T3): final rank weight = cosine × confidence — real-world attribution
 * confidence participates in ordering so demoted (low-confidence) cards sink
 * while rewarded cards surface (plan §3-3 降权落地形态). bm25 candidate
 * fetch in store.search stays confidence-free on purpose: it only selects
 * the candidate pool; the weight applies at the re-rank step.
 */
export async function retrieve(store: ExperienceStore, query: string, limit: number): Promise<RetrievedExperience[]> {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return [];
	const candidates = await store.search(ftsQuery, Math.min(limit * 3, 24));
	const scored = candidates.map((experience) => ({
		experience,
		score: cosineScore(query, `${experience.title} ${JSON.stringify(experience.payload)}`) * experience.confidence,
	}));
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/**
 * Build a safe FTS5 MATCH query from free text. Extracts CJK runs and
 * alphanumeric words, quotes each (so user input can never break MATCH
 * syntax), and ORs them. CJK runs get a trailing `*` prefix match because
 * unicode61 does not segment CJK: a run of ideographs is stored as one
 * token, so only a prefix query can match a query run inside a longer one.
 */
function buildFtsQuery(query: string): string {
	const tokens: string[] = [];
	for (const match of query.matchAll(TOKEN_RE)) {
		const token = match[0].replace(/"/g, '""');
		if (CJK_RE.test(token)) {
			// unicode61 does not segment CJK; split runs into chars + bigrams so FTS
			// can match smaller units inside longer indexed runs.
			for (let i = 0; i < token.length; i++) {
				const ch = token[i];
				tokens.push(`"${ch}"*`);
				if (i + 1 < token.length) {
					tokens.push(`"${ch}${token[i + 1]}"*`);
				}
			}
		} else {
			tokens.push(`"${token}"`);
		}
	}
	return tokens.join(" OR ");
}

/** Cosine similarity over the token sets of query and text. */
function cosineScore(query: string, text: string): number {
	const q = new Set(tokenize(query));
	const t = new Set(tokenize(text));
	if (q.size === 0 || t.size === 0) return 0;
	let intersection = 0;
	for (const token of q) {
		if (t.has(token)) intersection++;
	}
	return intersection / Math.sqrt(q.size * t.size);
}

/** CJK single chars + bigrams; English/number words. */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (CJK_RE.test(ch)) {
			tokens.push(ch);
			if (i + 1 < text.length && CJK_RE.test(text[i + 1])) {
				tokens.push(ch + text[i + 1]);
			}
		} else if (/[a-zA-Z0-9]/.test(ch)) {
			const word = text.slice(i).match(/^[a-zA-Z0-9]+/);
			if (word) {
				tokens.push(word[0].toLowerCase());
				i += word[0].length - 1;
			}
		}
	}
	return tokens;
}
