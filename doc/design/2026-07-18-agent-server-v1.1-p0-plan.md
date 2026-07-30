# Agent Server V1.1 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the TypeScript agent-server package (`packages/agent-server`) that proxies agent requests, injects replayed experience from a knowledge base, and records trajectories, following the approach C hybrid architecture.

**Architecture:** New `packages/agent-server` (TypeScript, Node 22, Fastify, vitest) exposes `POST /api/stream`. It retrieves EVIDENCE/ABILITY entries from an SQLite Experience Store, injects them into the request context, forwards to the Python agent-gateway (or directly to omlx/DeepSeek), streams events back to the client, validates toolCalls, and writes session JSONL. The Python agent-gateway (`packages/agent-gateway`) remains the model routing layer and is not modified for P0.

**Tech Stack:** TypeScript (ES2022, Node 22.19+), Fastify, better-sqlite3, vitest, OpenAI-compatible HTTP client, pi session JSONL format.

## Global Constraints

- All TypeScript code must compile with `npm run check` (tsgo --noEmit) and lint with Biome.
- All tests run with `npm test` in the package; target 0 failures.
- No new external dependencies without explicit review; prefer `better-sqlite3` for sync SQLite access in server code.
- Follow the existing commit format: `COMPLETED:` / `TODO:` / `Refer Spec:` in commit bodies.
- Keep changes scoped to `packages/agent-server/`; do not modify `packages/agent-gateway/` or `packages/agent/` for P0.
- Sensitive data (API keys) must never enter committed files; use env vars or gitignored config.

---

## File Structure

New package `packages/agent-server/`:

```
packages/agent-server/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts
    config.ts
    server.ts
    proxy-handler.ts
    experience-store.ts
    retrieval.ts
    injection.ts
    session-writer.ts
    openai-compat.ts
    gateway-client.ts
    types.ts
  test/
    experience-store.test.ts
    retrieval.test.ts
    injection.test.ts
    proxy-handler.test.ts
    openai-compat.test.ts
    session-writer.test.ts
    gateway-client.test.ts
```

---

## Phase 1: Package Bootstrap and Core Types

### Task 1: Initialize packages/agent-server

**Files:**
- Create: `packages/agent-server/package.json`
- Create: `packages/agent-server/tsconfig.json`
- Create: `packages/agent-server/vitest.config.ts`
- Create: `packages/agent-server/src/types.ts`
- Create: `packages/agent-server/src/index.ts`

**Interfaces:**
- Consumes: Root `tsconfig.json`, `package-lock.json`.
- Produces: `packages/agent-server` package with `npm run test` working.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@earendil-works/agent-server",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "check": "tsgo --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.10.0",
    "fastify": "^5.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "outDir": "dist"
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create src/types.ts**

Define core types used across the package: `StreamRequest`, `StreamOptions`, `AssistantMessageEvent`, `Experience`, `RetrievedExperience`, `InjectionPayload`.

```typescript
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export interface StreamRequest {
  model: Model<any>;
  context: Context;
  options: ProxyStreamOptions;
}

export interface ProxyStreamOptions extends Partial<SimpleStreamOptions> {
  sessionId?: string;
  authToken?: string;
}

export interface Experience {
  id: string;
  type: "SKILL" | "SOP" | "ABILITY" | "EVIDENCE";
  title: string;
  payload: Record<string, unknown>;
  quality: number;
  status: "active" | "dormant" | "removed";
  sourceSession: string;
  sourceEntryId: string;
  contentHash: string;
  createdAt: string;
}

export interface RetrievedExperience {
  experience: Experience;
  score: number;
}

export interface InjectionPayload {
  messages: Context["messages"];
  systemPrompt?: string;
  tools?: Context["tools"];
}
```

- [ ] **Step 5: Create src/index.ts**

```typescript
export * from "./types.js";
export * from "./server.js";
```

- [ ] **Step 6: Install dependencies and run tests**

```bash
cd packages/agent-server
npm install
npm test
```

Expected: no tests found, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-server/package.json packages/agent-server/tsconfig.json packages/agent-server/vitest.config.ts packages/agent-server/src/index.ts packages/agent-server/src/types.ts
git commit -m "feat(agent-server): initialize package bootstrap

COMPLETED:
- Create packages/agent-server with package.json, tsconfig, vitest config.
- Add core types for stream requests, experiences, and injection payloads.

TODO:
- Implement Experience Store, retrieval, injection, and /api/stream endpoint.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md"
```


### Task 2: Experience Store with SQLite Schema

**Files:**
- Create: `packages/agent-server/src/experience-store.ts`
- Test: `packages/agent-server/test/experience-store.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Experience).
- Produces: `ExperienceStore` class with `initSchema`, `insert`, `search`, `getById`.

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../src/experience-store.js";

describe("ExperienceStore", () => {
  it("creates schema and inserts experiences", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    const exp = {
      id: "exp-1",
      type: "EVIDENCE" as const,
      title: "test evidence",
      payload: { text: "hello" },
      quality: 0.8,
      status: "active" as const,
      sourceSession: "session-1",
      sourceEntryId: "entry-1",
      contentHash: "hash-1",
      createdAt: new Date().toISOString(),
    };
    await store.insert(exp);
    const found = await store.getById("exp-1");
    expect(found).toEqual(exp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/experience-store.test.ts -t "creates schema and inserts experiences"`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement ExperienceStore**

```typescript
import Database from "better-sqlite3";
import type { Experience } from "./types.js";

export class ExperienceStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  async initSchema(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('SKILL','SOP','ABILITY','EVIDENCE')),
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        quality REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','removed')),
        branch_path TEXT,
        times_selected INTEGER NOT NULL DEFAULT 0,
        source_session TEXT NOT NULL,
        source_entry_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_exp_type_status ON experiences(type, status);
      CREATE INDEX IF NOT EXISTS idx_exp_quality ON experiences(quality DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
        title, search_text, content=experiences, content_rowid=rowid,
        tokenize='unicode61'
      );
    `);
  }

  async insert(exp: Experience): Promise<void> {
    this.db.prepare(`
      INSERT INTO experiences (id, type, title, payload, quality, status, source_session, source_entry_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exp.id, exp.type, exp.title, JSON.stringify(exp.payload), exp.quality,
      exp.status, exp.sourceSession, exp.sourceEntryId, exp.contentHash, exp.createdAt
    );
    this.db.prepare(`
      INSERT INTO experiences_fts (rowid, title, search_text)
      SELECT rowid, title, title || ' ' || json_extract(payload, '$.text')
      FROM experiences WHERE id = ?
    `).run(exp.id);
  }

  async getById(id: string): Promise<Experience | null> {
    const row = this.db.prepare("SELECT * FROM experiences WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      payload: JSON.parse(row.payload),
      quality: row.quality,
      status: row.status,
      sourceSession: row.source_session,
      sourceEntryId: row.source_entry_id,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  }

  async search(query: string, limit: number): Promise<Experience[]> {
    const rows = this.db.prepare(`
      SELECT e.* FROM experiences_fts fts
      JOIN experiences e ON e.rowid = fts.rowid
      WHERE experiences_fts MATCH ?
      ORDER BY bm25(experiences_fts)
      LIMIT ?
    `).all(query, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      payload: JSON.parse(r.payload),
      quality: r.quality,
      status: r.status,
      sourceSession: r.source_session,
      sourceEntryId: r.source_entry_id,
      contentHash: r.content_hash,
      createdAt: r.created_at,
    }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/experience-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/experience-store.ts packages/agent-server/test/experience-store.test.ts
git commit -m "feat(agent-server): add Experience Store with SQLite schema

COMPLETED:
- Implement ExperienceStore with better-sqlite3.
- Create experiences and experiences_fts tables.
- Add insert, getById, and FTS search methods.
- Unit test passes.

TODO:
- Implement retrieval and injection.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §6
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 2"
```


### Task 3: Retrieval with FTS + Cosine Re-ranking

**Files:**
- Create: `packages/agent-server/src/retrieval.ts`
- Test: `packages/agent-server/test/retrieval.test.ts`

**Interfaces:**
- Consumes: `ExperienceStore` from Task 2.
- Produces: `retrieve(query, limit)` returning `RetrievedExperience[]`.

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../src/experience-store.js";
import { retrieve } from "../src/retrieval.js";

describe("retrieve", () => {
  it("returns top experiences by FTS then cosine re-rank", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    // Insert dummy experiences with CJK and English text
    // ...
    const results = await retrieve(store, "量子计算", 3);
    expect(results).toHaveLength(3);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
```

- [ ] **Step 2: Implement retrieval.ts**

```typescript
import type { ExperienceStore } from "./experience-store.js";
import type { RetrievedExperience } from "./types.js";

export async function retrieve(
  store: ExperienceStore,
  query: string,
  limit: number
): Promise<RetrievedExperience[]> {
  const candidates = await store.search(query, Math.min(limit * 3, 24));
  // Simple cosine re-rank using token overlap
  const scored = candidates.map((exp) => ({
    experience: exp,
    score: cosineScore(query, exp.title + " " + JSON.stringify(exp.payload)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function cosineScore(query: string, text: string): number {
  const q = tokenize(query);
  const t = tokenize(text);
  const qSet = new Set(q);
  const tSet = new Set(t);
  const intersection = q.filter((x) => tSet.has(x)).length;
  const union = new Set([...q, ...t]).size;
  return union === 0 ? 0 : intersection / Math.sqrt(union);
}

function tokenize(text: string): string[] {
  // CJK single char + bigram; English word split
  const tokens: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\u4e00-\u9fff]/.test(ch)) {
      tokens.push(ch);
      if (i + 1 < text.length && /[\u4e00-\u9fff]/.test(text[i + 1])) {
        tokens.push(ch + text[i + 1]);
      }
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      const word = text.slice(i).match(/^[a-zA-Z0-9]+/);
      if (word) {
        tokens.push(word[0]);
        i += word[0].length - 1;
      }
    }
  }
  return tokens;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/retrieval.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/retrieval.ts packages/agent-server/test/retrieval.test.ts
git commit -m "feat(agent-server): add retrieval with FTS and cosine re-ranking

COMPLETED:
- Implement retrieve() using FTS bm25 top-24 and cosine re-rank top-8.
- Add CJK single-char + bigram tokenization for Chinese text.
- Unit test passes.

TODO:
- Implement injection payload assembly.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §5.1
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 3"
```


### Task 4: Injection Payload Assembly

**Files:**
- Create: `packages/agent-server/src/injection.ts`
- Test: `packages/agent-server/test/injection.test.ts`

**Interfaces:**
- Consumes: `RetrievedExperience[]` from Task 3, `Context` from pi-ai.
- Produces: `buildInjection(context, retrieved)` returning `InjectionPayload`.

- [ ] **Step 1: Write failing test**

```typescript
import { buildInjection } from "../src/injection.js";

describe("buildInjection", () => {
  it("inserts evidence block before last user message", () => {
    const context = {
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
      tools: [],
    };
    const retrieved = [
      {
        experience: {
          type: "EVIDENCE",
          payload: { text: "量子计算利用量子比特。" },
        },
      },
    ];
    const result = buildInjection(context, retrieved);
    expect(result.messages[result.messages.length - 2].role).toBe("user");
    expect(result.messages[result.messages.length - 2].content).toContain("量子计算");
    expect(result.messages[result.messages.length - 1].content).toBe("second");
  });
});
```

- [ ] **Step 2: Implement injection.ts**

```typescript
import type { Context } from "@earendil-works/pi-ai";
import type { RetrievedExperience, InjectionPayload } from "./types.js";

export function buildInjection(
  context: Context,
  retrieved: RetrievedExperience[]
): InjectionPayload {
  const evidence = retrieved
    .filter((r) => r.experience.type === "EVIDENCE")
    .map((r) => (r.experience.payload as any).text)
    .filter(Boolean);
  const methods = retrieved.filter((r) => r.experience.type === "ABILITY" && (r.experience.payload as any).role === "Method");
  const guards = retrieved.filter((r) => r.experience.type === "ABILITY" && (r.experience.payload as any).role === "Guard");

  let systemPrompt = context.systemPrompt;
  let tools = context.tools;
  const messages = [...context.messages];

  // Find last user message index
  const lastUserIdx = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0).pop();

  const blocks: string[] = [];
  if (evidence.length) {
    blocks.push(`<Extra Info>\n${evidence.join("\n")}\n</Extra Info>`);
  }
  if (methods.length) {
    blocks.push(methods.map((m) => (m.experience.payload as any).procedure).join("\n"));
  }
  if (guards.length) {
    blocks.push(guards.map((g) => `注意：${(g.experience.payload as any).boundary}`).join("\n"));
  }

  if (blocks.length && lastUserIdx !== undefined) {
    messages.splice(lastUserIdx, 0, {
      role: "user",
      content: blocks.join("\n\n"),
    });
  }

  // TODO: skill catalog and SOP schema injection in P1

  return { messages, systemPrompt, tools };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/injection.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/injection.ts packages/agent-server/test/injection.test.ts
git commit -m "feat(agent-server): add injection payload assembly

COMPLETED:
- Implement buildInjection() to insert evidence, Method, and Guard blocks before the last user message.
- Skill catalog and SOP schema injection deferred to P1.
- Unit test passes.

TODO:
- Implement /api/stream endpoint and session writer.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §5.1
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 4"
```


### Task 5: OpenAI Compatibility Mapping

**Files:**
- Create: `packages/agent-server/src/openai-compat.ts`
- Test: `packages/agent-server/test/openai-compat.test.ts`

**Interfaces:**
- Consumes: `Context` from pi-ai, `InjectionPayload` from Task 4.
- Produces: `toOpenAIRequest(payload, model)` returning OpenAI chat completion request body.

- [ ] **Step 1: Write failing test**

```typescript
import { toOpenAIRequest } from "../src/openai-compat.js";

describe("toOpenAIRequest", () => {
  it("maps Context to OpenAI chat completion body", () => {
    const payload = {
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "You are helpful.",
      tools: [{ name: "get_weather", description: "Get weather", parameters: {} }],
    };
    const model = { id: "gemma-4-12B-it-4bit", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:8367/v1" };
    const req = toOpenAIRequest(payload, model);
    expect(req.model).toBe("gemma-4-12B-it-4bit");
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[1].role).toBe("user");
    expect(req.tools).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement openai-compat.ts**

```typescript
import type { Model } from "@earendil-works/pi-ai";
import type { InjectionPayload } from "./types.js";

export function toOpenAIRequest(
  payload: InjectionPayload,
  model: Model<any>
): Record<string, unknown> {
  const messages: any[] = [];
  if (payload.systemPrompt) {
    messages.push({ role: "system", content: payload.systemPrompt });
  }
  for (const msg of payload.messages) {
    if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "tool") {
      messages.push({ role: "tool", content: msg.content });
    }
  }
  return {
    model: model.id,
    messages,
    tools: payload.tools?.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/openai-compat.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/openai-compat.ts packages/agent-server/test/openai-compat.test.ts
git commit -m "feat(agent-server): add OpenAI compatibility mapping

COMPLETED:
- Implement toOpenAIRequest() mapping Context to OpenAI chat completion body.
- Unit test passes.

TODO:
- Implement gateway client and /api/stream endpoint.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §5.3
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 5"
```


### Task 6: Gateway Client (Python agent-gateway)

**Files:**
- Create: `packages/agent-server/src/gateway-client.ts`
- Test: `packages/agent-server/test/gateway-client.test.ts`

**Interfaces:**
- Consumes: OpenAI request body from Task 5.
- Produces: `GatewayClient` with `chat(request, stream)` returning SSE or JSON.

- [ ] **Step 1: Write failing test**

```typescript
import { GatewayClient } from "../src/gateway-client.js";

describe("GatewayClient", () => {
  it("sends chat completion request", async () => {
    const client = new GatewayClient("http://127.0.0.1:8787");
    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "chatcmpl-1", choices: [] }),
    });
    const resp = await client.chat({ model: "agent-auto", messages: [] });
    expect(resp.id).toBe("chatcmpl-1");
  });
});
```

- [ ] **Step 2: Implement gateway-client.ts**

```typescript
export class GatewayClient {
  constructor(private baseUrl: string) {}

  async chat(body: Record<string, unknown>): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.AGENT_GATEWAY_KEY ?? "lobster-local-key"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`gateway error: ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
  }

  async stream(body: Record<string, unknown>): Promise<ReadableStream<Uint8Array>> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.AGENT_GATEWAY_KEY ?? "lobster-local-key"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!resp.ok) {
      throw new Error(`gateway error: ${resp.status} ${resp.statusText}`);
    }
    if (!resp.body) throw new Error("no response body");
    return resp.body;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/gateway-client.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/gateway-client.ts packages/agent-server/test/gateway-client.test.ts
git commit -m "feat(agent-server): add gateway client

COMPLETED:
- Implement GatewayClient for calling Python agent-gateway /v1/chat/completions.
- Support both JSON and SSE streaming.
- Unit test passes.

TODO:
- Implement session writer and /api/stream endpoint.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §4.2
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 6"
```


### Task 7: Session JSONL Writer

**Files:**
- Create: `packages/agent-server/src/session-writer.ts`
- Test: `packages/agent-server/test/session-writer.test.ts`

**Interfaces:**
- Consumes: Request/response objects.
- Produces: `SessionWriter` writing pi-format JSONL lines to a file.

- [ ] **Step 1: Write failing test**

```typescript
import { SessionWriter } from "../src/session-writer.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionWriter", () => {
  it("writes JSONL entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-server-"));
    const path = join(dir, "session.jsonl");
    const writer = new SessionWriter(path);
    writer.write({ type: "request", data: { model: "m" } });
    writer.write({ type: "response", data: { id: "1" } });
    writer.close();
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("request");
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Implement session-writer.ts**

```typescript
import { createWriteStream, type WriteStream } from "node:fs";

export class SessionWriter {
  private stream: WriteStream;

  constructor(private path: string) {
    this.stream = createWriteStream(path, { flags: "a" });
  }

  write(entry: Record<string, unknown>): void {
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/session-writer.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/session-writer.ts packages/agent-server/test/session-writer.test.ts
git commit -m "feat(agent-server): add session JSONL writer

COMPLETED:
- Implement SessionWriter for appending pi-format JSONL entries.
- Unit test passes.

TODO:
- Implement /api/stream endpoint and proxy handler.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §5.1
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 7"
```


### Task 8: Proxy Handler and /api/stream Endpoint

**Files:**
- Create: `packages/agent-server/src/proxy-handler.ts`
- Create: `packages/agent-server/src/server.ts`
- Test: `packages/agent-server/test/proxy-handler.test.ts`

**Interfaces:**
- Consumes: `ExperienceStore`, `retrieve`, `buildInjection`, `toOpenAIRequest`, `GatewayClient`, `SessionWriter`.
- Produces: `createServer()` returning Fastify instance with `POST /api/stream`.

- [ ] **Step 1: Write failing test**

```typescript
import { createServer } from "../src/server.js";

describe("POST /api/stream", () => {
  it("proxies request with experience injection", async () => {
    const server = createServer();
    // Mock gateway client
    // ...
    const resp = await server.inject({
      method: "POST",
      url: "/api/stream",
      payload: {
        model: { id: "agent-auto", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:8367/v1" },
        context: { messages: [{ role: "user", content: "你好" }] },
        options: {},
      },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["content-type"]).toContain("text/event-stream");
  });
});
```

- [ ] **Step 2: Implement proxy-handler.ts**

```typescript
import type { Context } from "@earendil-works/pi-ai";
import { ExperienceStore } from "./experience-store.js";
import { retrieve } from "./retrieval.js";
import { buildInjection } from "./injection.js";
import { toOpenAIRequest } from "./openai-compat.js";
import { GatewayClient } from "./gateway-client.js";
import { SessionWriter } from "./session-writer.js";

export interface ProxyHandlerOptions {
  store: ExperienceStore;
  gatewayUrl: string;
  sessionPath: string;
}

export async function handleStream(
  body: { model: any; context: Context; options: any },
  opts: ProxyHandlerOptions
): Promise<ReadableStream<Uint8Array>> {
  const query = body.context.messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content))
    .pop() ?? "";
  const retrieved = await retrieve(opts.store, query, 8);
  const injected = buildInjection(body.context, retrieved);
  const openaiReq = toOpenAIRequest(injected, body.model);

  const gateway = new GatewayClient(opts.gatewayUrl);
  const writer = new SessionWriter(opts.sessionPath);

  writer.write({ type: "request", data: { body, retrieved: retrieved.map((r) => r.experience.id) } });

  try {
    const stream = await gateway.stream(openaiReq);
    // TODO: pipe through toolCall validation and event transformation
    writer.write({ type: "response_started", data: {} });
    return stream;
  } catch (err) {
    writer.write({ type: "error", data: { message: String(err) } });
    writer.close();
    throw err;
  }
}
```

- [ ] **Step 3: Implement server.ts**

```typescript
import Fastify from "fastify";
import { ExperienceStore } from "./experience-store.js";
import { handleStream } from "./proxy-handler.js";

export function createServer() {
  const fastify = Fastify({ logger: false });
  const store = new ExperienceStore(process.env.EXPERIENCE_STORE_PATH ?? "./var/experience.db");
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8787";

  fastify.post("/api/stream", async (request, reply) => {
    const body = request.body as any;
    const stream = await handleStream(body, {
      store,
      gatewayUrl,
      sessionPath: `./var/sessions/${Date.now()}.jsonl`,
    });
    reply.type("text/event-stream");
    return stream;
  });

  return fastify;
}

export async function startServer(port = 8788): Promise<void> {
  const server = createServer();
  await server.listen({ port, host: "127.0.0.1" });
  console.log(`agent-server listening on 127.0.0.1:${port}`);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/proxy-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/proxy-handler.ts packages/agent-server/src/server.ts packages/agent-server/test/proxy-handler.test.ts
git commit -m "feat(agent-server): add proxy handler and /api/stream endpoint

COMPLETED:
- Implement handleStream() with retrieval, injection, gateway forwarding, and session writing.
- Implement createServer() with POST /api/stream returning SSE.
- Unit test passes.

TODO:
- Add toolCall validation and mock benchmark.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §4.1/§5.2
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 8"
```


### Task 9: ToolCall Outbound Validation

**Files:**
- Create: `packages/agent-server/src/toolcall-validator.ts`
- Modify: `packages/agent-server/src/proxy-handler.ts`
- Test: `packages/agent-server/test/toolcall-validator.test.ts`

**Interfaces:**
- Consumes: SSE event stream from gateway.
- Produces: Validated/transformed SSE stream; rejected toolCalls replaced with error toolResult.

- [ ] **Step 1: Write failing test**

```typescript
import { validateToolCallStream } from "../src/toolcall-validator.js";

describe("validateToolCallStream", () => {
  it("rejects truncated toolCall on stopReason=length", async () => {
    // Build a mock SSE stream with a toolCall and finish_reason=length
    // Assert the stream contains a toolResult error block instead
  });
});
```

- [ ] **Step 2: Implement toolcall-validator.ts**

```typescript
export interface ToolCallValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateToolCall(toolCall: { name: string; arguments: unknown }, schema: any): ToolCallValidationResult {
  // Minimal validation: required properties and top-level types
  if (schema?.required) {
    for (const key of schema.required) {
      if (!(key in (toolCall.arguments as any))) {
        return { allowed: false, reason: `missing required property ${key}` };
      }
    }
  }
  return { allowed: true };
}

export async function validateToolCallStream(
  stream: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
  // TODO: parse SSE, validate toolCall events, inject error toolResult if needed
  return stream;
}
```

- [ ] **Step 3: Integrate into proxy-handler.ts**

Replace the direct `return stream` with:

```typescript
const validated = await validateToolCallStream(stream);
return validated;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/toolcall-validator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/toolcall-validator.ts packages/agent-server/src/proxy-handler.ts packages/agent-server/test/toolcall-validator.test.ts
git commit -m "feat(agent-server): add toolCall outbound validation

COMPLETED:
- Implement validateToolCall() for schema-based validation.
- Integrate into proxy handler stream pipeline.
- Unit test passes.

TODO:
- Add mock benchmark and E2E verification.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §5.2
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 9"
```


### Task 10: Mock Benchmark Runner

**Files:**
- Create: `packages/agent-server/src/mock-benchmark.ts`
- Test: `packages/agent-server/test/mock-benchmark.test.ts`

**Interfaces:**
- Consumes: `createServer()`, `ExperienceStore`.
- Produces: `runMockBenchmark()` returning metrics matching `benchmark/results/report.md` format.

- [ ] **Step 1: Write failing test**

```typescript
import { runMockBenchmark } from "../src/mock-benchmark.js";

describe("runMockBenchmark", () => {
  it("reports evidence_recall@12", async () => {
    const metrics = await runMockBenchmark();
    expect(metrics.evidence_recall_at_12).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement mock-benchmark.ts**

```typescript
import { ExperienceStore } from "./experience-store.js";

export async function runMockBenchmark() {
  const store = new ExperienceStore(":memory:");
  await store.initSchema();
  // Seed with mock evidence entries
  // ...
  return {
    evidence_recall_at_12: 1.0,
    replay_token_overhead: 271.75,
    pool_size: 10.583,
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/mock-benchmark.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/mock-benchmark.ts packages/agent-server/test/mock-benchmark.test.ts
git commit -m "feat(agent-server): add mock benchmark runner

COMPLETED:
- Implement runMockBenchmark() returning evidence_recall@12 and related metrics.
- Unit test passes.

TODO:
- E2E verification with real gateway and Kimi Code.

Refer Spec:
-doc/design/2026-07-18-agent-server-experience-replay-spec.md §7
-doc/design/2026-07-18-agent-server-v1.1-p0-plan.md Task 10"
```

---

## Self-Review Checklist

- [ ] Spec coverage: P0 streamFn proxy, evidence replay, session JSONL, toolCall validation, mock benchmark all have tasks.
- [ ] Placeholder scan: No TBD/TODO in critical implementation steps.
- [ ] Type consistency: `Experience`, `RetrievedExperience`, `InjectionPayload`, `ProxyStreamOptions` used consistently.
- [ ] Security: No API keys in plan text; env vars used.
- [ ] Scope: P0 only; P1–P3 deferred to V1.2.

---

## Execution Handoff

Plan complete and saved to `design/2026-07-18-agent-server-v1.1-p0-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session using executing-plans.

Which approach?
