/**
 * P5-3: candidate isolation runner.
 *
 * Evaluates a `source_patch` artifact in an isolated worktree:
 *   1. Fetch the source_patch bundle from the artifact registry.
 *   2. Validate the candidate manifest and the diff target paths.
 *   3. Apply the unified diff to the worktree (v1 only creates new files).
 *   4. Run a validation command through a pluggable exec runner.
 *   5. Return a deterministic evaluation report.
 *
 * The runner does NOT commit, push, or promote the candidate. It is the
 * caller's responsibility to provide an isolated worktree directory.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArtifactRegistry } from "./artifact-registry.ts";
import {
	type CandidateExtensionManifest,
	DEFAULT_CANDIDATE_PATH_WHITELIST,
	validateCandidateManifest,
	validateCandidatePath,
} from "./candidate-abi/index.ts";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface ExecRunner {
	run(
		command: string[],
		options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
	): Promise<ExecResult>;
}

export interface CandidateEvaluationInput {
	/** Artifact id of the source_patch to evaluate. */
	sourcePatchArtifactId: string;
	/** Artifact registry used to fetch the source_patch bundle. */
	registry: ArtifactRegistry;
	/**
	 * Worktree root directory. The caller must ensure this directory is isolated
	 * from the host source tree and any active runtime files.
	 */
	worktreeRoot: string;
	/**
	 * Validation command to run inside the worktree. Typical values:
	 *   ["npm", "run", "check"] or ["node", "vitest", "--run", "test/specific.test.ts"]
	 */
	validationCommand: string[];
	/** Pluggable command runner (subprocess, container, or fake for tests). */
	execRunner: ExecRunner;
	/** Path whitelist; defaults to DEFAULT_CANDIDATE_PATH_WHITELIST. */
	pathWhitelist?: readonly string[];
	/** Optional environment variables for the validation command. */
	env?: Record<string, string>;
	/** Validation timeout in milliseconds. Defaults to 5 minutes. */
	timeoutMs?: number;
}

export interface CandidateEvaluationReport {
	sourcePatchArtifactId: string;
	worktreeRoot: string;
	candidateManifest: CandidateExtensionManifest;
	appliedFiles: string[];
	validationCommand: string[];
	validationResult: ExecResult;
	/** True when the validation command exits with code 0. */
	passed: boolean;
}

export class CandidateIsolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidateIsolationError";
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * Parses a v1 unified diff and writes only new files to the worktree.
 *
 * Limitations aligned with P5-1/P5-2:
 *   - Only `--- /dev/null ... +++ <path>` hunks are supported.
 *   - Existing-file modifications and deletions are rejected.
 *   - All target paths are validated against the whitelist before writing.
 */
export function applySourcePatch(
	worktreeRoot: string,
	diffText: string,
	whitelist: readonly string[],
): { appliedFiles: string[] } {
	const appliedFiles: string[] = [];
	const lines = diffText.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (!line?.startsWith("--- ")) {
			i++;
			continue;
		}

		const oldLine = line.slice("--- ".length).split("\t")[0] ?? "";
		const newLine = lines[i + 1]?.slice("+++ ".length).split("\t")[0] ?? "";
		if (!lines[i + 1]?.startsWith("+++ ")) {
			throw new CandidateIsolationError(`malformed diff hunk at line ${i + 1}: missing +++ line`);
		}
		if (oldLine !== "/dev/null") {
			throw new CandidateIsolationError(
				`unsupported diff hunk at line ${i + 1}: only new-file creation is allowed in v1`,
			);
		}
		if (!isNonEmptyString(newLine)) {
			throw new CandidateIsolationError(`diff hunk at line ${i + 1}: missing target path`);
		}

		const validation = validateCandidatePath(newLine, whitelist);
		if (!validation.ok) {
			throw new CandidateIsolationError(`path "${newLine}" rejected by whitelist: ${validation.reason}`);
		}

		// Skip the hunk header line (@@ ... @@).
		let hunkEnd = i + 3;
		if (lines[i + 2]?.startsWith("@@")) {
			hunkEnd = i + 3;
		} else {
			throw new CandidateIsolationError(`malformed diff hunk at line ${i + 3}: missing @@ header`);
		}

		const contentLines: string[] = [];
		while (hunkEnd < lines.length && !lines[hunkEnd].startsWith("--- ")) {
			if (lines[hunkEnd].startsWith("+")) {
				contentLines.push(lines[hunkEnd].slice(1));
			} else if (lines[hunkEnd].startsWith(" ")) {
				throw new CandidateIsolationError(
					`unsupported context line in diff at line ${hunkEnd + 1}: v1 only creates new files`,
				);
			} else if (lines[hunkEnd].startsWith("-")) {
				throw new CandidateIsolationError(
					`unsupported deletion line in diff at line ${hunkEnd + 1}: v1 only creates new files`,
				);
			}
			hunkEnd++;
		}

		const filePath = `${worktreeRoot}/${newLine}`;
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, contentLines.join("\n"), "utf8");
		appliedFiles.push(newLine);

		i = hunkEnd;
	}

	return { appliedFiles };
}

/**
 * Evaluates a source_patch artifact in the provided worktree.
 */
export async function evaluateCandidate(input: CandidateEvaluationInput): Promise<CandidateEvaluationReport> {
	const bundle = input.registry.fetchBundle(input.sourcePatchArtifactId);
	if (bundle.manifest.kind !== "source_patch") {
		throw new CandidateIsolationError(
			`expected artifact ${input.sourcePatchArtifactId} to be source_patch, got ${bundle.manifest.kind}`,
		);
	}
	if (bundle.blobs.length < 2) {
		throw new CandidateIsolationError(`source_patch artifact ${input.sourcePatchArtifactId} is missing blobs`);
	}

	const diffText = bundle.blobs[0].toString("utf8");
	const manifestValidation = validateCandidateManifest(JSON.parse(bundle.blobs[1].toString("utf8")) as unknown);
	if (!manifestValidation.ok) {
		throw new CandidateIsolationError(
			`invalid candidate manifest in artifact ${input.sourcePatchArtifactId}: ${manifestValidation.errors.join("; ")}`,
		);
	}
	const candidateManifest = manifestValidation.manifest;
	const whitelist = input.pathWhitelist ?? DEFAULT_CANDIDATE_PATH_WHITELIST;

	const { appliedFiles } = applySourcePatch(input.worktreeRoot, diffText, whitelist);

	const validationResult = await input.execRunner.run(input.validationCommand, {
		cwd: input.worktreeRoot,
		env: input.env,
		timeoutMs: input.timeoutMs ?? 300_000,
	});

	return {
		sourcePatchArtifactId: input.sourcePatchArtifactId,
		worktreeRoot: input.worktreeRoot,
		candidateManifest,
		appliedFiles,
		validationCommand: input.validationCommand,
		validationResult,
		passed: validationResult.exitCode === 0,
	};
}

/**
 * Default subprocess-based exec runner.
 *
 * Runs the validation command directly in the worktree with a fresh environment.
 * This is suitable for local development and tests; production isolation should
 * plug in a container runner (Docker, gVisor, etc.) that implements the same
 * `ExecRunner` interface.
 */
export class LocalSubprocessRunner implements ExecRunner {
	async run(
		command: string[],
		options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
	): Promise<ExecResult> {
		if (command.length === 0) {
			throw new CandidateIsolationError("exec runner: command must not be empty");
		}
		const timeoutMs = options.timeoutMs ?? 300_000;
		const start = Date.now();

		return new Promise((resolve, reject) => {
			const child = spawn(command[0], command.slice(1), {
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

			const timer = setTimeout(() => {
				child.kill("SIGTERM");
			}, timeoutMs);

			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});

			child.on("close", (exitCode) => {
				clearTimeout(timer);
				resolve({
					exitCode: exitCode ?? 1,
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
					durationMs: Date.now() - start,
				});
			});
		});
	}
}
