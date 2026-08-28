import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Archive } from "../../src/evolution/archive.ts";
import { type ArtifactRegistry, openArtifactRegistry } from "../../src/evolution/artifact-registry.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { openEvolutionDb } from "../../src/evolution/db.ts";
import { LineageTracker } from "../../src/evolution/lineage.ts";
import { applyScaffoldOperator } from "../../src/evolution/scaffold-operators.ts";

describe("P3-T32 archive retention", () => {
	let base: string;
	let registry: ArtifactRegistry;
	let lineage: LineageTracker;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "evo-archive-"));
		const evo = openEvolutionDb(join(base, "evolution.db"));
		registry = openArtifactRegistry(evo.db, join(base, "blobs"));
		lineage = new LineageTracker(evo.db);
		DevAuditWriter.loadOrCreate(join(base, "creds"));
	});

	afterEach(() => {
		registry.close();
		rmSync(base, { recursive: true, force: true });
	});

	function draftArtifact(): string {
		const result = applyScaffoldOperator(registry, lineage, {
			operator: "draft",
			evidenceRefs: ["cluster-archive"],
		});
		if (result.status !== "generated") {
			throw new Error(`draft failed: ${result.error}`);
		}
		return result.artifactId;
	}

	function improvedArtifact(parentId: string): string {
		const result = applyScaffoldOperator(registry, lineage, {
			operator: "improve",
			parentArtifactIds: [parentId],
			evidenceRefs: ["cluster-archive"],
		});
		if (result.status !== "generated") {
			throw new Error(`improve failed: ${result.error}`);
		}
		return result.artifactId;
	}

	it("selects the highest scorer as champion", () => {
		const archive = new Archive(registry, { champions: 1, steppingStones: 0, specialists: 0 });
		const a = draftArtifact();
		const b = draftArtifact();
		archive.add(a, { score: 0.6 });
		archive.add(b, { score: 0.8 });

		const champions = archive.getChampions();
		expect(champions).toHaveLength(1);
		expect(champions[0].artifactId).toBe(b);
	});

	it("identifies stepping stones by structural novelty", () => {
		const archive = new Archive(registry, { champions: 1, steppingStones: 2, specialists: 0 });
		const parent = draftArtifact();
		const child = improvedArtifact(parent);

		archive.add(parent, { score: 0.9 });
		archive.add(child, { score: 0.7 });

		const stones = archive.getSteppingStones();
		expect(stones).toHaveLength(1);
		expect(stones[0].artifactId).toBe(child);
		expect(stones[0].operator).toBe("improve");
	});

	it("identifies specialists by domain", () => {
		const archive = new Archive(registry, { champions: 1, steppingStones: 0, specialists: 2 });
		const global = draftArtifact();
		const domainA = draftArtifact();
		const domainB = draftArtifact();

		archive.add(global, { score: 0.9 });
		archive.add(domainA, { score: 0.7, domain: "retrieval" });
		archive.add(domainB, { score: 0.75, domain: "injection" });

		expect(archive.getChampions()[0].artifactId).toBe(global);
		expect(archive.getSpecialists()).toHaveLength(2);
		expect(archive.getSpecialists("retrieval")[0].artifactId).toBe(domainA);
		expect(archive.getSpecialists("injection")[0].artifactId).toBe(domainB);
	});

	it("enforces retention limits by demoting excess entries", () => {
		const archive = new Archive(registry, { champions: 2, steppingStones: 0, specialists: 0 });
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push(draftArtifact());
		}

		archive.add(ids[0], { score: 0.5 });
		archive.add(ids[1], { score: 0.9 });
		archive.add(ids[2], { score: 0.7 });
		archive.add(ids[3], { score: 0.95 });

		const champions = archive.getChampions();
		expect(champions).toHaveLength(2);
		expect(champions.map((c) => c.artifactId)).toEqual([ids[3], ids[1]]);
	});

	it("queries by role, domain, and score", () => {
		const archive = new Archive(registry, { champions: 1, steppingStones: 0, specialists: 1 });
		const a = draftArtifact();
		const b = draftArtifact();

		archive.add(a, { score: 0.9 });
		archive.add(b, { score: 0.6, domain: "retrieval" });

		expect(archive.query({ role: "champion" })).toHaveLength(1);
		expect(archive.query({ role: "specialist" })).toHaveLength(1);
		expect(archive.query({ domain: "retrieval" })[0].artifactId).toBe(b);
		expect(archive.query({ minScore: 0.8 })).toHaveLength(1);
	});
});
