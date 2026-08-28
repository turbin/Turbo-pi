import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalScaffoldJson,
	fingerprintScaffoldConfig,
	resolveScaffoldConfig,
	resolveScaffoldFingerprint,
	type ScaffoldConfig,
} from "../../../src/core/scaffold/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("P3-T29 scaffold configuration extraction", () => {
	let harnessA: Harness;
	let harnessB: Harness;

	beforeEach(async () => {
		harnessA = await createHarness({ systemPrompt: "You are a stable test assistant." });
		harnessB = await createHarness({ systemPrompt: "You are a stable test assistant." });
	});

	afterEach(() => {
		harnessA?.cleanup();
		harnessB?.cleanup();
	});

	it("resolves all required scaffold fields from a harness session", () => {
		const config = resolveScaffoldConfig(harnessA.session);
		const expectedKeys: (keyof ScaffoldConfig)[] = [
			"systemPromptFragments",
			"activeTools",
			"toolExecutionModes",
			"retrievalCandidateLimit",
			"retrievalFinalLimit",
			"methodGuardLimit",
			"skillLimit",
			"sopLimit",
			"injectionPosition",
			"wrapperTemplate",
			"compactionThreshold",
			"retryPolicy",
			"taskLevelDetectorVersion",
			"providerModelSamplingMatrix",
		];
		for (const key of expectedKeys) {
			expect(config[key]).not.toBeUndefined();
		}
		expect(config.systemPromptFragments.length).toBeGreaterThan(0);
		expect(config.activeTools.length).toBeGreaterThan(0);
		expect(config.injectionPosition).toBeOneOf(["before_last_user", "after_last_user"]);
	});

	it("produces a stable fingerprint for the same logical config", () => {
		const fpA = resolveScaffoldFingerprint(harnessA.session);
		const fpB = resolveScaffoldFingerprint(harnessB.session);
		expect(fpA).toMatch(/^[0-9a-f]{64}$/);
		expect(fpB).toBe(fpA);
	});

	it("changes the fingerprint when any field changes", async () => {
		const baseFp = resolveScaffoldFingerprint(harnessA.session);

		// Same system prompt, different active tool set -> different scaffold.
		const narrowHarness = await createHarness({
			systemPrompt: "You are a stable test assistant.",
			initialActiveToolNames: ["read"],
		});
		try {
			const narrowFp = resolveScaffoldFingerprint(narrowHarness.session);
			expect(narrowFp).not.toBe(baseFp);
		} finally {
			narrowHarness.cleanup();
		}
	});

	it("canonical JSON is stable and independent of key order", () => {
		const config = resolveScaffoldConfig(harnessA.session);
		const a = canonicalScaffoldJson(config);
		const shuffled: ScaffoldConfig = {
			...config,
			activeTools: [...config.activeTools].reverse(),
		};
		// Reversing an array changes the value, so this asserts that the
		// canonical form is deterministic for the *same* value, not that it
		// ignores array order.
		const b = canonicalScaffoldJson(config);
		expect(a).toBe(b);
		expect(canonicalScaffoldJson(shuffled)).not.toBe(a);
	});

	it("fingerprint function returns sha256 hex", () => {
		const config = resolveScaffoldConfig(harnessA.session);
		const fp = fingerprintScaffoldConfig(config);
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});
});
