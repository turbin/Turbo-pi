import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type ArtifactKind,
	type ArtifactManifest,
	type DataClass,
	type ManifestOperator,
	validateManifest,
} from "../../src/evolution/artifact-schema.ts";
import { canonicalJson, computeArtifactId, recomputeArtifactId } from "../../src/evolution/canonical.ts";

/**
 * T2 TDD 入口：canonical artifact manifest 与 content-addressed hash（A3）。
 *
 * 冻结合同（T4 kernel 独立实现须与本测试字节级一致）：
 *
 * 1. canonical JSON 序列化（canonical.ts）：
 *    - 对象键按 UTF-16 code unit 升序排序，递归；
 *    - 无任何空白、无尾换行；
 *    - 数字：有限值；-0 归一为 0；2^53 内整数写纯十进制（无指数、
 *      无 ".0"）；其余按 ECMAScript Number::toString 最短往返表示；
 *      NaN/Infinity/undefined/function/symbol/bigint 一律抛错，
 *      绝不静默丢键或输出 null；
 *    - 字符串按 JSON.stringify 转义语义（控制符 \uXXXX、\u2028/\u2029 转义）。
 * 2. artifact_id = sha256_hex( utf8(canonicalJson(manifest)) ++ utf8(canonicalJson(manifest.blob_hashes)) )，
 *    "++" 为无分隔符字节拼接；manifest 内含 blob_hashes 字段。
 * 3. manifest 不含时间戳/随机字段：created_at / artifact_id /
 *    canonical_manifest 是存储元数据，不是 manifest 字段（校验器拒绝）。
 */

function validManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
	return {
		kind: "experience_snapshot",
		parent_ids: [],
		operator: "draft",
		scope: ["packages/experience/"],
		evidence_refs: ["doc/design/2026-08-28-self-evolving-phase0a-architecture.md"],
		scaffold_hash: "a".repeat(64),
		model_fingerprint: JSON.stringify({ model: "mock", sampling: { temperature: 0 } }),
		data_class: "diagnostic_ops",
		retention_policy_ref: "pending_0b",
		blob_hashes: ["b".repeat(64), "c".repeat(64)],
		...overrides,
	};
}

describe("canonicalJson（冻结序列化）", () => {
	it("递归排序对象键且不输出空白", () => {
		expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
		expect(canonicalJson({ z: null, m: [3, 1, 2], a: "s" })).toBe('{"a":"s","m":[3,1,2],"z":null}');
	});

	it("序列化字节级稳定：两次序列化相同、parse 后重序列化相同", () => {
		const value = { b: 2, a: { c: [1, 2, "x"], d: null }, e: true };
		const text1 = canonicalJson(value);
		const text2 = canonicalJson(value);
		expect(text2).toBe(text1);
		expect(canonicalJson(JSON.parse(text1) as unknown)).toBe(text1);
	});

	it("安全整数序列化不丢精度（cost_micros 等整数字段）", () => {
		const text = canonicalJson({ cost_micros: 9_007_199_254_740_991 });
		expect(text).toBe('{"cost_micros":9007199254740991}');
		expect(JSON.parse(text)).toEqual({ cost_micros: 9_007_199_254_740_991 });
	});

	it("归一 -0 与尾零浮点", () => {
		expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
		expect(canonicalJson({ a: 1.0 })).toBe('{"a":1}');
	});

	it("非有限数与不可序列化值抛错，绝不静默降级", () => {
		expect(() => canonicalJson({ x: Number.NaN })).toThrow();
		expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow();
		expect(() => canonicalJson({ x: undefined })).toThrow();
		expect(() => canonicalJson([undefined])).toThrow();
		expect(() => canonicalJson({ x: () => 1 })).toThrow();
		expect(() => canonicalJson({ x: 1n })).toThrow();
	});
});

describe("validateManifest（fail closed 字段校验）", () => {
	it("接受合法 manifest", () => {
		const result = validateManifest(validManifest());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest.scaffold_hash).toBe("a".repeat(64));
		}
	});

	it("缺任一必填字段返回字段级错误", () => {
		const fields = [
			"kind",
			"parent_ids",
			"operator",
			"scope",
			"evidence_refs",
			"scaffold_hash",
			"model_fingerprint",
			"data_class",
			"retention_policy_ref",
			"blob_hashes",
		] as const;
		for (const field of fields) {
			const { [field]: _removed, ...rest } = validManifest();
			const result = validateManifest(rest);
			expect(result.ok, `field ${field}`).toBe(false);
			if (!result.ok) {
				expect(result.errors.join(" "), `field ${field}`).toContain(`manifest.${field}`);
			}
		}
	});

	it("拒绝未知字段（时间戳、随机字段、派生 id 均非 manifest 字段）", () => {
		const extras = [
			{ created_at: 1_752_000_000_000 },
			{ timestamp: 1 },
			{ artifact_id: "x".repeat(64) },
			{ canonical_manifest: "{}" },
			{ randomField: true },
		];
		for (const extra of extras) {
			const result = validateManifest({ ...validManifest(), ...extra });
			expect(result.ok, JSON.stringify(extra)).toBe(false);
			if (!result.ok) {
				expect(result.errors.join(" "), JSON.stringify(extra)).toContain("unknown field");
			}
		}
	});

	it("拒绝非法枚举、坏哈希、空 scope、空 blob_hashes、非 JSON model_fingerprint", () => {
		const bad = validManifest({
			kind: "bogus" as ArtifactKind,
			operator: "evil" as ManifestOperator,
			data_class: "nope" as DataClass,
			scaffold_hash: "xyz",
			blob_hashes: ["not-a-sha"],
		});
		const result = validateManifest(bad);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const all = result.errors.join(" ");
			expect(all).toContain("manifest.kind");
			expect(all).toContain("manifest.operator");
			expect(all).toContain("manifest.data_class");
			expect(all).toContain("manifest.scaffold_hash");
			expect(all).toContain("manifest.blob_hashes");
		}

		const emptyScope = validateManifest(validManifest({ scope: [] }));
		expect(emptyScope.ok).toBe(false);
		const emptyBlobs = validateManifest(validManifest({ blob_hashes: [] }));
		expect(emptyBlobs.ok).toBe(false);
		const badFingerprint = validateManifest(validManifest({ model_fingerprint: "not json" }));
		expect(badFingerprint.ok).toBe(false);
	});

	it("拒绝非对象输入", () => {
		for (const input of ["str", 42, null, [], true] as const) {
			const result = validateManifest(input);
			expect(result.ok, JSON.stringify(input)).toBe(false);
		}
	});
});

describe("artifact_id（A3 content-addressed hash）", () => {
	it("同内容同 artifact_id，且与输入键顺序无关", () => {
		const manifest = validManifest();
		expect(computeArtifactId(manifest)).toBe(computeArtifactId(validManifest()));
		const shuffled = Object.fromEntries(Object.entries(manifest).reverse()) as unknown as ArtifactManifest;
		expect(computeArtifactId(shuffled)).toBe(computeArtifactId(manifest));
	});

	it("任一语义字段变化 hash 必变", () => {
		const base = computeArtifactId(validManifest());
		const variants: Array<[string, ArtifactManifest]> = [
			["scope", validManifest({ scope: ["other/path/"] })],
			["model_fingerprint", validManifest({ model_fingerprint: JSON.stringify({ model: "other" }) })],
			["scaffold_hash", validManifest({ scaffold_hash: "d".repeat(64) })],
			["kind", validManifest({ kind: "scaffold_config" })],
			["operator", validManifest({ operator: "improve" })],
			["data_class", validManifest({ data_class: "aggregate_only" })],
			["evidence_refs", validManifest({ evidence_refs: ["other-ref"] })],
			["retention_policy_ref", validManifest({ retention_policy_ref: "other-policy" })],
			["parent_ids", validManifest({ parent_ids: ["parent-1"] })],
		];
		for (const [label, variant] of variants) {
			expect(computeArtifactId(variant), label).not.toBe(base);
		}
	});

	it("任一 blob 哈希变化 hash 必变", () => {
		const base = validManifest();
		const id = computeArtifactId(base);
		for (let i = 0; i < base.blob_hashes.length; i++) {
			const blobHashes = [...base.blob_hashes];
			blobHashes[i] = "f".repeat(64);
			expect(computeArtifactId(validManifest({ blob_hashes: blobHashes })), `blob index ${i}`).not.toBe(id);
		}
	});

	it("锁定字节合同：sha256(canonical_manifest ++ blob_hashes)，无分隔符", () => {
		const manifest = validManifest();
		const manifestText = canonicalJson(manifest);
		const blobHashesText = canonicalJson(manifest.blob_hashes);
		const expected = createHash("sha256")
			.update(manifestText + blobHashesText, "utf8")
			.digest("hex");
		expect(computeArtifactId(manifest)).toBe(expected);
	});

	it("manifest 序列化稳定：键排序、无空白、不含时间戳/随机字段", () => {
		const text = canonicalJson(validManifest());
		expect(text).toMatch(/^\{/);
		expect(text).not.toContain(" ");
		expect(text).not.toContain("\n");
		expect(text).not.toContain("created_at");
		expect(text).not.toContain("timestamp");
		expect(text).not.toContain("artifact_id");
		const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
		expect(keys).toEqual([...keys].sort());
	});

	it("recomputeArtifactId 从存储文本重建同一 ID（全链可重建锚点）", () => {
		const manifest = validManifest();
		const canonicalText = canonicalJson(manifest);
		const blobText = canonicalJson(manifest.blob_hashes);
		expect(recomputeArtifactId(canonicalText, blobText)).toBe(computeArtifactId(manifest));
	});

	it("recomputeArtifactId 对非 canonical 存储文本 fail closed（抛错）", () => {
		const manifest = validManifest();
		const pretty = JSON.stringify(manifest, null, 2);
		expect(() => recomputeArtifactId(pretty, canonicalJson(manifest.blob_hashes))).toThrow();
		expect(() =>
			recomputeArtifactId(canonicalJson(manifest), JSON.stringify(manifest.blob_hashes, null, 2)),
		).toThrow();
		expect(() => recomputeArtifactId("not json", "[]")).toThrow();
	});
});
