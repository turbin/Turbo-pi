import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExperienceStore } from "../experience-store.ts";
import type { Experience } from "../types.ts";
import { contentHashFor, dedupeCandidates } from "./canonicalize.ts";

/**
 * TS-side verifier (SPEC §4.2 step 4 / §6 Stage 3+5).
 *
 * The continuous quality scores themselves come from the vendored Python
 * `verification_selection` pipeline (Verifier / TwoStageScorer, PPT
 * tournament or vs-reference preference) — they are NOT recomputed here.
 * This module is the promotion gate between the staged pipeline outputs
 * (skills.json / sops.json / cards.json from `runOfflinePipeline`) and the
 * ExperienceStore:
 *
 * - quality >= PROMOTION_THRESHOLD (0.5, SPEC §6 Stage 2c) -> active;
 * - below threshold -> not inserted (low-score trajectories are dropped, per
 *   the handoff simplification "no negative experience library"; Guards come
 *   only from the boundary field of verified cards, never from failed
 *   trajectories);
 * - cards with role "Method"/"Guard" are promoted as type "ABILITY" (the
 *   five-tuple payload feeds buildInjection); all other cards stay
 *   "EVIDENCE";
 * - canonicalize dedup via contentHash: a batch-internal duplicate is
 *   dropped, an already-active store row is left alone, and a dormant ETL
 *   candidate carrying the same contentHash is promoted in place.
 */

export const PROMOTION_THRESHOLD = 0.5;

export interface VerifyItem {
	/** Store id; defaults to `exp-<hash16>`. */
	id?: string;
	/** Experience type; defaults to "EVIDENCE". */
	type?: Experience["type"];
	/** Row title; defaults to payload.name / payload.text prefix / id. */
	title?: string;
	/** Continuous score from the Python verifier (or skill utility). */
	quality: number;
	payload?: Record<string, unknown>;
	/**
	 * Precomputed content hash. Set when the caller knows the hash scheme of
	 * an existing row (e.g. re-verification of ETL candidates, which hash
	 * sha256(text)); otherwise the canonical (type,title,payload) hash is used.
	 */
	contentHash?: string;
	sourceSession?: string;
	sourceEntryId?: string;
}

/**
 * Promote verified items into the store. Returns the number of entries that
 * are active because of this call (new inserts + dormant rows promoted).
 * The whole batch runs in one transaction: a mid-batch failure rolls back
 * every insert/promotion of this call instead of leaving a half-promoted batch.
 */
export async function verifyAndCanonicalize(items: VerifyItem[], store: ExperienceStore): Promise<number> {
	const candidates = dedupeCandidates(
		items.filter((item) => item.quality >= PROMOTION_THRESHOLD),
		(item) => item.contentHash ?? contentHashFor(normalizeItem(item)),
	);

	let activeCount = 0;
	await store.transaction(async () => {
		for (const item of candidates) {
			const normalized = normalizeItem(item);
			const hash = item.contentHash ?? contentHashFor(normalized);
			const existing = await store.getByContentHash(hash);
			if (existing) {
				if (existing.status === "dormant") {
					await store.promoteToActive(existing.id, item.quality);
					activeCount++;
				}
				continue;
			}
			await store.insert({
				id: item.id ?? `exp-${hash.slice(0, 16)}`,
				type: normalized.type,
				title: normalized.title,
				payload: normalized.payload,
				quality: item.quality,
				// F2 (T3): 新卡置信度默认 0.5（实战归因由离线脚本按证据更新）。
				confidence: 0.5,
				rescoreExcludedBatches: 0,
				status: "active",
				sourceSession: item.sourceSession ?? "",
				sourceEntryId: item.sourceEntryId ?? "",
				contentHash: hash,
				createdAt: new Date().toISOString(),
			});
			activeCount++;
		}
	});
	return activeCount;
}

function normalizeItem(item: VerifyItem): {
	type: Experience["type"];
	title: string;
	payload: Record<string, unknown>;
} {
	const payload = item.payload ?? {};
	const type = item.type ?? "EVIDENCE";
	const fallbackTitle =
		(typeof payload.name === "string" && payload.name) ||
		(typeof payload.text === "string" && payload.text.slice(0, 50)) ||
		item.id ||
		"untitled";
	return { type, title: item.title ?? fallbackTitle, payload };
}

// ---------------------------------------------------------------------------
// Staged pipeline output mapping (runOfflinePipeline outputDir -> VerifyItem)
// ---------------------------------------------------------------------------

interface StagedSkill {
	name?: string;
	summary?: string;
	utility?: number;
	content?: string;
}

interface StagedSop {
	name?: string;
	code?: string;
	docstring?: string;
	schema?: Record<string, unknown>;
	tools?: string[];
}

interface StagedCard {
	taskId?: string;
	quality?: number;
	card?: {
		name?: string;
		trigger?: string;
		procedure?: string;
		boundary?: string;
		role?: string;
		evidence?: Record<string, unknown>;
		deliverables?: unknown;
	};
}

/** skills.json: [{name, summary, utility, content}] — quality = evolution utility. */
export function skillsToStaged(skills: StagedSkill[]): VerifyItem[] {
	return skills.map((skill) => ({
		type: "SKILL",
		title: skill.name ?? "unnamed-skill",
		quality: typeof skill.utility === "number" ? skill.utility : 0,
		payload: {
			name: skill.name ?? "",
			summary: skill.summary ?? "",
			description: skill.summary ?? "",
			content: skill.content ?? "",
			utility: skill.utility ?? 0,
			text: skill.content ?? "",
		},
		sourceEntryId: skill.name ?? "",
	}));
}

/**
 * sops.json: [{name, code, docstring, schema, tools}]. The Python SOP
 * lifecycle already pruned these (construction -> merge -> re-execution), so
 * they are pre-vetted and enter at full quality (SPEC §6 Stage 2b).
 */
export function sopsToStaged(sops: StagedSop[]): VerifyItem[] {
	return sops.map((sop) => ({
		type: "SOP",
		title: sop.name ?? "unnamed-sop",
		quality: 1,
		payload: {
			name: sop.name ?? "",
			code: sop.code ?? "",
			docstring: sop.docstring ?? "",
			schema: sop.schema ?? {},
			tools: sop.tools ?? [],
			text: sop.docstring ?? "",
		},
		sourceEntryId: sop.name ?? "",
	}));
}

/**
 * 交付物清单规范化（issue-010）：仅接受非空字符串数组；缺字段/空数组/
 * 含空串或非字符串项均返回 null（Method/Guard 卡在闸门处被拦截）。
 */
function normalizeDeliverables(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const items: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string" || !item.trim()) return null;
		items.push(item);
	}
	return items;
}

/**
 * cards.json: [{taskId, quality, card:{五元组+deliverables}}] — quality =
 * verifier continuous score. Method/Guard cards are routed to ABILITY (consumed
 * by buildInjection); Workflow, missing and unknown roles stay EVIDENCE.
 *
 * 交付检查（issue-010）：Method/Guard（ABILITY）卡必须携带非空 deliverables
 * 交付物清单，否则不晋升（旧模板卡 / 空清单卡在闸门处拦截——Python 打分侧
 * 另有无交付轨迹 quality 封顶 <0.5 的第一道拦截）。SOP/SKILL/EVIDENCE 显式
 * 豁免（SOP quality=1 预验证通道、SKILL utility、EVIDENCE 无交付物概念）。
 */
export function cardsToStaged(cards: StagedCard[]): VerifyItem[] {
	const items: VerifyItem[] = [];
	for (const entry of cards) {
		const card = entry.card;
		if (!card) continue;
		const type = card.role === "Method" || card.role === "Guard" ? "ABILITY" : "EVIDENCE";
		const deliverables = normalizeDeliverables(card.deliverables);
		if (type === "ABILITY" && deliverables === null) continue;
		items.push({
			type,
			title: card.name ?? ((card.trigger ?? "").slice(0, 50) || "unnamed-card"),
			quality: typeof entry.quality === "number" ? entry.quality : 0,
			payload: {
				name: card.name ?? "",
				trigger: card.trigger ?? "",
				procedure: card.procedure ?? "",
				boundary: card.boundary ?? "",
				role: card.role ?? "",
				evidence: card.evidence ?? {},
				deliverables: deliverables ?? [],
				taskId: entry.taskId ?? "",
				text: [card.trigger, card.procedure].filter(Boolean).join("\n"),
			},
			sourceEntryId: entry.taskId ?? "",
		});
	}
	return items;
}

function readJsonArray(path: string): unknown[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new Error(
			`verifier: staged output ${path} is missing or unreadable; the offline pipeline stage must run first (${(err as Error).message})`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		throw new Error(`verifier: failed to parse JSON in ${path}: ${(err as Error).message}`);
	}
	if (!Array.isArray(data)) throw new Error(`verifier: expected a JSON array in ${path}`);
	return data;
}

/**
 * Read the staged skills/sops/cards JSON files from a `runOfflinePipeline`
 * output directory and promote the verified entries into the store. Returns
 * the number of entries activated (inserted or promoted from dormant).
 */
export async function promoteStagedOutputs(outputDir: string, store: ExperienceStore): Promise<number> {
	const items: VerifyItem[] = [
		...skillsToStaged(readJsonArray(join(outputDir, "skills.json")) as StagedSkill[]),
		...sopsToStaged(readJsonArray(join(outputDir, "sops.json")) as StagedSop[]),
		...cardsToStaged(readJsonArray(join(outputDir, "cards.json")) as StagedCard[]),
	];
	return verifyAndCanonicalize(items, store);
}
