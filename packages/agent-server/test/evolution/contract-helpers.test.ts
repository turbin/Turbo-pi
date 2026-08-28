import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeploymentEventInput } from "../../src/evolution/append-only-dao.ts";
import { DevAuditWriter } from "../../src/evolution/audit-writer.ts";
import { EvolutionDb } from "../../src/evolution/db.ts";
import {
	assertAgentLoopUnchanged,
	constructSeqGap,
	generateSecondAuditSigner,
	injectJournalState,
	loadM0Policy,
	scanForKernelImports,
} from "./contract-helpers.ts";

describe("M3-T8-1 contract helpers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-server-t8-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("generateSecondAuditSigner", () => {
		it("creates a key id distinct from the main signer", () => {
			const main = DevAuditWriter.loadOrCreate(join(tempDir, "main"));
			const second = generateSecondAuditSigner(join(tempDir, "main"));
			expect(second.keyId).not.toBe(main.keyId);
			expect(second.keyId).toMatch(/^dev-audit-/);
		});
	});

	describe("injectJournalState", () => {
		it("creates readable evolution_journal rows", () => {
			const dbPath = join(tempDir, "evolution.db");
			const evo = new EvolutionDb(dbPath);
			evo.migrate();

			const id = injectJournalState(evo.db, {
				operation: "test-op",
				payloadHash: "deadbeef",
				state: "written",
				createdAt: 1_700_000_000_000,
			});
			expect(id).toBeGreaterThan(0);

			const row = evo.db
				.prepare("SELECT operation, payload_hash, state, created_at FROM evolution_journal WHERE journal_id = ?")
				.get(id) as {
				operation: string;
				payload_hash: string;
				state: string;
				created_at: number;
			};
			expect(row).toBeDefined();
			expect(row.operation).toBe("test-op");
			expect(row.payload_hash).toBe("deadbeef");
			expect(row.state).toBe("written");
			expect(row.created_at).toBe(1_700_000_000_000);

			evo.close();
		});
	});

	describe("constructSeqGap", () => {
		it("removes the event with seq=2 and repairs the previous_event_id chain", () => {
			const events: DeploymentEventInput[] = [
				makeEvent("e1", 1, null),
				makeEvent("e2", 2, "e1"),
				makeEvent("e3", 3, "e2"),
				makeEvent("e4", 4, "e3"),
			];
			const result = constructSeqGap(events);
			expect(result.map((e) => e.seq)).toEqual([1, 3, 4]);
			expect(result[0].previousEventId).toBeNull();
			expect(result[1].previousEventId).toBe("e1");
			expect(result[2].previousEventId).toBe("e3");
		});

		it("throws when no event with seq=2 exists", () => {
			const events: DeploymentEventInput[] = [makeEvent("e1", 1, null), makeEvent("e3", 3, "e1")];
			expect(() => constructSeqGap(events)).toThrow("no event with seq=2 found");
		});
	});

	describe("scanForKernelImports", () => {
		it("returns empty for a clean file", () => {
			const cleanFile = join(tempDir, "clean.ts");
			writeFileSync(
				cleanFile,
				`import { foo } from "./local.ts";\nimport type { Bar } from "@earendil-works/pi-ai";\n`,
			);
			expect(scanForKernelImports(cleanFile)).toEqual([]);
		});

		it("detects a package import from @earendil-works/evaluation-kernel", () => {
			const dirtyFile = join(tempDir, "dirty.ts");
			writeFileSync(dirtyFile, `import { policy } from "@earendil-works/evaluation-kernel";\n`);
			const hits = scanForKernelImports(dirtyFile);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toContain("@earendil-works/evaluation-kernel");
		});

		it("detects a relative import into evaluation-kernel/src/", () => {
			const dirtyFile = join(tempDir, "dirty-relative.ts");
			writeFileSync(dirtyFile, `import { policy } from "../../evaluation-kernel/src/policy.ts";\n`);
			const hits = scanForKernelImports(dirtyFile);
			expect(hits).toHaveLength(1);
			expect(hits[0]).toContain("evaluation-kernel/src/");
		});
	});

	describe("assertAgentLoopUnchanged", () => {
		it("passes when packages/agent/src/agent-loop.ts has no diff", () => {
			expect(() => assertAgentLoopUnchanged()).not.toThrow();
		});
	});

	describe("loadM0Policy", () => {
		it("returns the hard-coded M0 immutable paths and local_diagnostic chain mode", () => {
			const policy = loadM0Policy();
			expect(policy.chainMode).toBe("local_diagnostic");
			expect(policy.immutablePaths).toContain("packages/evaluation-kernel/");
			expect(policy.immutablePaths).toContain("packages/agent/src/agent-loop.ts");
		});
	});
});

function makeEvent(
	eventId: string,
	seq: number,
	previousEventId: string | null,
	overrides?: Partial<DeploymentEventInput>,
): DeploymentEventInput {
	return {
		eventId,
		seq,
		slot: "test-slot",
		eventType: "shadow",
		artifactId: `artifact-${seq}`,
		previousEventId,
		previousArtifactId: null,
		operator: "draft",
		reason: "test",
		keyId: "dev-audit-test",
		signature: "sig",
		occurredAt: 1_700_000_000_000 + seq,
		...overrides,
	};
}
