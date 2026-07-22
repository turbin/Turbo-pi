import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Offline evolution scheduling helpers (B3; plan A+ approved 2026-07-22).
 *
 * Three sub-commands for the platform-specific cron/launchd setup:
 *   install   – add a daily evolution trigger (idempotent)
 *   uninstall – remove the trigger (idempotent)
 *   doctor    – check whether scheduling is correctly installed
 *
 * All commands support --dry-run: print what would be done without doing it.
 *
 * Red line (per design doc): these functions are implemented and unit-tested
 * with temporary HOME directories.  The execution agent must NEVER run install
 * or uninstall without --dry-run outside a test sandbox — doing so would touch
 * system state outside the repo (forbidden by repo-wide constraints).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Platform = "macos" | "linux" | "unsupported";

export interface ScheduleOptions {
	/** Print what would be done without actually writing. */
	dryRun: boolean;
	/** Override HOME for tests (launchd plist path, crontab file). */
	home?: string;
	/** Override platform for tests. */
	platform?: Platform;
	/** The command to schedule, e.g. "npx tsx src/offline/run-evolution.ts". */
	command?: string;
	/** Working directory for the scheduled command. */
	cwd?: string;
	/** Logger for test observability. */
	log?: (msg: string) => void;
}

export interface DoctorReport {
	installed: boolean;
	issues: string[];
	fixCommands: string[];
}

const DEFAULT_COMMAND = "npx tsx src/offline/run-evolution.ts";
const LAUNCHD_LABEL = "com.agent-server.evolution";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function detectPlatform(): Platform {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "linux") return "linux";
	return "unsupported";
}

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

function resolveHome(opts: ScheduleOptions): string {
	return opts.home ?? homedir();
}

function resolvePlatform(opts: ScheduleOptions): Platform {
	return opts.platform ?? detectPlatform();
}

function resolveCommand(opts: ScheduleOptions): string {
	return opts.command ?? DEFAULT_COMMAND;
}

function resolveCwd(opts: ScheduleOptions): string {
	return opts.cwd ?? process.cwd();
}

function _log(opts: ScheduleOptions, msg: string): void {
	(opts.log ?? console.log)(msg);
}

// ---------------------------------------------------------------------------
// macOS: LaunchAgent plist
// ---------------------------------------------------------------------------

function plistPath(home: string): string {
	return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function plistContent(label: string, command: string, cwd: string, intervalSeconds: number): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>cd ${cwd} && ${command}</string>
	</array>
	<key>StartInterval</key>
	<integer>${intervalSeconds}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${cwd}/var/evolution-launchd.log</string>
	<key>StandardErrorPath</key>
	<string>${cwd}/var/evolution-launchd.err</string>
</dict>
</plist>
`;
}

function macInstall(opts: ScheduleOptions): string[] {
	const actions: string[] = [];
	const home = resolveHome(opts);
	const path = plistPath(home);
	const command = resolveCommand(opts);
	const cwd = resolveCwd(opts);
	// 24 hours in seconds
	const intervalSeconds = 24 * 60 * 60;

	if (existsSync(path)) {
		actions.push(`plist already exists at ${path} (idempotent — skipped)`);
		return actions;
	}

	const content = plistContent(LAUNCHD_LABEL, command, cwd, intervalSeconds);
	if (opts.dryRun) {
		actions.push(`[dry-run] would write plist to ${path}`);
		actions.push(`[dry-run] content:\n${content}`);
	} else {
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(path, content, "utf-8");
		actions.push(`plist written to ${path}`);
	}
	return actions;
}

function macUninstall(opts: ScheduleOptions): string[] {
	const actions: string[] = [];
	const home = resolveHome(opts);
	const path = plistPath(home);

	if (!existsSync(path)) {
		actions.push(`no plist at ${path} (idempotent — nothing to remove)`);
		return actions;
	}

	if (opts.dryRun) {
		actions.push(`[dry-run] would remove plist at ${path}`);
	} else {
		rmSync(path);
		actions.push(`plist removed from ${path}`);
	}
	return actions;
}

// ---------------------------------------------------------------------------
// Linux: crontab
// ---------------------------------------------------------------------------

function crontabEntry(command: string, cwd: string): string {
	// Run daily at a random minute (07) to avoid thundering-herd on the hour.
	return `7 3 * * * cd ${cwd} && ${command} >> ${cwd}/var/evolution-cron.log 2>&1`;
}

function readCrontab(home: string): string {
	try {
		return execSync("crontab -l", { encoding: "utf-8", env: { ...process.env, HOME: home } });
	} catch {
		// No crontab for this user
		return "";
	}
}

function writeCrontab(home: string, content: string): void {
	const tmpPath = join(home, ".crontab-tmp");
	writeFileSync(tmpPath, content, "utf-8");
	execSync(`crontab "${tmpPath}"`, { env: { ...process.env, HOME: home } });
	rmSync(tmpPath);
}

function linuxInstall(opts: ScheduleOptions): string[] {
	const actions: string[] = [];
	const home = resolveHome(opts);
	const command = resolveCommand(opts);
	const cwd = resolveCwd(opts);
	const entry = crontabEntry(command, cwd);

	if (opts.dryRun) {
		const current = readCrontab(home);
		const lines = current.split("\n").filter((l) => l.trim());
		if (lines.some((line) => line.includes("run-evolution"))) {
			actions.push(`[dry-run] crontab already has evolution entry (idempotent — skipped)`);
			return actions;
		}
		actions.push(`[dry-run] would add to crontab:`);
		actions.push(`  ${entry}`);
		return actions;
	}

	const current = readCrontab(home);
	const lines = current.split("\n").filter((l) => l.trim());
	// Idempotent: avoid duplicate entries
	if (lines.some((line) => line.includes("run-evolution"))) {
		actions.push("crontab already has evolution entry (idempotent — skipped)");
		return actions;
	}

	const newContent = lines.length > 0 ? `${current.trimEnd()}\n${entry}\n` : `${entry}\n`;
	writeCrontab(home, newContent);
	actions.push("crontab entry added");
	return actions;
}

function linuxUninstall(opts: ScheduleOptions): string[] {
	const actions: string[] = [];
	const home = resolveHome(opts);

	if (opts.dryRun) {
		const current = readCrontab(home);
		if (current.includes("run-evolution")) {
			actions.push("[dry-run] would remove evolution line from crontab");
		} else {
			actions.push("[dry-run] no evolution line in crontab (idempotent — nothing to remove)");
		}
		return actions;
	}

	const current = readCrontab(home);
	if (!current.includes("run-evolution")) {
		actions.push("no evolution line in crontab (idempotent — nothing to remove)");
		return actions;
	}

	const lines = current.split("\n").filter((line) => !line.includes("run-evolution"));
	const cleaned = lines.join("\n").trimEnd();
	if (cleaned) {
		writeCrontab(home, `${cleaned}\n`);
	} else {
		// Remove crontab entirely when the last entry is gone
		execSync("crontab -r", { env: { ...process.env, HOME: home } });
	}
	actions.push("crontab entry removed");
	return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Install the daily evolution schedule (idempotent). */
export function install(opts: ScheduleOptions): string[] {
	const platform = resolvePlatform(opts);
	const home = resolveHome(opts);
	_log(opts, `install: platform=${platform} home=${home} dryRun=${opts.dryRun}`);
	if (platform === "macos") return macInstall(opts);
	if (platform === "linux") return linuxInstall(opts);
	throw new Error(`unsupported platform: ${platform}`);
}

/** Uninstall the daily evolution schedule (idempotent). */
export function uninstall(opts: ScheduleOptions): string[] {
	const platform = resolvePlatform(opts);
	const home = resolveHome(opts);
	_log(opts, `uninstall: platform=${platform} home=${home} dryRun=${opts.dryRun}`);
	if (platform === "macos") return macUninstall(opts);
	if (platform === "linux") return linuxUninstall(opts);
	throw new Error(`unsupported platform: ${platform}`);
}

/** Check whether scheduling is correctly set up; return issues and fix suggestions. */
export function doctor(opts: ScheduleOptions): DoctorReport {
	const platform = resolvePlatform(opts);
	const home = resolveHome(opts);
	const _command = resolveCommand(opts);
	const cwd = resolveCwd(opts);
	const issues: string[] = [];
	const fixCommands: string[] = [];
	let installed = false;

	if (platform === "macos") {
		const path = plistPath(home);
		if (existsSync(path)) {
			installed = true;
		} else {
			issues.push("LaunchAgent plist not installed");
			fixCommands.push(`npx tsx src/offline/schedule.ts install`);
		}
	} else if (platform === "linux") {
		const crontab = readCrontab(home);
		if (crontab.includes("run-evolution")) {
			installed = true;
		} else {
			issues.push("crontab entry not found");
			fixCommands.push(`npx tsx src/offline/schedule.ts install`);
		}
	} else {
		issues.push(`unsupported platform: ${platform}`);
		return { installed, issues, fixCommands };
	}

	// Check that the entry command is resolvable
	try {
		execSync("which npx", { encoding: "utf-8" });
	} catch {
		issues.push("npx not found in PATH");
		fixCommands.push("install Node.js (>=22.19.0) with npx on PATH");
	}

	// Check mandatory env vars
	if (!process.env.EXPERIENCE_STORE_PATH) {
		issues.push("EXPERIENCE_STORE_PATH not set (default ./var/experience.db will be used)");
	}
	if (!process.env.AGENT_SERVER_BENCHMARK) {
		issues.push("AGENT_SERVER_BENCHMARK not set — evolution will skip skill training stage");
		fixCommands.push("export AGENT_SERVER_BENCHMARK=/path/to/benchmark.json");
	}

	// crontab-specific: check that the working directory exists
	if (platform === "linux" && !existsSync(cwd)) {
		issues.push(`working directory ${cwd} does not exist`);
		fixCommands.push(`mkdir -p ${cwd}`);
	}

	return { installed, issues, fixCommands };
}

// ---------------------------------------------------------------------------
// CLI dispatch (standalone, following benchmark.ts pattern)
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");

	if (args.includes("install")) {
		const actions = install({ dryRun });
		for (const a of actions) console.log(a);
	} else if (args.includes("uninstall")) {
		const actions = uninstall({ dryRun });
		for (const a of actions) console.log(a);
	} else if (args.includes("doctor")) {
		const report = doctor({ dryRun });
		console.log(`installed: ${report.installed}`);
		if (report.issues.length) {
			console.log("issues:");
			for (const issue of report.issues) console.log(`  - ${issue}`);
		}
		if (report.fixCommands.length) {
			console.log("fix commands:");
			for (const cmd of report.fixCommands) console.log(`  $ ${cmd}`);
		}
	} else {
		console.error("Usage: npx tsx src/offline/schedule.ts <install|uninstall|doctor> [--dry-run]");
		process.exit(1);
	}
}
