import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import Fastify, { type FastifyInstance } from "fastify";
import { ExperienceStore } from "./experience-store.ts";
import { handleStream } from "./proxy-handler.ts";
import type { StreamRequest } from "./types.ts";

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

	// OpenAI-compatible alias for clients that only speak /v1/chat/completions.
	// Internally it reuses the same proxy pipeline; non-streaming responses
	// collect the SSE events and return a single chat.completion JSON body.
	fastify.post("/v1/chat/completions", async (request, reply) => {
		const body = request.body as Record<string, unknown>;
		const fs = await import("node:fs/promises");
		await fs.writeFile("/tmp/agent-server-request.json", JSON.stringify(body, null, 2));
		const model = {
			id: String(body.model ?? "agent-auto"),
			name: String(body.model ?? "agent-auto"),
			api: "openai-completions" as const,
			provider: "local" as const,
			baseUrl: process.env.GATEWAY_URL ?? "http://127.0.0.1:8367/v1",
			reasoning: false,
			input: [],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		};
		// Normalize message content: Kimi Code sends content as text-part arrays;
		// the gateway expects plain strings for user/assistant messages.
		const rawMessages = (body.messages ?? []) as any[];
		const messages = rawMessages.map((msg) => {
			if (Array.isArray(msg.content)) {
				return {
					...msg,
					content: msg.content
						.map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
						.join(""),
				};
			}
			return msg;
		});
		// Normalize tools: Kimi Code sends OpenAI-style {type, function:{...}};
		// toOpenAIRequest expects pi-ai style {name, description, parameters}.
		const rawTools = (body.tools ?? []) as any[];
		const tools = rawTools.map((t) => {
			if (t.function) {
				return {
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters,
				};
			}
			return t;
		});
		const context = {
			systemPrompt: undefined,
			messages,
			tools,
		};
		const options = {
			temperature: typeof body.temperature === "number" ? body.temperature : undefined,
			maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
		};
		const sessionPath = join(sessionDir, `${Date.now()}-${randomUUID()}.jsonl`);
		try {
			if (body.stream === true) {
				// OpenAI-compatible clients expect raw OpenAI SSE, not pi-ai events.
				// Do retrieval/injection manually, then forward to gateway.
				const { retrieve } = await import("./retrieval.ts");
				const { buildInjection } = await import("./injection.ts");
				const { toOpenAIRequest } = await import("./openai-compat.ts");
				const { GatewayClient } = await import("./gateway-client.ts");
				const query = messages
					.filter((m: any) => m.role === "user")
					.map((m: any) => String(m.content))
					.filter((content: string) => !content.startsWith("<system-reminder>"))
					.pop() ?? "";
				console.log("[agent-server] stream query:", query);
				const retrieved = await retrieve(store, query, 8);
				console.log("[agent-server] stream retrieved:", retrieved.map((r) => r.experience.id));
				const injected = await buildInjection(context as any, retrieved);
				const openaiReq = toOpenAIRequest(injected, model as any);
				const gateway = new GatewayClient(gatewayUrl);
				const gatewayStream = await gateway.stream({ ...openaiReq, stream: true });
				reply.header("content-type", "text/event-stream");
				return reply.send(Readable.fromWeb(gatewayStream as unknown as NodeReadableStream<Uint8Array>));
			}

			const stream = await handleStream(
				{ model, context, options },
				{ store, gatewayUrl, sessionPath },
			);
			const reader = stream.getReader();
			const chunks: string[] = [];
			let done: Record<string, unknown> | null = null;
			while (true) {
				const { value, done: isDone } = await reader.read();
				if (isDone) break;
				const text = new TextDecoder().decode(value);
				for (const line of text.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (!payload) continue;
					const event = JSON.parse(payload) as Record<string, unknown>;
					if (event.type === "text_delta") {
						chunks.push(String(event.delta ?? ""));
					} else if (event.type === "done") {
						done = event;
					} else if (event.type === "error") {
						return reply.code(502).send({ error: { message: String(event.errorMessage ?? "unknown") } });
					}
				}
			}
			const content = chunks.join("");
			const message: Record<string, unknown> = { role: "assistant", content };
			return reply.send({
				id: `chatcmpl-${randomUUID()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: model.id,
				choices: [
					{
						index: 0,
						message,
						finish_reason: done?.reason ?? "stop",
					},
				],
				usage: done?.usage ?? {},
			});
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
