/**
 * Product manifest collector (Phase 1 evidence plane).
 *
 * Records the identity of every product artifact a run touched: path, size,
 * sha256 content hash, and mtime. Also provides collectFromDirectory() to
 * build a manifest from a directory tree. Symlinks are never traversed and
 * node_modules is excluded by default.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface ProductManifestEntry {
	/** Path of the artifact (relative to the scanned root when collected via collectFromDirectory). */
	path: string;
	/** File size in bytes. */
	sizeBytes: number;
	/** 64-char lowercase sha256 hex of the file contents. */
	sha256: string;
	/** File modification time in Unix epoch milliseconds. */
	mtimeMs: number;
}

const DEFAULT_EXCLUDES = ["node_modules"];

export class ProductManifestCollector {
	private entries: ProductManifestEntry[] = [];

	record(entry: ProductManifestEntry): void {
		this.entries.push(entry);
	}

	/** Returns a shallow copy of all recorded entries in record order. */
	getManifest(): ProductManifestEntry[] {
		return [...this.entries];
	}
}

export function createProductManifestCollector(): ProductManifestCollector {
	return new ProductManifestCollector();
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExcluded(relPath: string, excludes: string[]): boolean {
	const segments = relPath.split(sep);
	return excludes.some((exclude) => relPath === exclude || segments.includes(exclude));
}

/**
 * Scans a directory recursively and returns a manifest entry per regular file,
 * sorted by relative path. Symlinks are never followed. Entries whose relative
 * path (or any path segment) matches an exclude entry are skipped; node_modules
 * is always excluded unless overridden via a custom exclude list that omits it.
 */
export function collectFromDirectory(dir: string, exclude?: string[]): ProductManifestEntry[] {
	const excludes = exclude ?? DEFAULT_EXCLUDES;
	const entries: ProductManifestEntry[] = [];

	const walk = (current: string): void => {
		for (const name of readdirSync(current)) {
			const fullPath = join(current, name);
			const relPath = relative(dir, fullPath);
			if (isExcluded(relPath, excludes)) {
				continue;
			}
			const stat = lstatSync(fullPath);
			if (stat.isSymbolicLink()) {
				continue;
			}
			if (stat.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!stat.isFile()) {
				continue;
			}
			entries.push({
				path: relPath,
				sizeBytes: stat.size,
				sha256: sha256File(fullPath),
				mtimeMs: stat.mtimeMs,
			});
		}
	};

	walk(dir);
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}
