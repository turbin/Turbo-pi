import { describe, expect, it } from "vitest";
import {
	DEFAULT_VERSION_CONTRACT,
	loadVersionContract,
	type VersionContract,
} from "../../../src/core/evolution/version-contract.ts";

const VALID_ARTIFACT_ID = "0".repeat(64);
const VALID_SCAFFOLD_HASH = "a".repeat(64);
const VALID_SNAPSHOT_SHA = "f".repeat(64);

describe("loadVersionContract", () => {
	it("returns the default contract when all env vars are missing", () => {
		const contract = loadVersionContract({});
		expect(contract).toEqual(DEFAULT_VERSION_CONTRACT);
		expect(contract.artifactId).toBe("pending_0b");
		expect(contract.scaffoldHash).toBe("pending_0b");
		expect(contract.snapshotSha).toBe("pending_0b");
	});

	it("returns a parsed contract when all env vars are present and valid", () => {
		const source: Record<string, string | undefined> = {
			PI_GEN0_ARTIFACT_ID: VALID_ARTIFACT_ID,
			PI_GEN0_SCAFFOLD_HASH: VALID_SCAFFOLD_HASH,
			PI_GEN0_SNAPSHOT_SHA: VALID_SNAPSHOT_SHA,
		};
		const contract = loadVersionContract(source);
		expect(contract).toEqual({
			artifactId: VALID_ARTIFACT_ID,
			scaffoldHash: VALID_SCAFFOLD_HASH,
			snapshotSha: VALID_SNAPSHOT_SHA,
		});
	});

	it("uses provided env vars and defaults the missing ones", () => {
		const source: Record<string, string | undefined> = {
			PI_GEN0_ARTIFACT_ID: VALID_ARTIFACT_ID,
		};
		const contract = loadVersionContract(source);
		expect(contract).toEqual({
			artifactId: VALID_ARTIFACT_ID,
			scaffoldHash: "pending_0b",
			snapshotSha: "pending_0b",
		});
	});

	it("rejects an empty artifactId", () => {
		expect(() =>
			loadVersionContract({
				PI_GEN0_ARTIFACT_ID: "",
				PI_GEN0_SCAFFOLD_HASH: VALID_SCAFFOLD_HASH,
				PI_GEN0_SNAPSHOT_SHA: VALID_SNAPSHOT_SHA,
			}),
		).toThrow("PI_GEN0_ARTIFACT_ID must be a non-empty string");
	});

	it("rejects an empty scaffoldHash", () => {
		expect(() =>
			loadVersionContract({
				PI_GEN0_ARTIFACT_ID: VALID_ARTIFACT_ID,
				PI_GEN0_SCAFFOLD_HASH: "",
				PI_GEN0_SNAPSHOT_SHA: VALID_SNAPSHOT_SHA,
			}),
		).toThrow("PI_GEN0_SCAFFOLD_HASH must be a non-empty string");
	});

	it("rejects an empty snapshotSha", () => {
		expect(() =>
			loadVersionContract({
				PI_GEN0_ARTIFACT_ID: VALID_ARTIFACT_ID,
				PI_GEN0_SCAFFOLD_HASH: VALID_SCAFFOLD_HASH,
				PI_GEN0_SNAPSHOT_SHA: "",
			}),
		).toThrow("PI_GEN0_SNAPSHOT_SHA must be a non-empty string");
	});

	it("rejects non-string values", () => {
		const source = {
			PI_GEN0_ARTIFACT_ID: 123 as unknown as string,
			PI_GEN0_SCAFFOLD_HASH: VALID_SCAFFOLD_HASH,
			PI_GEN0_SNAPSHOT_SHA: VALID_SNAPSHOT_SHA,
		};
		expect(() => loadVersionContract(source as Record<string, string | undefined>)).toThrow(
			"PI_GEN0_ARTIFACT_ID must be a non-empty string",
		);
	});
});

describe("DEFAULT_VERSION_CONTRACT", () => {
	it("is a frozen contract with pending values", () => {
		expect(DEFAULT_VERSION_CONTRACT).toEqual({
			artifactId: "pending_0b",
			scaffoldHash: "pending_0b",
			snapshotSha: "pending_0b",
		});
		expect(Object.isFrozen(DEFAULT_VERSION_CONTRACT)).toBe(true);
	});
});

describe("VersionContract type", () => {
	it("accepts a valid contract object", () => {
		const contract: VersionContract = {
			artifactId: VALID_ARTIFACT_ID,
			scaffoldHash: VALID_SCAFFOLD_HASH,
			snapshotSha: VALID_SNAPSHOT_SHA,
		};
		expect(contract.artifactId).toHaveLength(64);
		expect(contract.scaffoldHash).toHaveLength(64);
		expect(contract.snapshotSha).toHaveLength(64);
	});
});
