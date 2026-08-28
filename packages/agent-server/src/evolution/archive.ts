/**
 * P3-T32: artifact archive with champion / stepping-stone / specialist roles.
 *
 * The archive keeps an evolving population of evaluated artifacts. Roles are
 * assigned deterministically on admission:
 *
 *   - champion: highest primary score seen so far;
 *   - stepping_stone: structurally novel (operator or parent set not present
 *     in the current champions) and passes the minimum safety bar;
 *   - specialist: highest score in a declared domain, but not the global
 *     champion;
 *   - archive: everything else.
 *
 * Retention limits are enforced per role. Eviction prefers lower scores and,
 * for stepping stones, older entries.
 */

import type { ArtifactRegistry } from "./artifact-registry.ts";

export type ArchiveRole = "champion" | "stepping_stone" | "specialist" | "archive";

export interface ArchiveMetrics {
	/** Primary numeric score used for ranking. Higher is better. */
	score: number;
	/** Optional domain tag used for specialist assignment. */
	domain?: string;
	/** Optional safety flag; false forces archive (or eviction). */
	safe?: boolean;
}

export interface ArchiveEntry {
	artifactId: string;
	kind: string;
	operator: string;
	parentIds: string[];
	metrics: ArchiveMetrics;
	role: ArchiveRole;
	retainedAt: number;
}

export interface ArchiveRetentionLimits {
	champions: number;
	steppingStones: number;
	specialists: number;
}

export interface ArchiveQuery {
	role?: ArchiveRole;
	domain?: string;
	minScore?: number;
}

const DEFAULT_LIMITS: ArchiveRetentionLimits = {
	champions: 3,
	steppingStones: 5,
	specialists: 4,
};

function parentKey(parentIds: string[]): string {
	return [...parentIds].sort().join(",");
}

export class Archive {
	private readonly registry: ArtifactRegistry;
	private readonly limits: ArchiveRetentionLimits;
	private readonly entries: ArchiveEntry[] = [];

	constructor(registry: ArtifactRegistry, limits: Partial<ArchiveRetentionLimits> = {}) {
		this.registry = registry;
		this.limits = {
			champions: limits.champions ?? DEFAULT_LIMITS.champions,
			steppingStones: limits.steppingStones ?? DEFAULT_LIMITS.steppingStones,
			specialists: limits.specialists ?? DEFAULT_LIMITS.specialists,
		};
	}

	/** Add an evaluated artifact to the archive and assign/update roles. */
	add(artifactId: string, metrics: ArchiveMetrics): ArchiveEntry {
		const manifest = this.registry.readManifest(artifactId);
		const entry: ArchiveEntry = {
			artifactId,
			kind: manifest.kind,
			operator: manifest.operator,
			parentIds: manifest.parent_ids,
			metrics: { ...metrics },
			role: "archive",
			retainedAt: Date.now(),
		};

		this.entries.push(entry);
		this.reassignRoles();
		this.enforceLimits();
		return entry;
	}

	getChampions(): ArchiveEntry[] {
		return this.entries.filter((e) => e.role === "champion").sort((a, b) => b.metrics.score - a.metrics.score);
	}

	getSteppingStones(): ArchiveEntry[] {
		return this.entries.filter((e) => e.role === "stepping_stone").sort((a, b) => b.metrics.score - a.metrics.score);
	}

	getSpecialists(domain?: string): ArchiveEntry[] {
		const specialists = this.entries.filter((e) => e.role === "specialist");
		if (domain) {
			return specialists.filter((e) => e.metrics.domain === domain);
		}
		return specialists.sort((a, b) => b.metrics.score - a.metrics.score);
	}

	query(filter: ArchiveQuery = {}): ArchiveEntry[] {
		return this.entries.filter((e) => {
			if (filter.role && e.role !== filter.role) return false;
			if (filter.domain && e.metrics.domain !== filter.domain) return false;
			if (filter.minScore !== undefined && e.metrics.score < filter.minScore) return false;
			return true;
		});
	}

	getAllEntries(): ArchiveEntry[] {
		return this.entries.slice();
	}

	private reassignRoles(): void {
		// Reset non-archive roles; keep archive as fallback.
		for (const entry of this.entries) {
			entry.role = "archive";
		}

		// Champions: highest scores.
		const sorted = [...this.entries].sort((a, b) => b.metrics.score - a.metrics.score);
		const championCount = this.limits.champions;
		const champions = sorted.slice(0, championCount).filter((e) => e.metrics.safe !== false);
		for (const c of champions) {
			c.role = "champion";
		}

		const championOperators = new Set(champions.map((c) => c.operator));
		const championParentKeys = new Set(champions.map((c) => parentKey(c.parentIds)));

		// Stepping stones: novel structure among the remaining entries.
		const remaining = sorted.filter((e) => e.role !== "champion" && e.metrics.safe !== false);
		const steppingStones: ArchiveEntry[] = [];
		for (const entry of remaining) {
			const novel = !championOperators.has(entry.operator) || !championParentKeys.has(parentKey(entry.parentIds));
			if (novel) {
				steppingStones.push(entry);
			}
		}
		// Keep the top scoring novel entries up to the limit.
		for (let i = 0; i < Math.min(steppingStones.length, this.limits.steppingStones); i++) {
			steppingStones[i].role = "stepping_stone";
		}

		// Specialists: best per domain among entries that are not champions.
		const nonChampions = sorted.filter((e) => e.role !== "champion" && e.metrics.safe !== false);
		const byDomain = new Map<string, ArchiveEntry[]>();
		for (const entry of nonChampions) {
			if (entry.metrics.domain) {
				const list = byDomain.get(entry.metrics.domain) ?? [];
				list.push(entry);
				byDomain.set(entry.metrics.domain, list);
			}
		}

		let specialistSlots = this.limits.specialists;
		for (const list of byDomain.values()) {
			list.sort((a, b) => b.metrics.score - a.metrics.score);
			if (list[0] && specialistSlots > 0 && list[0].role === "archive") {
				list[0].role = "specialist";
				specialistSlots--;
			}
		}
	}

	private enforceLimits(): void {
		const enforce = (role: ArchiveRole, limit: number, tieBreaker: (a: ArchiveEntry, b: ArchiveEntry) => number) => {
			const group = this.entries.filter((e) => e.role === role);
			if (group.length <= limit) return;
			group.sort(tieBreaker);
			const evicted = new Set(group.slice(limit).map((e) => e.artifactId));
			for (const entry of this.entries) {
				if (entry.role === role && evicted.has(entry.artifactId)) {
					entry.role = "archive";
				}
			}
		};

		enforce("champion", this.limits.champions, (a, b) => a.metrics.score - b.metrics.score);
		enforce(
			"stepping_stone",
			this.limits.steppingStones,
			(a, b) => a.metrics.score - b.metrics.score || a.retainedAt - b.retainedAt,
		);
		enforce("specialist", this.limits.specialists, (a, b) => a.metrics.score - b.metrics.score);
	}
}
