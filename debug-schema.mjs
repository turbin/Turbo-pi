import Database from "better-sqlite3";

const db = new Database(":memory:");
db.exec(`
CREATE TABLE artifact_immutable_manifests (
  artifact_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  parent_ids TEXT NOT NULL DEFAULT '[]',
  operator TEXT NOT NULL,
  scope TEXT NOT NULL,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  scaffold_hash TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  data_class TEXT NOT NULL,
  retention_policy_ref TEXT NOT NULL,
  blob_hashes TEXT NOT NULL,
  canonical_manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE evaluation_attestations (
  attestation_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact_immutable_manifests(artifact_id),
  contract_id TEXT NOT NULL,
  baseline_artifact_id TEXT REFERENCES evaluation_attestations(attestation_id),
  task_manifest_sha TEXT NOT NULL,
  grader_sha TEXT NOT NULL,
  workspace_tree_sha TEXT NOT NULL,
  environment_fingerprint TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  sampling_contract TEXT NOT NULL,
  metrics_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','reject','quarantine','inconclusive')),
  real_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  trace_ref TEXT NOT NULL,
  failure_classification TEXT NOT NULL,
  signer_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  attested_at INTEGER NOT NULL
);
`);

const suffix = "enum-evaluation_attestations-verdict";

// seedParents: artifact
db.prepare(`INSERT INTO artifact_immutable_manifests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(`artifact-1-${suffix}`, "composite", "[]", "draft", "[]", "[]", "sha-scaffold", "{}", "diagnostic_ops", "pending_0b", "[]", "{}", 1785000000000);

// seedParents: attestation
db.prepare(`INSERT INTO evaluation_attestations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(`att-1-${suffix}`, `artifact-1-${suffix}`, "contract-1", null, "sha-task", "sha-grader", "sha-tree", "sha-env", "provider/model-1", "{}", "sha-metrics", "pass", 1000, 5000, "trace-1", "none", "dev-key-1", "sig-att", 1785000000001);

// invalid verdict
try {
  db.prepare(`INSERT INTO evaluation_attestations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`att-2-${suffix}`, `artifact-1-${suffix}`, "contract-1", null, "sha-task", "sha-grader", "sha-tree", "sha-env", "provider/model-1", "{}", "sha-metrics", "revoked", 1000, 5000, "trace-1", "none", "dev-key-1", "sig-att", 1785000000002);
  console.log("NO ERROR");
} catch (e) {
  console.log("ERROR:", e.message, e.code);
}
