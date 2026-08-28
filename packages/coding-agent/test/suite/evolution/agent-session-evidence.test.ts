import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCanonical } from "../../../src/core/evolution/tool-event-collector.ts";
import { createHarness } from "../harness.ts";

const VALID_ARTIFACT_ID = "0".repeat(64);
const VALID_SCAFFOLD_HASH = "a".repeat(64);
const VALID_SNAPSHOT_SHA = "f".repeat(64);

describe("AgentSession evidence artifact", () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		originalEnv = {
			PI_GEN0_ARTIFACT_ID: process.env.PI_GEN0_ARTIFACT_ID,
			PI_GEN0_SCAFFOLD_HASH: process.env.PI_GEN0_SCAFFOLD_HASH,
			PI_GEN0_SNAPSHOT_SHA: process.env.PI_GEN0_SNAPSHOT_SHA,
		};
		process.env.PI_GEN0_ARTIFACT_ID = VALID_ARTIFACT_ID;
		process.env.PI_GEN0_SCAFFOLD_HASH = VALID_SCAFFOLD_HASH;
		process.env.PI_GEN0_SNAPSHOT_SHA = VALID_SNAPSHOT_SHA;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}
	});

	it("produces a composite evidence artifact after a prompt with tool events, escalation join key, outcome, and product manifest", async () => {
		let toolCwd = "";
		const writeFileTool: AgentTool = {
			name: "writeFile",
			label: "Write file",
			description: "Write content to a file",
			parameters: Type.Object({
				path: Type.String(),
				content: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				const { path: filePath, content } = params as { path: string; content: string };
				writeFileSync(join(toolCwd, filePath), content, "utf8");
				return {
					content: [{ type: "text" as const, text: `wrote ${filePath}` }],
					details: undefined,
				};
			},
		};

		const harness = await createHarness({
			sessionDir: "sessions",
			tools: [writeFileTool],
		});
		toolCwd = harness.tempDir;

		try {
			const taskId = harness.session.sessionId;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("writeFile", { path: "output.txt", content: "hello world" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);

			harness.session.recordGatewayMarker({
				gateway_sequence: 7,
				quality_signals_sha: "b".repeat(64),
				trace_id: "trace-1",
			});
			harness.session.recordGraderOutcome({
				taskId,
				outcome: "success",
				graderSha: "c".repeat(64),
				score: 1,
				timestamp: "2026-08-28T12:00:00.000Z",
			});

			await harness.session.prompt("write a file");

			const artifact = harness.session.lastEvidenceArtifact;
			expect(artifact).toBeDefined();
			expect(artifact!.artifactId).toMatch(/^[0-9a-f]{64}$/);
			expect(artifact!.manifest.kind).toBe("composite");
			expect(artifact!.manifest.scope).toEqual(["evidence"]);
			expect(artifact!.manifest.evidence_refs).toContain(`task:${taskId}`);
			expect(artifact!.manifest.evidence_refs).toContain("tool_events:1");
			expect(artifact!.manifest.evidence_refs).toContain("grader_outcomes:1");
			expect(artifact!.manifest.evidence_refs).toContain("escalation_join_keys:1");

			const productManifest = JSON.parse(artifact!.blobs[1].toString("utf8")) as Array<{
				path: string;
				sizeBytes: number;
				sha256: string;
				mtimeMs: number;
			}>;
			expect(productManifest.some((entry) => entry.path === "output.txt")).toBe(true);
			const outputEntry = productManifest.find((entry) => entry.path === "output.txt")!;
			expect(outputEntry.sha256).toBe(sha256File(join(harness.tempDir, "output.txt")));
			expect(artifact!.manifest.evidence_refs).toContain(`product_manifest_entries:${productManifest.length}`);

			const evidence = JSON.parse(artifact!.blobs[0].toString("utf8")) as Record<string, unknown>;
			expect(evidence.task_id).toBe(taskId);
			expect(evidence.version_contract).toEqual({
				artifact_id: VALID_ARTIFACT_ID,
				scaffold_hash: VALID_SCAFFOLD_HASH,
				snapshot_sha: VALID_SNAPSHOT_SHA,
			});

			const toolEvents = evidence.tool_events as Array<{
				toolName: string;
				argsHash: string;
				resultHash: string;
				durationMs: number;
				error?: string;
				timestamp: number;
			}>;
			expect(toolEvents).toHaveLength(1);
			expect(toolEvents[0].toolName).toBe("writeFile");
			expect(toolEvents[0].argsHash).toBe(hashCanonical({ path: "output.txt", content: "hello world" }));
			expect(toolEvents[0].resultHash).toBe(
				hashCanonical({
					content: [{ type: "text", text: "wrote output.txt" }],
					details: undefined,
				}),
			);
			expect(toolEvents[0].error).toBeUndefined();
			expect(toolEvents[0].durationMs).toBeGreaterThanOrEqual(0);

			expect(evidence.escalation_join_keys).toEqual([{ gatewaySequence: 7, qualitySignalsSha: "b".repeat(64) }]);

			const graderOutcomes = evidence.grader_outcomes as Array<Record<string, unknown>>;
			expect(graderOutcomes).toHaveLength(1);
			expect(graderOutcomes[0].taskId).toBe(taskId);
			expect(graderOutcomes[0].outcome).toBe("success");
			expect(evidence.user_corrections).toEqual([]);

			const sessionDir = harness.sessionManager.getSessionDir();
			const storedManifestPath = join(sessionDir, "evidence-artifacts", artifact!.artifactId, "manifest.json");
			const storedManifest = JSON.parse(readFileSync(storedManifestPath, "utf8")) as Record<string, unknown>;
			expect(storedManifest.kind).toBe("composite");
			expect(storedManifest.evidence_refs).toEqual(artifact!.manifest.evidence_refs);
		} finally {
			harness.cleanup();
		}
	});
});

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
