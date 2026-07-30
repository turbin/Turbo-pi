import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Model } from "@earendil-works/pi-ai";
import Fastify, { type FastifyInstance } from "fastify";
import { ExperienceStore } from "./experience-store.ts";
import { GatewayClient } from "./gateway-client.ts";
import { buildInjection } from "./injection.ts";
import { kindsOf, logTrace, summarizeKinds, titlesOf } from "./observability.ts";
import { toOpenAIRequest } from "./openai-compat.ts";
import { handleStream } from "./proxy-handler.ts";
import { retrieve } from "./retrieval.ts";
import { buildAssistantMessageFromOpenAI, type OpenAIChatChunk, SessionWriter } from "./session-writer.ts";
import { STATS_PAGE_HTML } from "./stats-page.ts";
import {
	type AccumulatedToolCall,
	type ToolCallValidationReport,
	validateAccumulatedToolCalls,
} from "./toolcall-validator.ts";
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

	// -- offline evolution status (SPEC B3: expose last checkpoint to monitoring) --
	fastify.get("/api/evolution/status", async (_request, reply) => {
		const latest = await store.getLatestCheckpoint("evolution");
		if (!latest) {
			return reply.code(404).send({ status: "never_run" });
		}
		let snapshot: unknown;
		try {
			snapshot = JSON.parse(latest.snapshot);
		} catch {
			snapshot = latest.snapshot;
		}
		return reply.send({
			status: "found",
			id: latest.id,
			epoch: new Date(latest.epoch).toISOString(),
			metric: latest.metric,
			snapshot,
		});
	});

	// -- O spec R2: hit-rate stats API + page -------------------------------
	fastify.get("/api/stats/hit-rate", async (request, reply) => {
		const query = request.query as { window_hours?: string };
		const windowHours = Number(query.window_hours) > 0 ? Number(query.window_hours) : 24;
		return reply.send(await store.getHitRateStats(windowHours));
	});

	fastify.get("/stats", async (_request, reply) => {
		return reply.header("content-type", "text/html; charset=utf-8").send(STATS_PAGE_HTML);
	});

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
		// O spec R4: request id ties logs, trace rows, session, and response header.
		const requestId = String(request.id);
		const startedAt = Date.now();
		reply.header("x-request-id", requestId);
		// Opt-in request dump for debugging; off by default so user prompts and
		// code are not written outside var/ (review finding: fixed /tmp path).
		if (process.env.AGENT_SERVER_DEBUG_DUMP === "1") {
			await writeFile("/tmp/agent-server-request.json", JSON.stringify(body, null, 2));
		}
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
					content: msg.content.map((part: any) => (typeof part === "string" ? part : (part?.text ?? ""))).join(""),
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
			stop: typeof body.stop === "string" || Array.isArray(body.stop) ? (body.stop as string | string[]) : undefined,
			thinking:
				typeof body.thinking === "object" && body.thinking !== null
					? (body.thinking as Record<string, unknown>)
					: undefined,
		};
		const sessionPath = join(sessionDir, `${Date.now()}-${randomUUID()}.jsonl`);
		try {
			if (body.stream === true) {
				// OpenAI-compatible clients expect raw OpenAI SSE, not pi-ai events.
				// Do retrieval/injection manually, then forward to gateway. The raw
				// SSE bytes pass through untouched, but the session is recorded in
				// the same pi-native JSONL shape handleStream writes.
				mkdirSync(dirname(sessionPath), { recursive: true });
				const writer = new SessionWriter(sessionPath);
				writer.writeSessionHeader({
					id: basename(sessionPath, ".jsonl"),
					cwd: process.cwd(),
					metadata: { model: model.id, provider: model.provider, requestId },
				});
				try {
					const query =
						messages
							.filter((m: any) => m.role === "user")
							.map((m: any) => String(m.content))
							.filter((content: string) => !content.startsWith("<system-reminder>"))
							.pop() ?? "";
					console.log("[agent-server] stream query:", query);
					const retrieved = await retrieve(store, query, 8);
					// O spec observability point 1 (retrieval): local experience content.
					const kinds = kindsOf(retrieved);
					await store.recordRequestTrace({
						requestId,
						model: model.id,
						stream: true,
						retrievedCount: retrieved.length,
						retrievedIds: retrieved.map((r) => r.experience.id),
						retrievedKinds: kinds,
						hit: retrieved.length > 0,
					});
					logTrace(requestId, "retrieval", {
						hit: retrieved.length > 0 ? 1 : 0,
						retrieved: retrieved.length,
						kinds: summarizeKinds(kinds),
						injected: retrieved.length > 0 ? titlesOf(retrieved) : "",
						query_len: query.length,
					});
					const injected = await buildInjection(context as any, retrieved, { store });
					const openaiReq = toOpenAIRequest(injected, model as any);

					for (const message of messages) {
						writer.writeMessage(message);
					}
					writer.writeCustomEntry("experience_injection", { retrieved: retrieved.map((r) => r.experience.id) });
					// SPEC §6: record the injected context the model actually saw
					// (same custom_message entry handleStream writes).
					writer.writeCustomEntry("custom_message", {
						messages: injected.messages,
						systemPrompt: injected.systemPrompt,
						tools: injected.tools,
					});

					const gateway = new GatewayClient(gatewayUrl);
					const gatewayStream = await gateway.stream({
						...openaiReq,
						stream: true,
						...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
						...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
						...(options.stop !== undefined ? { stop: options.stop } : {}),
						...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
					});
					writer.writeCustomEntry("response_started");
					logTrace(requestId, "forward", { model: model.id, stream: 1 });
					reply.header("content-type", "text/event-stream");
					const tee = teeOpenAISSEWithSession(gatewayStream, writer, model as Model<any>, injected.tools);
					return reply.send(
						Readable.fromWeb(
							traceStreamCompletion(
								tee,
								requestId,
								store,
								startedAt,
							) as unknown as NodeReadableStream<Uint8Array>,
						),
					);
				} catch (err) {
					writer.writeCustomEntry("error", { message: String(err) });
					await writer.close();
					await store.recordRequestTrace({
						requestId,
						finishReason: "error",
						latencyMs: Date.now() - startedAt,
						error: String(err),
					});
					logTrace(requestId, "error", { message: String(err) });
					throw err;
				}
			}

			const stream = await handleStream({ model, context, options }, { store, gatewayUrl, sessionPath, requestId });
			const reader = stream.getReader();
			const chunks: string[] = [];
			const toolCalls = new Map<number, { id: string; name: string; args: string }>();
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
					} else if (event.type === "toolcall_start") {
						toolCalls.set(Number(event.contentIndex), {
							id: String(event.id),
							name: String(event.toolName),
							args: "",
						});
					} else if (event.type === "toolcall_delta") {
						const call = toolCalls.get(Number(event.contentIndex));
						if (call) call.args += String(event.delta ?? "");
					} else if (event.type === "done") {
						done = event;
					} else if (event.type === "error") {
						await store.recordRequestTrace({
							requestId,
							finishReason: "error",
							latencyMs: Date.now() - startedAt,
							error: String(event.errorMessage ?? "unknown"),
						});
						logTrace(requestId, "error", { message: String(event.errorMessage ?? "unknown") });
						return reply.code(502).send({ error: { message: String(event.errorMessage ?? "unknown") } });
					}
				}
			}
			const content = chunks.join("");
			const message: Record<string, unknown> = { role: "assistant", content };
			if (toolCalls.size > 0) {
				// OpenAI clients (litellm/mini-swe-agent) require tool_calls on the
				// response message; dropping them breaks every tool-calling agent.
				message.tool_calls = [...toolCalls.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([, call]) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: call.args },
					}));
			}
			const doneReason = done?.reason;
			const finishReason = doneReason === "toolUse" ? "tool_calls" : (doneReason ?? "stop");
			const u = (done?.usage ?? {}) as {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
			};
			const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			const completionTokens = u.output ?? 0;
			// O spec observability point 2 (completion): remote LLM result.
			await store.recordRequestTrace({
				requestId,
				finishReason: String(finishReason),
				promptTokens,
				completionTokens,
				latencyMs: Date.now() - startedAt,
			});
			logTrace(requestId, "done", {
				finish: finishReason,
				tokens: `${promptTokens}/${completionTokens}`,
				latency_ms: Date.now() - startedAt,
			});
			return reply.send({
				id: `chatcmpl-${randomUUID()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: model.id,
				choices: [
					{
						index: 0,
						message,
						finish_reason: finishReason,
					},
				],
				usage: {
					prompt_tokens: promptTokens,
					completion_tokens: completionTokens,
					total_tokens: u.totalTokens ?? promptTokens + completionTokens,
				},
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await store.recordRequestTrace({
				requestId,
				finishReason: "error",
				latencyMs: Date.now() - startedAt,
				error: message,
			});
			logTrace(requestId, "error", { message });
			return reply.code(502).send({ error: { message } });
		}
	});

	return fastify;
}

/**
 * Pass the gateway's raw OpenAI SSE bytes through unchanged while recording
 * the session: each parsed `data: {...}` chat.completion.chunk payload is
 * written as a `stream_event` custom entry, and when the stream completes the
 * accumulated chunks are reconstructed into a pi-native assistant `message`
 * entry via {@link buildAssistantMessageFromOpenAI}. Malformed payloads are
 * skipped without disturbing the passthrough. The writer is closed exactly
 * once, with a terminal custom entry on completion, mid-stream error, or
 * cancel (`response_completed` / `error` / `aborted`), and no assistant
 * message is written on error/abort — the same semantics as
 * proxy-handler.ts's teeWithSessionClose.
 *
 * In addition, delta.tool_calls chunks are accumulated per call index and
 * validated against the injection tool whitelist after the stream ends.
 * The validation report is written as a `toolcall_validation` custom entry
 * (observe-only: violations are logged but the raw bytes are never altered).
 */
export function teeOpenAISSEWithSession(
	source: ReadableStream<Uint8Array>,
	writer: SessionWriter,
	model: Model<any>,
	tools?: { name: string; parameters?: unknown }[],
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	const decoder = new TextDecoder();
	const chunks: OpenAIChatChunk[] = [];
	const pendingToolCalls: AccumulatedToolCall[] = [];
	let buffer = "";
	let closed = false;
	const closeWriter = async (customType: string, data?: unknown) => {
		if (closed) return;
		closed = true;
		writer.writeCustomEntry(customType, data);
		await writer.close();
	};
	const handleLine = (line: string) => {
		if (!line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") return;
		try {
			const chunk = JSON.parse(payload) as OpenAIChatChunk;
			chunks.push(chunk);
			writer.writeCustomEntry("stream_event", chunk);
			// Accumulate tool_call deltas by index for post-stream validation.
			for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
				const streamIndex = call.index ?? 0;
				let pending = pendingToolCalls.find((t) => t.streamIndex === streamIndex);
				if (!pending) {
					pending = { streamIndex, id: "", name: "", argsText: "" };
					pendingToolCalls.push(pending);
				}
				if (call.id) pending.id = call.id;
				if (call.function?.name) pending.name = call.function.name;
				if (call.function?.arguments) pending.argsText += call.function.arguments;
			}
		} catch {
			// Malformed SSE payloads are skipped; the passthrough must not crash.
		}
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					buffer += decoder.decode();
					if (buffer.trim()) handleLine(buffer.trim());
					const assistantMessage = buildAssistantMessageFromOpenAI(chunks, model);
					if (assistantMessage) writer.writeMessage(assistantMessage);
					// Post-stream toolCall validation (observe-only): validate accumulated
					// delta.tool_calls against the injection tool whitelist and record the
					// report without altering the raw SSE bytes.
					if (pendingToolCalls.length > 0 && tools && tools.length > 0) {
						const reports: ToolCallValidationReport[] = validateAccumulatedToolCalls(pendingToolCalls, tools);
						writer.writeCustomEntry("toolcall_validation", { reports });
						// Log violations to stderr for live observability.
						const violations = reports.filter((r) => !r.result.allowed);
						if (violations.length > 0) {
							console.error(
								"[agent-server] streaming toolCall violations:",
								violations.map((v) => v.result.reason),
							);
						}
					}
					await closeWriter("response_completed");
					controller.close();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					handleLine(buffer.slice(0, newline).trimEnd());
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				controller.enqueue(value);
			} catch (err) {
				await closeWriter("error", { message: String(err) });
				controller.error(err);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await closeWriter("aborted", { reason: String(reason) });
		},
	});
}

export async function startServer(port = 8788): Promise<void> {
	const server = createServer();
	const host = process.env.HOST ?? "127.0.0.1";
	await server.listen({ port, host });
	console.log(`agent-server listening on ${host}:${port}`);
}

/**
 * Wrap the raw OpenAI SSE passthrough to capture finish_reason/usage for the
 * O spec observability point 2 on the streaming path. Bytes pass through
 * unchanged; at stream end (or error) the completion phase of the
 * request_traces row is written and a `phase=done`/`phase=error` log emitted.
 */
function traceStreamCompletion(
	stream: ReadableStream<Uint8Array>,
	requestId: string,
	store: ExperienceStore,
	startedAt: number,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let finishReason: string | undefined;
	let promptTokens: number | undefined;
	let completionTokens: number | undefined;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await reader.read();
				if (done) {
					controller.close();
					await store.recordRequestTrace({
						requestId,
						finishReason: finishReason ?? "stop",
						promptTokens,
						completionTokens,
						latencyMs: Date.now() - startedAt,
					});
					logTrace(requestId, "done", {
						finish: finishReason ?? "stop",
						tokens: `${promptTokens ?? 0}/${completionTokens ?? 0}`,
						latency_ms: Date.now() - startedAt,
					});
					return;
				}
				for (const line of new TextDecoder().decode(value).split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (!payload || payload === "[DONE]") continue;
					try {
						const chunk = JSON.parse(payload) as {
							choices?: { finish_reason?: string | null }[];
							usage?: { prompt_tokens?: number; completion_tokens?: number };
						};
						const reason = chunk.choices?.[0]?.finish_reason;
						if (reason) finishReason = reason;
						if (chunk.usage) {
							promptTokens = chunk.usage.prompt_tokens;
							completionTokens = chunk.usage.completion_tokens;
						}
					} catch {
						// Malformed chunk: pass through, tracing is best-effort.
					}
				}
				controller.enqueue(value);
			} catch (err) {
				await store.recordRequestTrace({
					requestId,
					finishReason: "error",
					latencyMs: Date.now() - startedAt,
					error: String(err),
				});
				logTrace(requestId, "error", { message: String(err) });
				controller.error(err);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		},
	});
}
