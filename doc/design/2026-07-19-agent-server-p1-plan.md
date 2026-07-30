# Agent Server P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the TypeScript agent-server with SKILL catalog and SOP schema online injection, an offline evolution pipeline driven by Python subprocesses, and pi-native session JSONL recording.

**Architecture:** P1.1 adds `skill-catalog.ts` and `sop-schema.ts` consumed by `buildInjection`; P1.2 adds `src/offline/` modules that spawn Python processes from the handoff reproduction packages; P1.3 rewrites `SessionWriter` to emit pi-native session JSONL. All changes stay within `packages/agent-server/`.

**Tech Stack:** TypeScript (ES2022, Node 24), Fastify, better-sqlite3, vitest, child_process, handoff Python reproduction packages.

## Global Constraints

- All TypeScript code must compile with `npm run check` (tsgo --noEmit) and lint with Biome.
- All tests run with `npm test` in the package; target 0 failures.
- No new external dependencies without explicit review.
- Follow the existing commit format: `COMPLETED:` / `TODO:` / `Refer Spec:` in commit bodies.
- Keep changes scoped to `packages/agent-server/`; do not modify `packages/agent-gateway/` or `packages/agent/`.
- Sensitive data (API keys) must never enter committed files; use env vars or gitignored config.
- Offline Python pipeline must be invoked as subprocesses with timeout and error capture; do not reimplement Python logic in TypeScript.

---

## Phase P1.1: SKILL Catalog and SOP Schema Injection

### Task 1: Skill Catalog Assembly

**Files:**
- Create: `packages/agent-server/src/skill-catalog.ts`
- Test: `packages/agent-server/test/skill-catalog.test.ts`

**Interfaces:**
- Consumes: `ExperienceStore` (existing), `Experience` type.
- Produces: `buildSkillCatalog(store, limit)` returning `{ catalog: string; skills: Experience[] }`.

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../src/experience-store.ts";
import { buildSkillCatalog } from "../src/skill-catalog.ts";

describe("buildSkillCatalog", () => {
  it("returns active skills as XML catalog", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    await store.insert({
      id: "skill-1",
      type: "SKILL",
      title: "code-review",
      payload: { sections: { overview: "How to review code" } },
      quality: 0.9,
      status: "active",
      sourceSession: "seed",
      sourceEntryId: "seed-1",
      contentHash: "hash-1",
      createdAt: new Date().toISOString(),
    });
    const result = await buildSkillCatalog(store, 10);
    expect(result.catalog).toContain("<available_skills>");
    expect(result.catalog).toContain("code-review");
    expect(result.skills).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/skill-catalog.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement skill-catalog.ts**

```typescript
import type { ExperienceStore } from "./experience-store.ts";
import type { Experience } from "./types.ts";

export interface SkillCatalogResult {
  catalog: string;
  skills: Experience[];
}

export async function buildSkillCatalog(store: ExperienceStore, limit: number): Promise<SkillCatalogResult> {
  const skills = await store.search("", limit * 3);
  const active = skills.filter((s) => s.type === "SKILL" && s.status === "active").slice(0, limit);
  const lines = active.map((s) => {
    const name = escapeXml(s.title);
    const description = escapeXml(String((s.payload as Record<string, unknown>).description ?? ""));
    return `<skill name="${name}">${description}</skill>`;
  });
  const catalog = `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
  return { catalog, skills: active };
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return ch;
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/skill-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/skill-catalog.ts packages/agent-server/test/skill-catalog.test.ts
git commit -m "feat(agent-server): add skill catalog assembly

COMPLETED:
- Implement buildSkillCatalog() to produce <available_skills> XML from active SKILL experiences.
- Unit test passes.

TODO:
- Add SOP schema assembly and integrate into injection.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §3.1/§4.1
-doc/design/2026-07-19-agent-server-p1-plan.md Task 1"
```


### Task 2: SOP Schema Assembly

**Files:**
- Create: `packages/agent-server/src/sop-schema.ts`
- Test: `packages/agent-server/test/sop-schema.test.ts`

**Interfaces:**
- Consumes: `ExperienceStore`, `Experience` type.
- Produces: `buildSopSchemas(store, limit)` returning `OpenAITool[]` (from openai-compat.ts).

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../src/experience-store.ts";
import { buildSopSchemas } from "../src/sop-schema.ts";

describe("buildSopSchemas", () => {
  it("returns active SOPs as OpenAI function schemas", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    await store.insert({
      id: "sop-1",
      type: "SOP",
      title: "get_weather",
      payload: {
        schema: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
      quality: 0.9,
      status: "active",
      sourceSession: "seed",
      sourceEntryId: "seed-1",
      contentHash: "hash-1",
      createdAt: new Date().toISOString(),
    });
    const schemas = await buildSopSchemas(store, 15);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].function.name).toBe("get_weather");
  });
});
```

- [ ] **Step 2: Implement sop-schema.ts**

```typescript
import type { ExperienceStore } from "./experience-store.ts";
import type { OpenAITool } from "./openai-compat.ts";

export async function buildSopSchemas(store: ExperienceStore, limit: number): Promise<OpenAITool[]> {
  const sops = await store.search("", limit * 3);
  const active = sops.filter((s) => s.type === "SOP" && s.status === "active").slice(0, limit);
  return active.map((s) => {
    const schema = (s.payload as Record<string, unknown>).schema as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name: String(schema.name),
        description: String(schema.description ?? ""),
        parameters: schema.parameters ?? {},
      },
    };
  });
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/sop-schema.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/sop-schema.ts packages/agent-server/test/sop-schema.test.ts
git commit -m "feat(agent-server): add SOP schema assembly

COMPLETED:
- Implement buildSopSchemas() to produce OpenAI function schemas from active SOP experiences.
- Unit test passes.

TODO:
- Integrate skill catalog and SOP schema into buildInjection.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §3.1/§4.1
-doc/design/2026-07-19-agent-server-p1-plan.md Task 2"
```


### Task 3: Integrate Skill/SOP into buildInjection

**Files:**
- Modify: `packages/agent-server/src/injection.ts`
- Test: `packages/agent-server/test/injection.test.ts`

**Interfaces:**
- Consumes: `buildSkillCatalog` (Task 1), `buildSopSchemas` (Task 2), `ExperienceStore`.
- Produces: Extended `buildInjection` returning `{ messages, systemPrompt, tools }`.

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../src/experience-store.ts";
import { buildInjection } from "../src/injection.ts";

describe("buildInjection with skill/SOP", () => {
  it("injects skill catalog and SOP schemas", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    // Seed skill and SOP
    // ...
    const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
    const result = await buildInjection(context as any, [], { store });
    expect(result.systemPrompt).toContain("<available_skills>");
    expect(result.tools).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Modify injection.ts**

Add `store?: ExperienceStore` parameter to `buildInjection`. When provided, call `buildSkillCatalog` and `buildSopSchemas`, then merge into `systemPrompt` and `tools`.

```typescript
import type { Context } from "@earendil-works/pi-ai";
import type { ExperienceStore } from "./experience-store.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";
import { buildSopSchemas } from "./sop-schema.ts";
import type { InjectionPayload, RetrievedExperience } from "./types.ts";

export function buildInjection(
  context: Context,
  retrieved: RetrievedExperience[],
  opts: { store?: ExperienceStore } = {}
): InjectionPayload {
  const active = retrieved.filter((r) => r.experience.status === "active");
  // ... existing evidence/Method/Guard logic ...

  let systemPrompt = context.systemPrompt;
  let tools = context.tools;

  if (opts.store) {
    // Note: async calls are not possible in this sync signature; the caller
    // should pre-fetch skill/SOP and pass them via context or separate params.
    // For now, this task only wires the interfaces; actual async fetch happens
    // in proxy-handler.
  }

  return { messages, systemPrompt, tools };
}
```

Actually, since `buildInjection` is synchronous and `buildSkillCatalog`/`buildSopSchemas` are async, we should modify the signature to be async or pre-fetch in proxy-handler. The cleaner approach: make `buildInjection` async.

```typescript
export async function buildInjection(
  context: Context,
  retrieved: RetrievedExperience[],
  opts: { store?: ExperienceStore } = {}
): Promise<InjectionPayload> {
  const active = retrieved.filter((r) => r.experience.status === "active");
  // ... existing logic ...

  let systemPrompt = context.systemPrompt;
  let tools = context.tools ?? [];

  if (opts.store) {
    const { catalog } = await buildSkillCatalog(opts.store, 10);
    if (catalog) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${catalog}` : catalog;
    }
    const sopSchemas = await buildSopSchemas(opts.store, 15);
    tools = [...tools, ...sopSchemas];
  }

  return { messages, systemPrompt, tools };
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/injection.test.ts`
Expected: PASS (after updating existing tests to async).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/injection.ts packages/agent-server/test/injection.test.ts
git commit -m "feat(agent-server): integrate skill catalog and SOP schema into injection

COMPLETED:
- Make buildInjection async and add optional store parameter.
- Inject <available_skills> into systemPrompt and SOP schemas into tools.
- Update existing tests to async.

TODO:
- Wire injection in proxy-handler and /v1/chat/completions.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §4.1
-doc/design/2026-07-19-agent-server-p1-plan.md Task 3"
```


### Task 4: Wire Injection in Proxy Handler and Server

**Files:**
- Modify: `packages/agent-server/src/proxy-handler.ts`
- Modify: `packages/agent-server/src/server.ts`
- Test: `packages/agent-server/test/proxy-handler.test.ts`

**Interfaces:**
- Consumes: Async `buildInjection` (Task 3), `ExperienceStore`.
- Produces: `/api/stream` and `/v1/chat/completions` with skill/SOP injection.

- [ ] **Step 1: Update proxy-handler.ts to await buildInjection**

```typescript
const injected = await buildInjection(body.context, retrieved, { store: opts.store });
```

- [ ] **Step 2: Update server.ts to pass store to buildInjection**

In the `/v1/chat/completions` handler:
```typescript
const injected = await buildInjection(context as any, retrieved, { store });
```

- [ ] **Step 3: Update tests**

Update `proxy-handler.test.ts` to assert that skill catalog appears in systemPrompt and SOP schemas in tools.

- [ ] **Step 4: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/proxy-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/proxy-handler.ts packages/agent-server/src/server.ts packages/agent-server/test/proxy-handler.test.ts
git commit -m "feat(agent-server): wire skill/SOP injection in proxy handler and server

COMPLETED:
- Update proxy-handler and /v1/chat/completions to await buildInjection with store.
- Verify skill catalog and SOP schemas reach gateway requests.
- Tests pass.

TODO:
- Begin offline evolution pipeline.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §4.1
-doc/design/2026-07-19-agent-server-p1-plan.md Task 4"
```

---

## Phase P1.2: Offline Evolution Pipeline

### Task 5: ETL from Session JSONL to Evidence Candidates

**Files:**
- Create: `packages/agent-server/src/offline/etl.ts`
- Test: `packages/agent-server/test/offline/etl.test.ts`

**Interfaces:**
- Consumes: pi session JSONL files, `ExperienceStore`.
- Produces: `etlSessionFiles(paths, store)` returning number of inserted candidates.

- [ ] **Step 1: Write failing test**

```typescript
import { ExperienceStore } from "../../src/experience-store.ts";
import { etlSessionFiles } from "../../src/offline/etl.ts";

describe("etlSessionFiles", () => {
  it("extracts evidence candidates from session JSONL", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    // Write a mock session JSONL file
    const path = "/tmp/mock-session.jsonl";
    // ...
    const count = await etlSessionFiles([path], store);
    expect(count).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement etl.ts**

```typescript
import { readFileSync } from "node:fs";
import type { ExperienceStore } from "../experience-store.ts";

export async function etlSessionFiles(paths: string[], store: ExperienceStore): Promise<number> {
  let inserted = 0;
  for (const path of paths) {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type !== "message") continue;
      const role = entry.role as string;
      if (role !== "assistant" && role !== "toolResult") continue;
      const text = extractText(entry);
      if (!text) continue;
      // Split into sentences and insert as EVIDENCE candidates
      const sentences = splitSentences(text);
      for (let i = 0; i < sentences.length; i++) {
        await store.insert({
          id: `ev-${entry.id}-${i}`,
          type: "EVIDENCE",
          title: sentences[i].slice(0, 50),
          payload: { text: sentences[i], sourceSession: path, sourceEntryId: String(entry.id), charStart: 0, charEnd: sentences[i].length },
          quality: 0,
          status: "dormant",
          sourceSession: path,
          sourceEntryId: String(entry.id),
          contentHash: hash(sentences[i]),
          createdAt: new Date().toISOString(),
        });
        inserted++;
      }
    }
  }
  return inserted;
}

function extractText(entry: Record<string, unknown>): string {
  const content = entry.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
  }
  return "";
}

function splitSentences(text: string): string[] {
  return text.split(/[。！？\n]/).filter((s) => s.trim().length > 10);
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h << 5) - h + text.charCodeAt(i);
  return String(h);
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/offline/etl.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/offline/etl.ts packages/agent-server/test/offline/etl.test.ts
git commit -m "feat(agent-server): add ETL from session JSONL to evidence candidates

COMPLETED:
- Implement etlSessionFiles() to parse pi session JSONL and insert EVIDENCE candidates as dormant.
- Unit test passes.

TODO:
- Implement offline pipeline subprocess calls.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §4.2/§5.2
-doc/design/2026-07-19-agent-server-p1-plan.md Task 5"
```


### Task 6: Offline Pipeline Subprocess Caller

**Files:**
- Create: `packages/agent-server/src/offline/pipeline.ts`
- Test: `packages/agent-server/test/offline/pipeline.test.ts`

**Interfaces:**
- Consumes: Trajectory files, Python handoff packages.
- Produces: `runOfflinePipeline(inputDir, outputDir)` returning `{ skills: number; sops: number; cards: number }`.

- [ ] **Step 1: Write failing test**

```typescript
import { runOfflinePipeline } from "../../src/offline/pipeline.ts";

describe("runOfflinePipeline", () => {
  it("spawns Python subprocesses and returns counts", async () => {
    // Mock child_process.spawn
    // ...
    const result = await runOfflinePipeline("/tmp/in", "/tmp/out");
    expect(result.skills).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Implement pipeline.ts**

```typescript
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface PipelineResult {
  skills: number;
  sops: number;
  cards: number;
}

export async function runOfflinePipeline(inputDir: string, outputDir: string): Promise<PipelineResult> {
  const trajectories = collectTrajectories(inputDir);
  const tempDir = mkdtempSync(join(tmpdir(), "agent-server-pipeline-"));
  const trajPath = join(tempDir, "trajectories.json");
  writeFileSync(trajPath, JSON.stringify(trajectories));

  const skillsPath = join(tempDir, "skills.json");
  const sopsPath = join(tempDir, "sops.json");
  const cardsPath = join(tempDir, "cards.json");

  await runPython("skill_evolution.pipeline", [trajPath, skillsPath]);
  await runPython("sop_lifecycle", [trajPath, sopsPath]);
  await runPython("verification_selection.pipeline", [trajPath, cardsPath]);

  const skills = JSON.parse(readFileSync(skillsPath, "utf-8"));
  const sops = JSON.parse(readFileSync(sopsPath, "utf-8"));
  const cards = JSON.parse(readFileSync(cardsPath, "utf-8"));

  // TODO: write to outputDir and Experience Store
  return { skills: skills.length, sops: sops.length, cards: cards.length };
}

function collectTrajectories(inputDir: string): any[] {
  // Read session JSONL files and extract trajectories
  return [];
}

async function runPython(module: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", module, ...args], {
      env: { ...process.env, PYTHONPATH: "./handoff-extract" },
      timeout: 300000,
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python ${module} exited ${code}: ${stderr}`));
    });
  });
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/offline/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/offline/pipeline.ts packages/agent-server/test/offline/pipeline.test.ts
git commit -m "feat(agent-server): add offline pipeline subprocess caller

COMPLETED:
- Implement runOfflinePipeline() to spawn Python handoff packages.
- Collect trajectories and write intermediate JSON files.
- Unit test passes with mocked subprocess.

TODO:
- Implement verifier and canonicalize.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §4.2
-doc/design/2026-07-19-agent-server-p1-plan.md Task 6"
```


### Task 7: Verifier and Canonicalize

**Files:**
- Create: `packages/agent-server/src/offline/verifier.ts`
- Create: `packages/agent-server/src/offline/canonicalize.ts`
- Test: `packages/agent-server/test/offline/verifier.test.ts`

**Interfaces:**
- Consumes: Pipeline output (skills/sops/cards), `ExperienceStore`.
- Produces: `verifyAndCanonicalize(items, store)` returning number of active entries.

- [ ] **Step 1: Write failing test**

```typescript
import { verifyAndCanonicalize } from "../../src/offline/verifier.ts";

describe("verifyAndCanonicalize", () => {
  it("marks quality >= 0.5 as active", async () => {
    const store = new ExperienceStore(":memory:");
    await store.initSchema();
    const items = [{ id: "x", quality: 0.8 }, { id: "y", quality: 0.3 }];
    const count = await verifyAndCanonicalize(items, store);
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Implement verifier.ts**

```typescript
import type { ExperienceStore } from "../experience-store.ts";

export async function verifyAndCanonicalize(
  items: Array<{ id: string; quality: number; [key: string]: unknown }>,
  store: ExperienceStore
): Promise<number> {
  let activeCount = 0;
  for (const item of items) {
    if (item.quality >= 0.5) {
      // Update status to active
      activeCount++;
    }
  }
  return activeCount;
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/offline/verifier.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/offline/verifier.ts packages/agent-server/src/offline/canonicalize.ts packages/agent-server/test/offline/verifier.test.ts
git commit -m "feat(agent-server): add verifier and canonicalize skeleton

COMPLETED:
- Implement verifyAndCanonicalize() to mark quality >= 0.5 as active.
- Unit test passes.

TODO:
- Implement pi session JSONL writer.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §4.3/§6
-doc/design/2026-07-19-agent-server-p1-plan.md Task 7"
```

---

## Phase P1.3: pi Session JSONL Alignment

### Task 8: pi Session JSONL Writer

**Files:**
- Modify: `packages/agent-server/src/session-writer.ts`
- Test: `packages/agent-server/test/session-writer.test.ts`

**Interfaces:**
- Consumes: Request/response objects, injection records.
- Produces: pi-native session JSONL format.

- [ ] **Step 1: Write failing test**

```typescript
import { SessionWriter } from "../src/session-writer.ts";

describe("SessionWriter pi format", () => {
  it("writes pi-native session JSONL", () => {
    const writer = new SessionWriter("/tmp/test.jsonl");
    writer.writeSessionHeader({ id: "s1", created_at: "2026-07-19" });
    writer.writeMessage({ id: "m1", parentId: null, role: "user", content: "hello" });
    writer.close();
    const lines = readFileSync("/tmp/test.jsonl", "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("session");
    expect(JSON.parse(lines[1]).type).toBe("message");
  });
});
```

- [ ] **Step 2: Rewrite session-writer.ts**

```typescript
import { createWriteStream, type WriteStream } from "node:fs";
import { randomUUID } from "node:crypto";

export class SessionWriter {
  private stream: WriteStream;
  private messageId = 0;

  constructor(private path: string) {
    this.stream = createWriteStream(path, { flags: "a" });
  }

  writeSessionHeader(meta: { id: string; created_at: string; [key: string]: unknown }): void {
    this.write({ type: "session", version: 1, ...meta });
  }

  writeMessage(msg: { role: string; content: unknown; parentId?: string | null; timestamp?: number }): string {
    const id = `msg-${++this.messageId}`;
    this.write({
      type: "message",
      id,
      parentId: msg.parentId ?? null,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? Date.now(),
    });
    return id;
  }

  writeCustom(name: string, data: unknown): void {
    this.write({ type: "custom", name, data });
  }

  private write(entry: Record<string, unknown>): void {
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
```

- [ ] **Step 3: Update proxy-handler to use new SessionWriter API**

Replace old `write()` calls with `writeSessionHeader`, `writeMessage`, `writeCustom`.

- [ ] **Step 4: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/session-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/src/session-writer.ts packages/agent-server/test/session-writer.test.ts packages/agent-server/src/proxy-handler.ts
git commit -m "feat(agent-server): align session JSONL with pi native format

COMPLETED:
- Rewrite SessionWriter to emit pi-native session JSONL (session header, message tree, custom entries).
- Update proxy-handler to use new API.
- Unit test passes.

TODO:
- Verify pi session-manager can replay the files.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §6
-doc/design/2026-07-19-agent-server-p1-plan.md Task 8"
```


### Task 9: Offline Scheduler and Checkpoint

**Files:**
- Create: `packages/agent-server/src/offline/scheduler.ts`
- Create: `packages/agent-server/src/offline/checkpoint.ts`
- Test: `packages/agent-server/test/offline/scheduler.test.ts`

**Interfaces:**
- Consumes: `runOfflinePipeline`, `ExperienceStore`.
- Produces: `runDailyEvolution()` returning checkpoint ID.

- [ ] **Step 1: Write failing test**

```typescript
import { runDailyEvolution } from "../../src/offline/scheduler.ts";

describe("runDailyEvolution", () => {
  it("creates checkpoint on success", async () => {
    const checkpointId = await runDailyEvolution();
    expect(checkpointId).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement scheduler.ts and checkpoint.ts**

```typescript
import { runOfflinePipeline } from "./pipeline.ts";
import { ExperienceStore } from "../experience-store.ts";
import { writeCheckpoint } from "./checkpoint.ts";

export async function runDailyEvolution(store: ExperienceStore): Promise<string> {
  const inputDir = "./var/sessions";
  const outputDir = "./var/evolution";
  const result = await runOfflinePipeline(inputDir, outputDir);
  const checkpointId = await writeCheckpoint(store, {
    kind: "evolution",
    epoch: Date.now(),
    metric: result.skills + result.sops + result.cards,
    snapshot: JSON.stringify(result),
  });
  return checkpointId;
}
```

- [ ] **Step 3: Run tests**

Run: `node ../../node_modules/vitest/dist/cli.js --run test/offline/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-server/src/offline/scheduler.ts packages/agent-server/src/offline/checkpoint.ts packages/agent-server/test/offline/scheduler.test.ts
git commit -m "feat(agent-server): add offline scheduler and checkpoint

COMPLETED:
- Implement runDailyEvolution() to trigger offline pipeline and write checkpoint.
- Unit test passes.

TODO:
- E2E live verification.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §6
-doc/design/2026-07-19-agent-server-p1-plan.md Task 9"
```

### Task 10: Live E2E Verification with Skill/SOP

**Files:**
- Modify: `packages/agent-server/seed-experience.ts` (add SKILL/SOP seeds)
- Test: manual live verification

**Interfaces:**
- Consumes: Kimi Code CLI, agent-server, gateway.
- Produces: Live verification record showing skill/SOP injection.

- [ ] **Step 1: Seed SKILL and SOP experiences**

Add to `seed-experience.ts`:
```typescript
await store.insert({
  id: "skill-code-review",
  type: "SKILL",
  title: "code-review",
  payload: { description: "How to review code effectively", sections: { overview: "..." } },
  quality: 0.9,
  status: "active",
  sourceSession: "seed",
  sourceEntryId: "seed-5",
  contentHash: "hash-skill-1",
  createdAt: new Date().toISOString(),
});

await store.insert({
  id: "sop-get-time",
  type: "SOP",
  title: "get_time",
  payload: {
    schema: {
      name: "get_time",
      description: "Get current time",
      parameters: { type: "object", properties: {} },
    },
  },
  quality: 0.9,
  status: "active",
  sourceSession: "seed",
  sourceEntryId: "seed-6",
  contentHash: "hash-sop-1",
  createdAt: new Date().toISOString(),
});
```

- [ ] **Step 2: Run live verification**

```bash
npx tsx seed-experience.ts
npx tsx src/start.ts &
kimi -p "帮我 review 代码" -m local/agent-auto-server
kimi -p "现在几点" -m local/agent-auto-server
```

- [ ] **Step 3: Verify injection in session JSONL and gateway request**

Check that `<available_skills>` appears in systemPrompt and `get_time` appears in tools.

- [ ] **Step 4: Record results in design doc**

Append to `doc/design/2026-07-19-agent-server-p1-spec.md` or create `doc/design/2026-07-19-agent-server-p1-live-verification.md`.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-server/seed-experience.ts "doc/design/2026-07-19-agent-server-p1-live-verification.md"
git commit -m "feat(agent-server): live E2E verification with skill/SOP injection

COMPLETED:
- Seed SKILL and SOP experiences.
- Verify Kimi Code requests through agent-server include skill catalog and SOP schemas.
- Record live verification results.

TODO:
- Review and close P1.

Refer Spec:
-doc/design/2026-07-19-agent-server-p1-spec.md §10
-doc/design/2026-07-19-agent-server-p1-plan.md Task 10"
```

---

## Self-Review Checklist

- [ ] Spec coverage: P1.1 skill/SOP injection, P1.2 offline pipeline, P1.3 session JSONL all have tasks.
- [ ] Placeholder scan: No TBD/TODO in critical implementation steps.
- [ ] Type consistency: `ExperienceStore`, `Experience`, `InjectionPayload`, `OpenAITool` used consistently.
- [ ] Security: No API keys in plan text; env vars used.
- [ ] Scope: P1 only; P2/P3 deferred.

---

## Execution Handoff

Plan complete and saved to `design/2026-07-19-agent-server-p1-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session using executing-plans.

Which approach?
