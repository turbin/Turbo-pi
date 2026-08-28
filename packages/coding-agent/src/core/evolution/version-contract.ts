/**
 * Gen0 version contract.
 *
 * Carries the identity of the scaffold artifact, the scaffold hash, and the
 * snapshot SHA that produced the running agent. The contract is dependency-free
 * and reads from environment variables or an explicit source record.
 */

export interface VersionContract {
	/** 64-char lowercase sha256 hex identifying the gen0 artifact. */
	artifactId: string;
	/** 64-char lowercase sha256 hex identifying the scaffold. */
	scaffoldHash: string;
	/** 64-char lowercase sha256 hex identifying the source snapshot. */
	snapshotSha: string;
}

const PENDING_VALUE = "pending_0b";

export const DEFAULT_VERSION_CONTRACT: VersionContract = Object.freeze({
	artifactId: PENDING_VALUE,
	scaffoldHash: PENDING_VALUE,
	snapshotSha: PENDING_VALUE,
});

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function readContractField(source: Record<string, string | undefined>, key: string): string {
	const value = source[key];
	if (!isNonEmptyString(value)) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

/**
 * Loads the gen0 version contract from environment variables or an explicit
 * source record. Missing values fall back to the pending placeholder.
 *
 * Reads:
 *   - PI_GEN0_ARTIFACT_ID
 *   - PI_GEN0_SCAFFOLD_HASH
 *   - PI_GEN0_SNAPSHOT_SHA
 *
 * @throws Error if any provided value is not a non-empty string.
 */
export function loadVersionContract(
	source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): VersionContract {
	return {
		artifactId:
			source.PI_GEN0_ARTIFACT_ID !== undefined
				? readContractField(source, "PI_GEN0_ARTIFACT_ID")
				: DEFAULT_VERSION_CONTRACT.artifactId,
		scaffoldHash:
			source.PI_GEN0_SCAFFOLD_HASH !== undefined
				? readContractField(source, "PI_GEN0_SCAFFOLD_HASH")
				: DEFAULT_VERSION_CONTRACT.scaffoldHash,
		snapshotSha:
			source.PI_GEN0_SNAPSHOT_SHA !== undefined
				? readContractField(source, "PI_GEN0_SNAPSHOT_SHA")
				: DEFAULT_VERSION_CONTRACT.snapshotSha,
	};
}
