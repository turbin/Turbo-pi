export {
	CANDIDATE_ABI_VERSION,
	CANDIDATE_CAPABILITIES,
	type CandidateCapability,
	type CandidateExtensionManifest,
	type CandidateManifestValidation,
	type CandidateProvenance,
	type DeclarativePolicies,
	type ReplacementPolicy,
	type ToolPromptPolicy,
	validateCandidateManifest,
} from "./manifest.ts";
export {
	buildSourcePatchArtifact,
	type SourcePatchArtifact,
	type SourcePatchArtifactInput,
	type StoredSourcePatchArtifact,
	storeSourcePatchArtifact,
} from "./source-patch-builder.ts";
export type { CandidateTransform, TransformContext } from "./transform.ts";
export {
	DEFAULT_CANDIDATE_PATH_WHITELIST,
	type PathValidation,
	validateCandidatePath,
	validateCandidatePaths,
} from "./whitelist.ts";
