import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectFromDirectory,
	createProductManifestCollector,
	ProductManifestCollector,
	type ProductManifestEntry,
} from "../../../src/core/evolution/product-manifest-collector.ts";

// sha256 of the exact bytes "hello world\n".
const SHA256_HELLO_WORLD = "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447";

function sha256Bytes(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function makeEntry(overrides: Partial<ProductManifestEntry> = {}): ProductManifestEntry {
	return {
		path: "dist/out.js",
		sizeBytes: 12,
		sha256: SHA256_HELLO_WORLD,
		mtimeMs: 1_700_000_000_000,
		...overrides,
	};
}

describe("ProductManifestCollector", () => {
	it("records and retrieves entries in order", () => {
		const collector = createProductManifestCollector();
		const first = makeEntry({ path: "a.txt" });
		const second = makeEntry({ path: "b.txt" });
		collector.record(first);
		collector.record(second);
		expect(collector.getManifest()).toEqual([first, second]);
	});

	it("returns a copy so callers cannot mutate internal state", () => {
		const collector = createProductManifestCollector();
		collector.record(makeEntry());
		collector.getManifest().push(makeEntry({ path: "injected" }));
		expect(collector.getManifest()).toHaveLength(1);
	});

	it("factory returns a ProductManifestCollector instance", () => {
		expect(createProductManifestCollector()).toBeInstanceOf(ProductManifestCollector);
	});
});

describe("collectFromDirectory", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-manifest-"));
		writeFileSync(join(root, "hello.txt"), "hello world\n");
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "nested.txt"), "nested\n");
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules", "dep.js"), "dep\n");
		symlinkSync(join(root, "hello.txt"), join(root, "link.txt"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("collects files recursively with correct sha256 and size", () => {
		const manifest = collectFromDirectory(root);
		const paths = manifest.map((entry) => entry.path);
		expect(paths).toEqual(["hello.txt", join("sub", "nested.txt")]);

		const hello = manifest.find((entry) => entry.path === "hello.txt");
		expect(hello?.sha256).toBe(SHA256_HELLO_WORLD);
		expect(hello?.sha256).toBe(sha256Bytes("hello world\n"));
		expect(hello?.sizeBytes).toBe(12);
		expect(typeof hello?.mtimeMs).toBe("number");

		const nested = manifest.find((entry) => entry.path === join("sub", "nested.txt"));
		expect(nested?.sha256).toBe(sha256Bytes("nested\n"));
		expect(nested?.sizeBytes).toBe(7);
	});

	it("excludes node_modules by default and never follows symlinks", () => {
		const paths = collectFromDirectory(root).map((entry) => entry.path);
		expect(paths).not.toContain(join("node_modules", "dep.js"));
		expect(paths).not.toContain("link.txt");
	});

	it("applies custom excludes", () => {
		const paths = collectFromDirectory(root, ["node_modules", "sub"]).map((entry) => entry.path);
		expect(paths).toEqual(["hello.txt"]);
	});

	it("returns entries sorted by path", () => {
		writeFileSync(join(root, "aaa.txt"), "a\n");
		const paths = collectFromDirectory(root).map((entry) => entry.path);
		expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
	});
});
