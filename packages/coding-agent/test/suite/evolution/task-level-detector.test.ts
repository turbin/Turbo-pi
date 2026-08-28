import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

const VALID_ARTIFACT_ID = "0".repeat(64);
const VALID_SCAFFOLD_HASH = "a".repeat(64);
const VALID_SNAPSHOT_SHA = "f".repeat(64);

describe("Task-level shadow detector v1", () => {
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

	it("detects repeated tool failure and recommends escalation", async () => {
		let attempts = 0;
		const failTool: AgentTool = {
			name: "failTool",
			label: "Fail",
			description: "Always fails",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				attempts++;
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				throw new Error(`intentional failure ${value}`);
			},
		};

		const harness = await createHarness({
			sessionDir: "sessions",
			tools: [failTool],
			taskLevelDetectorVersion: "v1-rule",
		});

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("failTool", { value: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("failTool", { value: "b" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("gave up"),
			]);

			await harness.session.prompt("run the failing tool");

			expect(attempts).toBe(2);
			const snapshot = getDetectorSnapshot(harness);
			expect(snapshot).toBeDefined();
			expect(snapshot!.signals.some((signal) => signal.name === "repeatedToolFailure")).toBe(true);
			expect(snapshot!.signals.some((signal) => signal.name === "escalationRecommended")).toBe(true);
			expect(snapshot!.recommended).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("reports no signals when the task completes normally", async () => {
		const tempDir = join(tmpdir(), `pi-detector-normal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

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
				writeFileSync(join(tempDir, filePath), content, "utf8");
				return {
					content: [{ type: "text" as const, text: `wrote ${filePath}` }],
					details: undefined,
				};
			},
		};

		const harness = await createHarness({
			sessionDir: "sessions",
			tools: [writeFileTool],
			taskLevelDetectorVersion: "v1-rule",
		});

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("writeFile", { path: "output.txt", content: "hello" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("write a file");

			const snapshot = getDetectorSnapshot(harness);
			expect(snapshot).toBeDefined();
			expect(snapshot!.signals).toHaveLength(0);
			expect(snapshot!.recommended).toBe(false);
		} finally {
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("detects delivery missing when the final assistant message has no deliverable content", async () => {
		let attempts = 0;
		const noopTool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				attempts++;
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				return {
					content: [{ type: "text" as const, text: `noop:${value}` }],
					details: undefined,
				};
			},
		};

		const harness = await createHarness({
			sessionDir: "sessions",
			tools: [noopTool],
			taskLevelDetectorVersion: "v1-rule",
		});

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("noop", { value: "x" }), { stopReason: "toolUse" }),
				fauxAssistantMessage([]),
			]);

			await harness.session.prompt("run noop");

			expect(attempts).toBe(1);
			const snapshot = getDetectorSnapshot(harness);
			expect(snapshot).toBeDefined();
			expect(snapshot!.signals.some((signal) => signal.name === "deliveryMissing")).toBe(true);
			expect(snapshot!.signals.some((signal) => signal.name === "escalationRecommended")).toBe(true);
			expect(snapshot!.recommended).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("is disabled when the detector version is off", async () => {
		const harness = await createHarness({
			sessionDir: "sessions",
			taskLevelDetectorVersion: "off",
		});

		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("simple prompt");

			const artifact = harness.session.lastEvidenceArtifact;
			expect(artifact).toBeDefined();
			const evidence = JSON.parse(artifact!.blobs[0].toString("utf8")) as Record<string, unknown>;
			expect(evidence.detector_snapshot).toBeUndefined();
			expect(artifact!.manifest.evidence_refs).not.toContain(expect.stringMatching(/^detector_signals:/));
		} finally {
			harness.cleanup();
		}
	});
});

function getDetectorSnapshot(harness: { session: { lastEvidenceArtifact?: { blobs: Buffer[] } } }) {
	const artifact = harness.session.lastEvidenceArtifact;
	expect(artifact).toBeDefined();
	const evidence = JSON.parse(artifact!.blobs[0].toString("utf8")) as Record<string, unknown>;
	return evidence.detector_snapshot as
		| {
				version: string;
				signals: Array<{ name: string; confidence: number; evidenceRefs: string[] }>;
				recommended: boolean;
		  }
		| undefined;
}
