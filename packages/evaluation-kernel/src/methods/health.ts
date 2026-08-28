import { IPC_VERSION, type MethodContext, type TekHealth } from "../ipc/contract.ts";
import { CHAIN_MODE } from "../policy.ts";

export async function handleHealth(ctx: MethodContext, _params: unknown): Promise<TekHealth> {
	return {
		status: "ok",
		ipcVersion: IPC_VERSION,
		signerKeyId: ctx.signer.keyId,
		chainMode: CHAIN_MODE,
	};
}
