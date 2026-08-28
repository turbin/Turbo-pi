import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.ts";

/**
 * T5: audit writer — independent dev signing key for deployment events.
 *
 * Uses Ed25519 dev keys with key_id prefix `dev-audit-`. The audit writer is
 * separate from the TEK evaluation signer (architecture §3.1): different key,
 * different role, different directory.
 */

export const DEV_AUDIT_KEY_PREFIX = "dev-audit-";
export const AUDIT_KEY_FILE = "audit-writer.key";
export const AUDIT_PUB_FILE = "audit-writer.pub";

function assertPrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const mode = statSync(dir).mode & 0o777;
	if (mode !== 0o700) {
		throw new Error(`credentials dir ${dir} must be mode 0700, found ${mode.toString(8)} (fail closed)`);
	}
}

function assertPrivateFile(file: string): void {
	const mode = statSync(file).mode & 0o777;
	if (mode !== 0o600) {
		throw new Error(`credentials file ${file} must be mode 0600, found ${mode.toString(8)} (fail closed)`);
	}
}

export class DevAuditWriter {
	readonly keyId: string;
	private readonly privateKey: KeyObject;
	private readonly registry: Map<string, KeyObject>;

	private constructor(privateKey: KeyObject, publicKey: KeyObject) {
		this.privateKey = privateKey;
		this.keyId =
			DEV_AUDIT_KEY_PREFIX + sha256Hex(publicKey.export({ type: "spki", format: "pem" }).toString()).slice(0, 32);
		this.registry = new Map([[this.keyId, publicKey]]);
	}

	static loadOrCreate(credsDir: string): DevAuditWriter {
		assertPrivateDir(credsDir);
		const keyPath = join(credsDir, AUDIT_KEY_FILE);
		const pubPath = join(credsDir, AUDIT_PUB_FILE);

		if (!existsSync(keyPath)) {
			const { privateKey, publicKey } = generateKeyPairSync("ed25519");
			writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
			writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600, flag: "wx" });
		}
		assertPrivateFile(keyPath);
		assertPrivateFile(pubPath);

		const privateKey = createPrivateKey(readFileSync(keyPath));
		const publicKey = verifyKeyMatchesPublic(privateKey, readFileSync(pubPath));
		return new DevAuditWriter(privateKey, publicKey);
	}

	/** Sign a canonical payload; return base64 signature + key_id. */
	signString(payload: string): { signature: string; keyId: string } {
		const signature = sign(null, Buffer.from(payload, "utf8"), this.privateKey).toString("base64");
		return { signature, keyId: this.keyId };
	}

	verifyString(payload: string, signature: string, keyId: string): boolean {
		const publicKey = this.registry.get(keyId);
		if (!publicKey) return false;
		try {
			return verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64"));
		} catch {
			return false;
		}
	}
}

function verifyKeyMatchesPublic(privateKey: KeyObject, publicPem: Buffer): KeyObject {
	const publicKey = createPublicKey(publicPem);
	const probe = sign(null, Buffer.from("audit-keypair-probe"), privateKey);
	if (!verify(null, Buffer.from("audit-keypair-probe"), publicKey, probe)) {
		throw new Error("credentials private/public key mismatch (fail closed)");
	}
	return publicKey;
}
