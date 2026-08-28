// TEK 进程入口：加载/创建 dev 凭据 → 启动窄 IPC（Unix socket 0600 + 每调用令牌认证）。
// 环境变量：
//   TEK_CREDENTIALS_DIR  凭据目录（默认 ~/.pi-tek/credentials，mode 0700）
//   TEK_SOCKET_PATH      socket 路径（默认 ~/.pi-tek/tek.sock）
//   TEK_AUTH_TOKEN       认证令牌（可注入；未注入时读/建 <credsDir>/auth.token：已存在则复用（读取前断言 mode 0600），不存在则生成写入，mode 0600）
// chain_mode 恒为 local_diagnostic（0a 冻结；D6/P2）。

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { IPC_VERSION } from "./ipc/contract.ts";
import { IpcServer } from "./ipc-server.ts";
import { CHAIN_MODE, m0PolicySnapshot } from "./policy.ts";
import { assertPrivateFile, DevSigner } from "./signer.ts";

const AUTH_TOKEN_FILE = "auth.token";

async function main(): Promise<void> {
	const credsDir = process.env.TEK_CREDENTIALS_DIR ?? join(homedir(), ".pi-tek", "credentials");
	const socketPath = process.env.TEK_SOCKET_PATH ?? join(homedir(), ".pi-tek", "tek.sock");

	const signer = DevSigner.loadOrCreate(credsDir);

	let token = process.env.TEK_AUTH_TOKEN;
	if (!token) {
		const tokenPath = join(credsDir, AUTH_TOKEN_FILE);
		if (existsSync(tokenPath)) {
			assertPrivateFile(tokenPath); // 与 signer 密钥文件同款：读取前断言 mode 0600（fail closed）
			token = readFileSync(tokenPath, "utf8"); // 复用持久化 token，支持 supervisor 重启
		} else {
			token = randomBytes(32).toString("hex");
			writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });
		}
	}

	const server = new IpcServer({ socketPath, token, signer, policy: m0PolicySnapshot() });
	await server.start();

	process.stdout.write(
		`${JSON.stringify({
			ready: true,
			socketPath,
			signerKeyId: signer.keyId,
			ipcVersion: IPC_VERSION,
			chainMode: CHAIN_MODE,
		})}\n`,
	);
	process.stderr.write(`[tek] listening on ${socketPath} (chain_mode=${CHAIN_MODE}, key_id=${signer.keyId})\n`);

	const shutdown = async (signal: string): Promise<void> => {
		process.stderr.write(`[tek] received ${signal}, shutting down\n`);
		await server.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
	process.stderr.write(`[tek] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
