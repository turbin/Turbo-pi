import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveBenchmark } from "../../src/offline/benchmark.ts";

function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-server-bench-test-"));
	return dir;
}

function writeSession(path: string, lines: object[]) {
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

describe("deriveBenchmark", () => {
	it("returns empty samples for an empty directory", () => {
		const dir = sessionDir();
		try {
			const result = deriveBenchmark(dir);
			expect(result.samples).toEqual([]);
			expect(result.initial_skill).toContain("Task Skill");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips non-jsonl files", () => {
		const dir = sessionDir();
		try {
			writeFileSync(join(dir, "notes.txt"), "not a session", "utf-8");
			const result = deriveBenchmark(dir);
			expect(result.samples).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("extracts first user message as question and derives concept", () => {
		const dir = sessionDir();
		try {
			writeSession(join(dir, "s1.jsonl"), [
				{ type: "session", version: 3, id: "s1" },
				{ type: "message", message: { role: "user", content: "How to implement pagination in Express?" } },
				{ type: "message", message: { role: "assistant", content: "You can use query params..." } },
			]);
			const result = deriveBenchmark(dir);
			expect(result.samples).toHaveLength(1);
			expect(result.samples[0].question).toBe("How to implement pagination in Express?");
			expect(result.samples[0].concept.length).toBeGreaterThan(0);
			expect(result.samples[0].solvable).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks sessions without assistant message as not solvable", () => {
		const dir = sessionDir();
		try {
			writeSession(join(dir, "s1.jsonl"), [
				{ type: "session", version: 3, id: "s1" },
				{ type: "message", message: { role: "user", content: "A question" } },
			]);
			const result = deriveBenchmark(dir);
			expect(result.samples).toHaveLength(1);
			expect(result.samples[0].solvable).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks sessions with error custom entry as not solvable", () => {
		const dir = sessionDir();
		try {
			writeSession(join(dir, "s1.jsonl"), [
				{ type: "session", version: 3, id: "s1" },
				{ type: "message", message: { role: "user", content: "What is X?" } },
				{ type: "message", message: { role: "assistant", content: "X is..." } },
				{ type: "custom", customType: "error", data: { message: "timeout" } },
			]);
			const result = deriveBenchmark(dir);
			expect(result.samples).toHaveLength(1);
			expect(result.samples[0].solvable).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deduplicates identical questions (case-insensitive)", () => {
		const dir = sessionDir();
		try {
			writeSession(join(dir, "s1.jsonl"), [
				{ type: "session", version: 3, id: "s1" },
				{ type: "message", message: { role: "user", content: "Add two numbers" } },
				{ type: "message", message: { role: "assistant", content: "ok" } },
			]);
			writeSession(join(dir, "s2.jsonl"), [
				{ type: "session", version: 3, id: "s2" },
				{ type: "message", message: { role: "user", content: "add two numbers" } },
				{ type: "message", message: { role: "assistant", content: "ok" } },
			]);
			const result = deriveBenchmark(dir);
			expect(result.samples).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("respects maxSamples cap", () => {
		const dir = sessionDir();
		try {
			for (let i = 0; i < 10; i++) {
				writeSession(join(dir, `s${i}.jsonl`), [
					{ type: "session", version: 3, id: `s${i}` },
					{ type: "message", message: { role: "user", content: `Question number ${i}` } },
					{ type: "message", message: { role: "assistant", content: "answer" } },
				]);
			}
			const result = deriveBenchmark(dir, { maxSamples: 3 });
			expect(result.samples).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("respects custom initial_skill", () => {
		const dir = sessionDir();
		try {
			const result = deriveBenchmark(dir, { initialSkill: "# Custom\nSkill text here." });
			expect(result.initial_skill).toBe("# Custom\nSkill text here.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("produces valid benchmark JSON that skill_evolution can consume", () => {
		const dir = sessionDir();
		try {
			writeSession(join(dir, "s1.jsonl"), [
				{ type: "session", version: 3, id: "s1" },
				{ type: "message", message: { role: "user", content: "Debug a CORS error" } },
				{ type: "message", message: { role: "assistant", content: "Check cors middleware config" } },
			]);
			const result = deriveBenchmark(dir);
			// Verify the benchmark JSON contract expected by skill_evolution.pipeline CLI
			expect(typeof result.initial_skill).toBe("string");
			expect(Array.isArray(result.samples)).toBe(true);
			for (const s of result.samples) {
				expect(typeof s.id).toBe("string");
				expect(typeof s.concept).toBe("string");
				expect(typeof s.question).toBe("string");
				expect(typeof s.solvable).toBe("boolean");
			}
			// The benchmark should be JSON-serializable
			const json = JSON.stringify(result);
			const parsed = JSON.parse(json);
			expect(parsed.samples.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
