import type { M0PolicySnapshot, MethodContext } from "../ipc/contract.ts";

export async function handleGetM0Policy(ctx: MethodContext, _params: unknown): Promise<M0PolicySnapshot> {
	return ctx.policy;
}
