import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import Fastify, { type FastifyInstance } from "fastify";
import { ExperienceStore } from "./experience-store.js";
import { handleStream } from "./proxy-handler.js";
import type { StreamRequest } from "./types.js";

export interface CreateServerOptions {
	store?: ExperienceStore;
	gatewayUrl?: string;
	sessionDir?: string;
}

/**
 * Fastify server exposing `POST /api/stream` (SPEC §4.1). Dependencies are
 * injectable for tests; by default they come from env vars
 * (EXPERIENCE_STORE_PATH, GATEWAY_URL, AGENT_SERVER_SESSION_DIR).
 */
export function createServer(opts: CreateServerOptions = {}): FastifyInstance {
	const fastify = Fastify({ logger: false });
	const gatewayUrl = opts.gatewayUrl ?? process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";
	const sessionDir = opts.sessionDir ?? process.env.AGENT_SERVER_SESSION_DIR ?? "./var/sessions";

	let store = opts.store;
	if (!store) {
		const storePath = process.env.EXPERIENCE_STORE_PATH ?? "./var/experience.db";
		mkdirSync(dirname(storePath), { recursive: true });
		store = new ExperienceStore(storePath);
		// better-sqlite3 is synchronous internally, so the schema exists before
		// any request is served even though initSchema is typed async.
		void store.initSchema();
	}

	fastify.post("/api/stream", async (request, reply) => {
		const body = request.body as StreamRequest;
		const sessionPath = join(sessionDir, `${Date.now()}-${randomUUID()}.jsonl`);
		try {
			const stream = await handleStream(body, { store, gatewayUrl, sessionPath });
			reply.header("content-type", "text/event-stream");
			return reply.send(Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return reply.code(502).send({ error: { message } });
		}
	});

	return fastify;
}

export async function startServer(port = 8788): Promise<void> {
	const server = createServer();
	await server.listen({ port, host: "127.0.0.1" });
	console.log(`agent-server listening on 127.0.0.1:${port}`);
}
