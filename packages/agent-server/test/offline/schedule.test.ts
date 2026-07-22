import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, install, type ScheduleOptions, uninstall } from "../../src/offline/schedule.ts";

/**
 * Schedule tests live entirely inside temporary HOME directories.
 * No system file is ever touched — this satisfies the repo-wide constraint
 * that the execution agent must not write outside the project.
 */

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), "agent-server-schedule-home-"));
}

function mkOpts(overrides: Partial<ScheduleOptions> = {}): ScheduleOptions {
	const home = overrides.home ?? tmpHome();
	if (!overrides.home) {
		// Set up minimal HOME skeleton for macOS tests
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
	}
	return {
		dryRun: false,
		home,
		platform: "macos",
		command: "echo evolution-ran",
		cwd: "/fake/cwd",
		...overrides,
	};
}

describe("schedule macOS", () => {
	let opts: ScheduleOptions;

	beforeEach(() => {
		opts = mkOpts();
	});

	afterEach(() => {
		if (opts.home) rmSync(opts.home, { recursive: true, force: true });
	});

	it("install writes a plist file", () => {
		const actions = install(opts);
		expect(actions.some((a) => a.includes("plist written"))).toBe(true);
		const plistPath = join(opts.home!, "Library", "LaunchAgents", "com.agent-server.evolution.plist");
		expect(existsSync(plistPath)).toBe(true);
		const content = readFileSync(plistPath, "utf-8");
		expect(content).toContain("com.agent-server.evolution");
		expect(content).toContain("echo evolution-ran");
	});

	it("install is idempotent (second call writes nothing)", () => {
		install(opts);
		const actions = install(opts);
		expect(actions.some((a) => a.includes("already exists"))).toBe(true);
	});

	it("dry-run install does not write anything", () => {
		const dryOpts = mkOpts({ ...opts, dryRun: true });
		const actions = install(dryOpts);
		expect(actions.every((a) => a.startsWith("[dry-run]"))).toBe(true);
		const plistPath = join(opts.home!, "Library", "LaunchAgents", "com.agent-server.evolution.plist");
		expect(existsSync(plistPath)).toBe(false);
	});

	it("uninstall removes the plist", () => {
		install(opts);
		const actions = uninstall(opts);
		expect(actions.some((a) => a.includes("plist removed"))).toBe(true);
		const plistPath = join(opts.home!, "Library", "LaunchAgents", "com.agent-server.evolution.plist");
		expect(existsSync(plistPath)).toBe(false);
	});

	it("uninstall is idempotent (second call says nothing to remove)", () => {
		install(opts);
		uninstall(opts);
		const actions = uninstall(opts);
		expect(actions.some((a) => a.includes("nothing to remove"))).toBe(true);
	});

	it("dry-run uninstall does not remove anything", () => {
		install(opts);
		const dryOpts = mkOpts({ ...opts, dryRun: true });
		const actions = uninstall(dryOpts);
		expect(actions.every((a) => a.startsWith("[dry-run]"))).toBe(true);
		const plistPath = join(opts.home!, "Library", "LaunchAgents", "com.agent-server.evolution.plist");
		expect(existsSync(plistPath)).toBe(true);
	});
});

describe("schedule macOS full lifecycle", () => {
	it("install → doctor→uninstall→doctor chain", () => {
		const home = tmpHome();
		// minimal HOME without LaunchAgents dir; install creates it on demand
		const optsBase: ScheduleOptions = { dryRun: false, home, platform: "macos", command: "echo test" };

		// Doctor before install
		const d1 = doctor(optsBase);
		expect(d1.installed).toBe(false);

		// Install
		const instActions = install(optsBase);
		expect(instActions.some((a) => a.includes("plist written"))).toBe(true);

		// Doctor after install
		const d2 = doctor(optsBase);
		expect(d2.installed).toBe(true);

		// Uninstall
		const uninstActions = uninstall(optsBase);
		expect(uninstActions.some((a) => a.includes("plist removed"))).toBe(true);

		// Doctor after uninstall
		const d3 = doctor(optsBase);
		expect(d3.installed).toBe(false);

		rmSync(home, { recursive: true, force: true });
	});
});

describe("schedule Linux crontab", () => {
	/**
	 * Linux crontab tests work against a fake HOME and simulate the equivalent
	 * of crontab operations by reading/writing a fake crontab file in the
	 * temporary HOME. The execSync calls for crontab will fail in test, so we
	 * mock the relevant environment.
	 *
	 * Strategy: use --dry-run to verify the logic without touching the real
	 * crontab, plus targeted unit-level assertions on crontab entry generation.
	 */
	it("dry-run install generates correct crontab entry", () => {
		const home = tmpHome();
		const opts: ScheduleOptions = {
			dryRun: true,
			home,
			platform: "linux",
			command: "npx tsx src/offline/run-evolution.ts",
			cwd: "/app",
		};
		const actions = install(opts);
		// On first dry-run with no crontab installed, it should suggest the entry
		expect(actions.some((a) => a.includes("run-evolution"))).toBe(true);
		rmSync(home, { recursive: true, force: true });
	});

	it("dry-run uninstall detects no entry", () => {
		const home = tmpHome();
		const opts: ScheduleOptions = {
			dryRun: true,
			home,
			platform: "linux",
		};
		const actions = uninstall(opts);
		expect(actions.some((a) => a.includes("nothing to remove"))).toBe(true);
		rmSync(home, { recursive: true, force: true });
	});

	it("doctor for unsupported platform reports no schedule", () => {
		const home = tmpHome();
		const report = doctor({ dryRun: true, home, platform: "unsupported" });
		expect(report.installed).toBe(false);
		expect(report.issues.some((i) => i.includes("unsupported"))).toBe(true);
		rmSync(home, { recursive: true, force: true });
	});
});

describe("schedule dry-run safety", () => {
	it("dry-run never writes files (macOS)", () => {
		const home = tmpHome();
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		const opts: ScheduleOptions = { dryRun: true, home, platform: "macos" };
		install(opts);
		uninstall(opts);
		// Nothing should have been created or removed
		const files = existsSync(join(home, "Library", "LaunchAgents", "com.agent-server.evolution.plist"));
		expect(files).toBe(false);
		rmSync(home, { recursive: true, force: true });
	});
});
