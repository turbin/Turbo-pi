// TEK IPC 客户端（kernel 内实现，供测试与 kernel 内部使用）。
// 每次调用独立连接 + 独立认证（架构 §3.2：无长会话状态）。
// agent-server 等外部调用方不得 import 本模块（T8 静态扫描），须按契约自行实现客户端。

import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
	type BundleVerification,
	IPC_VERSION,
	type IpcResponse,
	type M0PolicySnapshot,
	type PinTaskContractRequest,
	type SignAttestationRequest,
	type SignedAttestation,
	type SignedTaskContract,
	TekError,
	type TekHealth,
	type VerificationResult,
	type VerifyAttestationRequest,
	type VerifyBundleRequest,
} from "./contract.ts";
import { encodeFrame } from "./protocol.ts";

export type { ErrorCode } from "./contract.ts";
export { TekError } from "./contract.ts";

export interface TekClientOptions {
	socketPath: string;
	token: string;
	ipcVersion?: number;
	timeoutMs?: number;
}

export class TekClient {
	private readonly socketPath: string;
	private readonly token: string;
	private readonly ipcVersion: number;
	private readonly timeoutMs: number;

	constructor(options: TekClientOptions) {
		this.socketPath = options.socketPath;
		this.token = options.token;
		this.ipcVersion = options.ipcVersion ?? IPC_VERSION;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	async request(method: string, params: unknown): Promise<unknown> {
		return this.requestRaw(method, params);
	}

	async health(): Promise<TekHealth> {
		return (await this.requestRaw("health", {})) as TekHealth;
	}

	async pinTaskContract(req: PinTaskContractRequest): Promise<SignedTaskContract> {
		return (await this.requestRaw("pinTaskContract", req)) as SignedTaskContract;
	}

	async verifyBundle(req: VerifyBundleRequest): Promise<BundleVerification> {
		return (await this.requestRaw("verifyBundle", req)) as BundleVerification;
	}

	async signAttestation(req: SignAttestationRequest): Promise<SignedAttestation> {
		return (await this.requestRaw("signAttestation", req)) as SignedAttestation;
	}

	async verifyAttestation(req: VerifyAttestationRequest): Promise<VerificationResult> {
		return (await this.requestRaw("verifyAttestation", req)) as VerificationResult;
	}

	async getM0Policy(): Promise<M0PolicySnapshot> {
		return (await this.requestRaw("getM0Policy", {})) as M0PolicySnapshot;
	}

	private requestRaw(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const socket: Socket = createConnection(this.socketPath);
			let buffer = "";
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(new TekError("internal_error", `request '${method}' timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);

			socket.setEncoding("utf8");
			socket.on("connect", () => {
				socket.write(
					encodeFrame({ ipcVersion: this.ipcVersion, token: this.token, id: randomUUID(), method, params }),
				);
			});
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.end();
				let response: unknown;
				try {
					response = JSON.parse(buffer.slice(0, newline));
				} catch {
					reject(new TekError("internal_error", "malformed response from TEK"));
					return;
				}
				const frame = response as Partial<IpcResponse>;
				if (frame.ok === true && "result" in frame) {
					resolve(frame.result);
				} else if (frame.ok === false && frame.error !== undefined) {
					reject(new TekError(frame.error.code, frame.error.message, frame.error.field));
				} else {
					reject(new TekError("internal_error", "malformed response frame from TEK"));
				}
			});
			socket.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new TekError("internal_error", `TEK connection error: ${err.message}`));
			});
			socket.on("close", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new TekError("internal_error", "TEK closed the connection without a response"));
			});
		});
	}
}
