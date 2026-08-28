// TEK 唯一入口面：Unix domain socket（mode 0600）+ 每调用认证。
// 只分发 §7 契约的 6 个方法；无动态加载/反射/内省；超长载荷拒绝。
// 认证顺序（fail closed）：ipcVersion 不匹配 → 拒绝并断开；token 不匹配 → 拒绝并断开；
// id/method 非法 → invalid_request；方法不存在 → unknown_method；参数缺字段 → missing_field。

import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
	type ErrorCode,
	IPC_VERSION,
	type IpcRequest,
	type M0PolicySnapshot,
	MAX_FRAME_BYTES,
	type MethodHandler,
	type SignerLike,
	TekError,
} from "./ipc/contract.ts";
import { encodeFrame, LineBuffer } from "./ipc/protocol.ts";
import { handleGetM0Policy } from "./methods/get-m0-policy.ts";
import { handleHealth } from "./methods/health.ts";
import { handlePinTaskContract } from "./methods/pin-task-contract.ts";
import { handleSignAttestation } from "./methods/sign-attestation.ts";
import { handleVerifyAttestation } from "./methods/verify-attestation.ts";
import { handleVerifyBundle } from "./methods/verify-bundle.ts";

const HANDLERS: Record<string, MethodHandler> = {
	health: handleHealth,
	pinTaskContract: handlePinTaskContract,
	verifyBundle: handleVerifyBundle,
	signAttestation: handleSignAttestation,
	verifyAttestation: handleVerifyAttestation,
	getM0Policy: handleGetM0Policy,
};

export interface IpcServerOptions {
	socketPath: string;
	token: string;
	signer: SignerLike;
	policy: M0PolicySnapshot;
	ipcVersion?: number;
}

export class IpcServer {
	private readonly socketPath: string;
	private readonly token: string;
	private readonly signer: SignerLike;
	private readonly policy: M0PolicySnapshot;
	private readonly ipcVersion: number;
	private server: Server | undefined;

	constructor(options: IpcServerOptions) {
		this.socketPath = options.socketPath;
		this.token = options.token;
		this.signer = options.signer;
		this.policy = options.policy;
		this.ipcVersion = options.ipcVersion ?? IPC_VERSION;
	}

	async start(): Promise<void> {
		if (existsSync(this.socketPath)) {
			const stat = lstatSync(this.socketPath);
			if (!stat.isSocket()) {
				throw new Error(`socket path ${this.socketPath} exists and is not a socket (fail closed)`);
			}
			unlinkSync(this.socketPath); // 清理陈旧 socket
		}
		await new Promise<void>((resolve, reject) => {
			const server = createServer((socket) => this.handleConnection(socket));
			server.on("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				try {
					chmodSync(this.socketPath, 0o600);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				this.server = server;
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (existsSync(this.socketPath)) {
			unlinkSync(this.socketPath);
		}
	}

	private handleConnection(socket: Socket): void {
		const lines = new LineBuffer();
		let bufferedBytes = 0;
		socket.on("data", (chunk: Buffer) => {
			bufferedBytes += chunk.length;
			if (bufferedBytes > MAX_FRAME_BYTES) {
				this.sendErrorAndClose(socket, "", "invalid_request", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
				return;
			}
			for (const line of lines.push(chunk)) {
				this.handleLine(socket, line);
			}
			// 按帧计：残行清空后重置字节计数
			if (lines.pendingLength === 0) {
				bufferedBytes = 0;
			}
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}

	private handleLine(socket: Socket, line: string): void {
		if (line.trim() === "") return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			this.sendErrorAndClose(socket, "", "invalid_request", "malformed JSON frame");
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
			this.sendErrorAndClose(socket, "", "invalid_request", "frame must be a JSON object");
			return;
		}
		const req = frame as Partial<IpcRequest>;

		if (req.ipcVersion !== this.ipcVersion) {
			this.sendErrorAndClose(
				socket,
				typeof req.id === "string" ? req.id : "",
				"ipc_version_mismatch",
				`ipcVersion ${String(req.ipcVersion)} does not match ${this.ipcVersion}; refusing connection`,
			);
			return;
		}
		if (req.token !== this.token) {
			this.sendErrorAndClose(socket, typeof req.id === "string" ? req.id : "", "unauthorized", "invalid auth token");
			return;
		}
		if (typeof req.id !== "string" || req.id === "") {
			this.sendErrorAndClose(socket, "", "invalid_request", "frame requires a non-empty string id");
			return;
		}
		if (typeof req.method !== "string" || req.method === "") {
			this.sendErrorAndClose(socket, req.id, "invalid_request", "frame requires a non-empty string method");
			return;
		}

		this.dispatch(req.method, req.params)
			.then((result) => {
				if (!socket.destroyed) {
					socket.write(encodeFrame({ id: req.id, ok: true, result }));
				}
			})
			.catch((err: unknown) => {
				if (socket.destroyed) return;
				const frame =
					err instanceof TekError
						? {
								id: req.id,
								ok: false,
								error: {
									code: err.code,
									message: err.message,
									...(err.field !== undefined ? { field: err.field } : {}),
								},
							}
						: {
								id: req.id,
								ok: false,
								error: {
									code: "internal_error",
									message: err instanceof Error ? err.message : String(err),
								},
							};
				socket.write(encodeFrame(frame));
			});
	}

	private async dispatch(method: string, params: unknown): Promise<unknown> {
		const handler = HANDLERS[method];
		if (!handler) {
			throw new TekError("unknown_method", `unknown method: ${method}`);
		}
		return await handler({ signer: this.signer, policy: this.policy }, params);
	}

	private sendErrorAndClose(socket: Socket, id: string, code: ErrorCode, message: string): void {
		socket.end(encodeFrame({ id, ok: false, error: { code, message } }));
	}
}
