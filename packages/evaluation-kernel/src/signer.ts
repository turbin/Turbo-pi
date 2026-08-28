// evaluation signer：Ed25519 开发密钥（key_id 前缀 `dev-`），凭据目录布局：
//   <credsDir>/              mode 0700（组/其他无任何权限，否则 fail closed）
//   <credsDir>/evaluation-signer.key   PKCS8 PEM，mode 0600
//   <credsDir>/evaluation-signer.pub   SPKI PEM，mode 0600
// key_id = "dev-" + sha256hex(public SPKI PEM)[0:32]
// 本实现为 0a 最小认证主体：密钥注册表只含本地密钥；mTLS 仅留接口不实现（架构 §3.2）。

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "./canonical.ts";
import type { KeyId, Signature } from "./ipc/contract.ts";

export const DEV_KEY_PREFIX = "dev-";
export const SIGNER_KEY_FILE = "evaluation-signer.key";
export const SIGNER_PUB_FILE = "evaluation-signer.pub";

function assertPrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const mode = statSync(dir).mode & 0o777;
	if (mode !== 0o700) {
		throw new Error(`credentials dir ${dir} must be mode 0700, found ${mode.toString(8)} (fail closed)`);
	}
}

export function assertPrivateFile(file: string): void {
	const mode = statSync(file).mode & 0o777;
	if (mode !== 0o600) {
		throw new Error(`credentials file ${file} must be mode 0600, found ${mode.toString(8)} (fail closed)`);
	}
}

export class DevSigner {
	readonly keyId: KeyId;
	private readonly privateKey: KeyObject;
	private readonly registry: Map<KeyId, KeyObject>;

	private constructor(privateKey: KeyObject, publicKey: KeyObject) {
		this.privateKey = privateKey;
		this.keyId = DEV_KEY_PREFIX + sha256Hex(publicKey.export({ type: "spki", format: "pem" })).slice(0, 32);
		this.registry = new Map([[this.keyId, publicKey]]);
	}

	static loadOrCreate(credsDir: string): DevSigner {
		assertPrivateDir(credsDir);
		const keyPath = join(credsDir, SIGNER_KEY_FILE);
		const pubPath = join(credsDir, SIGNER_PUB_FILE);

		if (!existsSync(keyPath)) {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
			writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600, flag: "wx" });
		}
		assertPrivateFile(keyPath);
		assertPrivateFile(pubPath);

		const privateKey = createPrivateKey(readFileSync(keyPath));
		const publicKey = verifyKeyMatchesPublic(privateKey, readFileSync(pubPath));
		return new DevSigner(privateKey, publicKey);
	}

	/** 对 canonical payload 字节签名；返回 base64 签名。 */
	signString(payload: string): { signature: Signature; keyId: KeyId } {
		const signature = sign(null, Buffer.from(payload, "utf8"), this.privateKey).toString("base64");
		return { signature, keyId: this.keyId };
	}

	/** 验签；keyId 不在注册表 → false（调用方按 unknown_key 处理）。 */
	verifyString(payload: string, signature: Signature, keyId: KeyId): boolean {
		const publicKey = this.registry.get(keyId);
		if (!publicKey) return false;
		try {
			return verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64"));
		} catch {
			return false; // 非 base64 等畸形签名一律拒绝
		}
	}

	hasKey(keyId: KeyId): boolean {
		return this.registry.has(keyId);
	}
}

function verifyKeyMatchesPublic(privateKey: KeyObject, publicPem: Buffer): KeyObject {
	const publicKey = createPublicKey(publicPem);
	// 防御性检查：私钥与公钥必须属于同一对，否则拒绝启动（fail closed）。
	const probe = sign(null, Buffer.from("tek-keypair-probe"), privateKey);
	if (!verify(null, Buffer.from("tek-keypair-probe"), publicKey, probe)) {
		throw new Error("credentials private/public key mismatch (fail closed)");
	}
	return publicKey;
}
