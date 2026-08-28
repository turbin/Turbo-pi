import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd.bind(process);

export const rootDir = mkdtempSync(join(tmpdir(), "gen0-scaffold-"));

function writeFiles(dir: string): void {
	mkdirSync(join(dir, "packages", "coding-agent", ".pi"), { recursive: true });
	writeFileSync(
		join(dir, "packages", "coding-agent", ".pi", "config.json"),
		JSON.stringify({ provider: "faux", model: "faux-model" }),
	);
	writeFileSync(join(dir, "packages", "coding-agent", ".pi", "system-prompt.md"), "# system prompt");
	writeFileSync(join(dir, "biome.json"), JSON.stringify({}));
	writeFileSync(join(dir, "package-lock.json"), JSON.stringify({}));
	writeFileSync(join(dir, "packages", "coding-agent", "package.json"), JSON.stringify({}));
}

export function clearScaffoldFiles(): void {
	for (const file of [
		join(rootDir, "packages", "coding-agent", ".pi", "config.json"),
		join(rootDir, "packages", "coding-agent", ".pi", "system-prompt.md"),
		join(rootDir, "biome.json"),
		join(rootDir, "package-lock.json"),
		join(rootDir, "packages", "coding-agent", "package.json"),
	]) {
		if (existsSync(file)) rmSync(file);
	}
}

export function writeScaffoldFiles(): void {
	writeFiles(rootDir);
}

writeFiles(rootDir);
process.cwd = () => rootDir;

export function restoreCwd(): void {
	process.cwd = originalCwd;
}
