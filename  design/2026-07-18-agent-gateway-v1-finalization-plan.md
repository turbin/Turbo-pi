# Agent Gateway V1 Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining V1 acceptance items (A05–A11) via live verification, fix known minor issues, remove dead code, and add missing tests so the gateway is ready to transition to V1.1 rules learning.

**Architecture:** The plan is executed in two phases: (1) **Live verification** of existing V1 behavior against the running omlx/DeepSeek environment, using curl/scripts and database checks only; (2) **Code fixes** for the issues found in `design/2026-07-17-agent-gateway-changes-and-decisions.md` §4 and test gaps. Each task produces independently testable deliverables.

**Tech Stack:** Python 3.12, FastAPI, uv, pytest, SQLite, httpx, asyncio.

## Global Constraints

- All new code must pass the full pytest suite: `uv run pytest -q` → 0 failures.
- Type checking via `tsgo` is not required for Python files; Python static checks are enforced by the existing test suite and runtime behavior.
- No inline imports; top-level imports only.
- Do not add new runtime dependencies unless explicitly required and reviewed.
- Sensitive data (API keys, secrets) must never enter committed files or design docs; use environment variables or gitignored `config.toml` only.
- Follow the existing commit format: `COMPLETED:` / `TODO:` / `Refer Spec:` in the commit body.
- Update `design/2026-07-17-agent-gateway-changes-and-decisions.md` and `design/2026-07-18-agent-gateway-live-verification.md` as each acceptance item is completed.
- Maintain the existing design-doc directory naming convention (leading space in the directory name) used by prior commits.

---

## Phase 1: Live Verification (A05–A10)

All tasks in Phase 1 are read-only against the running gateway and do not modify source code. They produce live verification records appended to `design/2026-07-18-agent-gateway-live-verification.md`.

Preconditions for Phase 1:
- omlx running on `127.0.0.1:8367` with API key `<OMLX_API_KEY>` (redacted in docs).
- gateway running on `127.0.0.1:8787` configured with the `lobster-local-key` channel and `deepseek` cloud provider via env vars.

### Task 1: A05 SSE Heartbeat, Replay, Usage Chunk, and [DONE]

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/sse.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: `POST /v1/chat/completions` with `"stream": true`, `stream_options.include_usage=true`.
- Produces: Verification log showing SSE chunks in correct order and final `[DONE]`.

- [ ] **Step 1: Send streaming request with usage**

```bash
curl -N -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent-auto",
    "messages": [{"role": "user", "content": "你好，请简短回复"}],
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 64
  }'
```

- [ ] **Step 2: Capture and inspect the SSE stream**

Save output to `/tmp/a05-sse.log` and verify:

```bash
python3 - << 'PY'
import json
chunks = []
with open('/tmp/a05-sse.log') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('data: '):
            continue
        data = line[6:]
        if data == '[DONE]':
            chunks.append({'done': True})
            continue
        chunks.append(json.loads(data))

# Verify sequence
assert chunks[0]['choices'][0]['delta'].get('role') == 'assistant', 'first chunk role'
usage_chunks = [c for c in chunks if c.get('usage')]
assert usage_chunks, 'usage chunk present'
assert chunks[-1].get('done'), 'ends with [DONE]'
print('A05 SSE sequence verified')
PY
```

Expected output: `A05 SSE sequence verified`.

- [ ] **Step 3: Verify the heartbeat interval**

Check `sse_heartbeat_seconds` in `config.toml` and confirm no idle timeout occurs during the stream.

- [ ] **Step 4: Record the verification result**

Append to `design/2026-07-18-agent-gateway-live-verification.md` under a new section `## A05 SSE Live Verification`, including the curl command, the observed chunk sequence, and the assertion output.

- [ ] **Step 5: Update acceptance checklist**

In `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5, change `V1-A05 SSE 心跳/回放/usage/[DONE]` status from `✅ 单测覆盖` to `✅ 完成` and add a brief note.

- [ ] **Step 6: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A05 SSE live verification complete

COMPLETED:
- Live verify SSE heartbeat, role/content deltas, usage chunk, and [DONE] termination.
- Update V1-A05 acceptance status to complete.

TODO:
- Continue A06–A10 live verification.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A05
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 2: A06 Dual Key Isolation and Budget No-Oversell

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/channel.py`, `packages/agent-gateway/src/agent_gateway/store/budget_ledger.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: `config.toml` with two `[[channels]]` entries.
- Produces: Evidence that key A cannot read key B's traces and concurrent reservations do not exceed budget.

- [ ] **Step 1: Add a second channel to `config.toml`**

Add this block at the end of `config.toml` (gitignored file, safe to edit locally):

```toml
[[channels]]
key = "second-test-key"
client_id = "test-client"
workspace_id = "default"
channel_id = "second-test"
allowed_models = ["agent-auto"]
cloud_egress_allowed = false
monthly_budget_micro_usd = 100_000
```

- [ ] **Step 2: Restart the gateway**

```bash
pkill -f "python -m agent_gateway"
sleep 1
cd packages/agent-gateway
DEEPSEEK_BASE_URL="https://api.deepseek.com/v1" \
DEEPSEEK_API_KEY="<DEEPSEEK_API_KEY>" \
DEEPSEEK_MODEL="deepseek-v4-flash" \
nohup uv run python -m agent_gateway --config config.toml > /tmp/agent-gateway.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:8787/healthz
```

Expected: `{"status":"ok"}`.

- [ ] **Step 3: Verify models list is filtered per key**

```bash
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer lobster-local-key" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))'
curl -s http://127.0.0.1:8787/v1/models -H "Authorization: Bearer second-test-key" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))'
```

Expected: first returns 2, second returns 1.

- [ ] **Step 4: Create traces with both keys**

```bash
# Key 1
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"hello from key1"}],"max_tokens":32}'

# Key 2
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer second-test-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"hello from key2"}],"max_tokens":32}'
```

- [ ] **Step 5: Verify cross-key trace isolation**

Extract both trace IDs from the responses, then:

```bash
TRACE1=<id-from-key1>
TRACE2=<id-from-key2>
curl -s http://127.0.0.1:8787/internal/traces/$TRACE1 -H "Authorization: Bearer second-test-key" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state","not-found"))'
curl -s http://127.0.0.1:8787/internal/traces/$TRACE2 -H "Authorization: Bearer lobster-local-key" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state","not-found"))'
```

Expected: both return 404 (or `not-found` from the script because the error body is not `state`).

- [ ] **Step 6: Verify budget no-oversell**

Create a small script that fires 5 concurrent requests against the second key with a $0.10 budget and confirms no reservation exceeds the cap:

```bash
python3 - << 'PY'
import asyncio, httpx

async def reserve(i):
    async with httpx.AsyncClient() as c:
        r = await c.post(
            'http://127.0.0.1:8787/v1/chat/completions',
            headers={'Authorization': 'Bearer second-test-key'},
            json={'model': 'agent-auto', 'messages': [{'role': 'user', 'content': f'req {i}'}], 'max_tokens': 32}
        )
        return r.status_code, r.json().get('error', {}).get('code', 'ok')

results = asyncio.run(asyncio.gather(*[reserve(i) for i in range(5)]))
print(results)
assert all(status == 200 or code == 'budget_exceeded' for status, code in results)
print('A06 budget no-oversell verified')
PY
```

Expected: mix of `200` and `budget_exceeded`, with at most the budgeted number of 200s.

- [ ] **Step 7: Record and update checklist**

Append the result to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A06.

- [ ] **Step 8: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A06 dual key isolation and budget no-oversell live verification complete

COMPLETED:
- Add second-test-key channel to local config.toml and verify models list filtering.
- Verify cross-key trace reads return 404.
- Verify concurrent reservations against small budget do not oversell.

TODO:
- Continue A07–A10 live verification.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A06
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 3: A07 Idempotency Replay and 409 Conflict

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/store/trace_store.py`, `packages/agent-gateway/src/agent_gateway/api/chat.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: `Idempotency-Key` header on `POST /v1/chat/completions`.
- Produces: Same response for same key+digest; 409 for different digest; 409 for in-flight collision.

- [ ] **Step 1: Send identical request with Idempotency-Key twice**

```bash
IDEM_KEY="idem-$(uuidgen)"
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"幂等测试"}],"max_tokens":32}' > /tmp/idem1.json

curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"幂等测试"}],"max_tokens":32}' > /tmp/idem2.json
```

- [ ] **Step 2: Verify replay returns identical response**

```bash
python3 - << 'PY'
import json
a = json.load(open('/tmp/idem1.json'))
b = json.load(open('/tmp/idem2.json'))
assert a['id'] == b['id'], 'trace id should match'
assert a['choices'][0]['message']['content'] == b['choices'][0]['message']['content']
print('A07 idempotent replay verified')
PY
```

Expected: `A07 idempotent replay verified`.

- [ ] **Step 3: Verify different digest with same key returns 409**

```bash
curl -s -o /tmp/idem3.json -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Idempotency-Key: $IDEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"different content"}],"max_tokens":32}'
```

Expected status: `409` and body `error.code == idempotency_conflict`.

- [ ] **Step 4: Record and update checklist**

Append to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A07.

- [ ] **Step 5: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A07 idempotency replay and conflict live verification complete

COMPLETED:
- Live verify idempotent replay with same key+digest.
- Verify 409 idempotency_conflict on same key with different digest.
- Update V1-A07 acceptance status.

TODO:
- Continue A08–A10 live verification.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A07
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 4: A08 Client Disconnect Cancellation and Slot Release

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/cancellation.py`, `packages/agent-gateway/src/agent_gateway/api/chat.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: Streaming request with `stream: true`; client disconnects mid-stream.
- Produces: Trace state `cancelled`; subsequent request succeeds (slot released).

- [ ] **Step 1: Start a slow streaming request and abort it**

Use a long prompt or `max_tokens` to create a slow local call, then abort the curl:

```bash
curl -N -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agent-auto",
    "messages": [{"role": "user", "content": "请详细解释量子计算的原理，尽量展开"}],
    "stream": true,
    "max_tokens": 512
  }' > /tmp/a08-stream.log &
CURL_PID=$!
sleep 1
kill $CURL_PID
wait $CURL_PID 2>/dev/null
```

- [ ] **Step 2: Verify the trace is cancelled**

Find the latest trace ID from the database and check its state:

```bash
sqlite3 packages/agent-gateway/var/agent_gateway.db \
  "SELECT trace_id, state FROM request_executions ORDER BY id DESC LIMIT 1;"
```

Expected: `state == cancelled`.

- [ ] **Step 3: Verify slot is released**

Immediately send another request; it should succeed without hanging:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"agent-auto","messages":[{"role":"user","content":"slot released?"}],"max_tokens":32}'
```

Expected: 200 OK with a normal response.

- [ ] **Step 4: Record and update checklist**

Append to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A08.

- [ ] **Step 5: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A08 client disconnect cancellation and slot release live verification complete

COMPLETED:
- Live abort a streaming request and verify trace state becomes cancelled.
- Verify a subsequent request succeeds, proving the omlx concurrency slot was released.
- Update V1-A08 acceptance status.

TODO:
- Continue A09–A10 live verification.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A08
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 5: A09 Restart Lease Recovery and No Duplicate Cloud Calls

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/store/trace_store.py`, `packages/agent_gateway/main.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: `request_executions` and `model_runs` tables with an in-flight trace before restart.
- Produces: Abandoned leases after restart; 0 new ModelRuns from recovery.

- [ ] **Step 1: Create an in-flight trace by disconnecting mid-request**

Repeat the abort technique from Task 4 to leave a `leased` or `run_started` trace.

- [ ] **Step 2: Stop the gateway**

```bash
pkill -f "python -m agent_gateway"
```

- [ ] **Step 3: Restart the gateway and check recovery**

```bash
cd packages/agent-gateway
DEEPSEEK_BASE_URL="https://api.deepseek.com/v1" \
DEEPSEEK_API_KEY="<DEEPSEEK_API_KEY>" \
DEEPSEEK_MODEL="deepseek-v4-flash" \
nohup uv run python -m agent_gateway --config config.toml > /tmp/agent-gateway.log 2>&1 &
sleep 3
```

- [ ] **Step 4: Verify the pre-restart trace was abandoned and no new ModelRuns created**

```bash
python3 - << 'PY'
import subprocess, sqlite3
# Count ModelRuns created after recovery (none expected)
db = 'packages/agent-gateway/var/agent_gateway.db'
out = subprocess.check_output(['sqlite3', db, 'SELECT COUNT(*) FROM model_runs WHERE purpose="recovery"'])
assert int(out.strip()) == 0, 'recovery must not create model runs'
# Check the old trace is abandoned
out2 = subprocess.check_output(['sqlite3', db, 'SELECT state FROM request_executions ORDER BY id DESC LIMIT 1'])
assert out2.strip() in (b'abandoned', b'cancelled'), f'unexpected state {out2}'
print('A09 lease recovery verified')
PY
```

Expected: `A09 lease recovery verified`.

- [ ] **Step 5: Record and update checklist**

Append to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A09.

- [ ] **Step 6: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A09 restart lease recovery and no duplicate cloud calls live verification complete

COMPLETED:
- Leave an in-flight trace, restart gateway, verify old trace becomes abandoned.
- Verify recovery produces zero new ModelRuns.
- Update V1-A09 acceptance status.

TODO:
- Continue A10 live verification.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A09
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 6: A10 Sensitive Data Does Not Leave Cloud or Enter DB

**Files:**
- Read: `packages/agent-gateway/src/agent_gateway/security/dlp.py`, `packages/agent-gateway/src/agent_gateway/api/chat.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: Request containing a synthetic secret (AWS AKID pattern or PEM header) and cloud egress enabled.
- Produces: 400 `cloud_egress_forbidden` and no secret in DB/WAL/log.

- [ ] **Step 1: Send a request with a synthetic secret**

Use a fake AWS access key ID pattern that matches the default DLP:

```bash
SECRET="AKIAIOSFODNN7EXAMPLE"
curl -s -o /tmp/a10.json -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"agent-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"analyze this key $SECRET\"}],\"max_tokens\":32}"
```

Expected status: `400` and body `error.code == cloud_egress_forbidden` (because the secret triggers DLP when the local result would escalate to cloud).

Note: To trigger cloud egress, first ensure the request causes a quality gate failure (e.g., `max_tokens: 1`) so that the gateway attempts escalation; DLP should then block it.

```bash
SECRET="AKIAIOSFODNN7EXAMPLE"
curl -s -o /tmp/a10.json -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer lobster-local-key" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"agent-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"analyze this key $SECRET\"}],\"max_tokens\":1}"
```

- [ ] **Step 2: Verify the secret is not in the database or WAL files**

```bash
python3 - << 'PY'
import sqlite3, pathlib, subprocess
secret = 'AKIAIOSFODNN7EXAMPLE'
# DB
db = 'packages/agent-gateway/var/agent_gateway.db'
assert secret not in subprocess.check_output(['sqlite3', db, 'SELECT * FROM model_runs UNION ALL SELECT * FROM trace_events']).decode()
# WAL / SHM
for p in pathlib.Path('packages/agent-gateway/var').glob('agent_gateway.db-*'):
    assert secret not in p.read_bytes().decode('latin1', errors='ignore'), f'{p} contains secret'
print('A10 DLP no-secret verified')
PY
```

Expected: `A10 DLP no-secret verified`.

- [ ] **Step 3: Record and update checklist**

Append to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A10.

- [ ] **Step 4: Commit**

```bash
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "docs(agent-gateway): A10 sensitive data does not leave cloud or enter DB live verification complete

COMPLETED:
- Live verify DLP blocks cloud egress for AWS AKID pattern and returns cloud_egress_forbidden.
- Verify the secret string does not appear in DB, WAL, or SHM files.
- Update V1-A10 acceptance status.

TODO:
- Continue A11 fixture completion.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A10
- design/2026-07-18-agent-gateway-live-verification.md"
```


### Task 7: A11 Desensitized Fixture Files

**Files:**
- Create: `packages/agent-gateway/src/agent_gateway/tests/fixtures/quality_invalid_tool.json`, `packages/agent_gateway/src/agent_gateway/tests/fixtures/escalation_body.json`
- Modify: `packages/agent-gateway/src/agent_gateway/tests/unit/test_quality.py`, `packages/agent-gateway/src/agent_gateway/tests/unit/test_escalation.py`
- Test record: `design/2026-07-18-agent-gateway-live-verification.md`

**Interfaces:**
- Consumes: Real-shaped request/response payloads with all sensitive strings replaced by placeholders.
- Produces: Fixture files used by unit tests as golden examples.

- [ ] **Step 1: Create the fixture directory**

```bash
mkdir -p packages/agent-gateway/src/agent_gateway/tests/fixtures
```

- [ ] **Step 2: Write `quality_invalid_tool.json`**

```json
{
  "description": "Tool call with arguments that violate the declared schema (city should be string, not integer). All sensitive values replaced.",
  "envelope": {
    "model": "agent-auto",
    "messages": [{"role": "user", "content": "What's the weather?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
          }
        }
      }
    ]
  },
  "model_result": {
    "content": null,
    "tool_calls": [
      {"id": "call_123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": 12345}"}}
    ],
    "finish_reason": "tool_calls"
  },
  "expected_reason": "invalid_tool_schema"
}
```

- [ ] **Step 3: Write `escalation_body.json`**

```json
{
  "description": "OpenAI-compatible response shape after local omlx fails the quality gate and escalates. Placeholders replace real content and ids.",
  "id": "chatcmpl-PLACEHOLDER",
  "object": "chat.completion",
  "model": "agent-auto",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Cloud fallback content placeholder"},
      "finish_reason": "stop"
    }
  ],
  "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
}
```

- [ ] **Step 4: Add a test that loads the fixture**

Modify `test_quality.py` to add:

```python
import json
from pathlib import Path


def test_quality_fixture_invalid_tool_schema() -> None:
    fixture = Path(__file__).parent.parent / "fixtures" / "quality_invalid_tool.json"
    data = json.loads(fixture.read_text())
    envelope = ChatCompletionEnvelopeV1.model_validate(data["envelope"])
    tool_call = data["model_result"]["tool_calls"][0]
    result = ModelResult(
        content=data["model_result"]["content"],
        tool_calls=(
            ToolCallResult(
                id=tool_call["id"],
                name=tool_call["function"]["name"],
                arguments=tool_call["function"]["arguments"],
            ),
        ),
        finish_reason=data["model_result"]["finish_reason"],
        prompt_tokens=None,
        completion_tokens=None,
        total_tokens=None,
    )
    decision = evaluate_quality(envelope, result)
    assert decision.escalate
    assert decision.reason == REASON_INVALID_TOOL_SCHEMA
```

- [ ] **Step 5: Run the new test and the full suite**

```bash
uv run pytest -q src/agent_gateway/tests/unit/test_quality.py
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 6: Update checklist and record**

Append the fixture creation to `design/2026-07-18-agent-gateway-live-verification.md` and update `design/2026-07-17-agent-gateway-changes-and-decisions.md` §5 for A11.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/tests/fixtures packages/agent-gateway/src/agent_gateway/tests/unit/test_quality.py
# also add any new or modified tests
git add " design/2026-07-18-agent-gateway-live-verification.md" " design/2026-07-17-agent-gateway-changes-and-decisions.md"
git commit -m "feat(agent-gateway): add desensitized fixture files for V1-A11

COMPLETED:
- Create tests/fixtures/quality_invalid_tool.json and escalation_body.json with placeholder values.
- Add test_quality_fixture_invalid_tool_schema to load and verify the invalid tool schema fixture.
- All tests pass.
- Update V1-A11 acceptance status to complete.

TODO:
- Begin Phase 2 minor fixes.

Refer Spec:
- design/2026-07-17-agent-gateway-implementation-plan.md §7 V1-A11
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 7
- design/2026-07-18-agent-gateway-live-verification.md"
```


---

## Phase 2: Code Fixes and Test Gaps

### Task 8: Remove Dead Code `providers/stub.py`

**Files:**
- Delete: `packages/agent-gateway/src/agent_gateway/providers/stub.py`
- Search: confirm no imports reference it.

- [ ] **Step 1: Verify no references**

```bash
grep -rn "from agent_gateway.providers.stub\|import.*stub\|providers.stub" packages/agent-gateway/src/agent_gateway
```

Expected: no matches.

- [ ] **Step 2: Delete the file**

```bash
rm packages/agent-gateway/src/agent_gateway/providers/stub.py
```

- [ ] **Step 3: Run the full suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/providers/stub.py
git commit -m "chore(agent-gateway): remove unused providers/stub.py

COMPLETED:
- Remove Day 2 stub provider that is no longer assembled or referenced.
- Full suite passes.

TODO:
- Fix remaining §4 minor issues.

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 8"
```


### Task 9: Fix §4 Minor 1 — Emit SSE Error Event on Post-First-Byte Provider Failure

**Files:**
- Modify: `packages/agent-gateway/src/agent_gateway/api/chat.py`
- Test: `packages/agent-gateway/src/agent_gateway/tests/unit/test_sse_streaming.py`

**Interfaces:**
- Consumes: `stream_traced_events` generator; `GatewayError` raised after SSE headers sent.
- Produces: A final `data: {"error": ...}` SSE event before terminating the stream.

- [ ] **Step 1: Locate the failure path in `stream_traced_events`**

Find the section after `begin_escalation` where `GatewayError` is caught after the first event has been yielded.

- [ ] **Step 2: Write a failing test**

Add `test_sse_emits_error_event_after_first_byte` in `test_sse_streaming.py`:

```python
async def test_sse_emits_error_event_after_first_byte(
    client: httpx.AsyncClient,
    fake_provider: FakeProvider,
) -> None:
    fake_provider.push(ModelResult(content="first", finish_reason="stop"))
    # Force a cloud escalation that will fail
    # ... configure app state so escalation provider raises GatewayError ...
    resp = await client.post("/v1/chat/completions", json={
        "model": "agent-auto",
        "messages": [{"role": "user", "content": "x"}],
        "stream": True,
        "max_tokens": 1,
    }, headers=auth(KEY_1))
    assert resp.status_code == 200
    lines = resp.text.splitlines()
    error_lines = [ln for ln in lines if 'data:' in ln and '"error"' in ln]
    assert error_lines, "expected an error SSE event"
    payload = json.loads(error_lines[0][6:])
    assert payload["error"]["code"] == "local_quality_rejected"  # or appropriate code
```

- [ ] **Step 3: Implement the fix**

In `api/chat.py`, inside `stream_traced_events` where an exception is caught after the first heartbeat has been sent, yield:

```python
yield format_sse_event({"error": {"code": exc.code, "message": exc.message}})
```

Then re-raise or return as appropriate.

- [ ] **Step 4: Run the test suite**

```bash
uv run pytest -q src/agent_gateway/tests/unit/test_sse_streaming.py
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/api/chat.py packages/agent-gateway/src/agent_gateway/tests/unit/test_sse_streaming.py
git commit -m "fix(agent-gateway): emit SSE error event on post-first-byte provider failure

COMPLETED:
- Yield a data: {error: ...} SSE event before terminating when provider fails after headers sent.
- Add regression test test_sse_emits_error_event_after_first_byte.
- Full suite passes.

TODO:
- Fix remaining §4 minor issues.

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4 minor 1
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 9"
```


### Task 10: Fix §4 Minor 3 — Budget Reconcile/Release Read-Modify-Write CAS

**Files:**
- Modify: `packages/agent-gateway/src/agent_gateway/store/budget_ledger.py`
- Test: `packages/agent-gateway/src/agent_gateway/tests/unit/test_budget_ledger.py`

**Interfaces:**
- Consumes: `BudgetLedger.reconcile` and `release` methods.
- Produces: Methods that use optimistic/versioned updates instead of read-modify-write.

- [ ] **Step 1: Add a version column to the budget ledger schema**

Modify `BudgetReservation` SQLAlchemy model in `store/models.py` to add `version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)`.

- [ ] **Step 2: Add a migration**

Create `packages/agent-gateway/src/agent_gateway/store/migrations/0003_budget_version.py` to add the `version` column to `budget_reservations`.

- [ ] **Step 3: Update `reconcile`/`release` in `budget_ledger.py`**

Use an `UPDATE ... WHERE id = ? AND version = ?` pattern and retry if the row count is 0.

```python
async def reconcile(self, reservation_id: int, used_micro_usd: int) -> None:
    for attempt in range(3):
        row = await self._fetch_reservation(reservation_id)
        if row is None:
            raise BudgetLedgerError("reservation not found")
        if row.state != "reserved":
            raise BudgetLedgerError("reservation already reconciled or released")
        new_used = row.used_micro_usd + used_micro_usd
        new_state = "reconciled" if new_used >= row.reserved_micro_usd else "reserved"
        updated = await self._update_where_version(
            reservation_id,
            version=row.version,
            used_micro_usd=new_used,
            state=new_state,
        )
        if updated:
            return
    raise BudgetLedgerError("concurrent reconcile conflict")
```

Implement `_update_where_version` similarly.

- [ ] **Step 4: Add a concurrency test**

Add `test_concurrent_reconcile_no_double_bill` in `test_budget_ledger.py` that spawns concurrent reconciles and asserts the final used amount is not double-billed.

- [ ] **Step 5: Run the suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/store/models.py packages/agent-gateway/src/agent_gateway/store/budget_ledger.py packages/agent-gateway/src/agent_gateway/store/migrations/0003_budget_version.py packages/agent-gateway/src/agent_gateway/tests/unit/test_budget_ledger.py
git commit -m "fix(agent-gateway): add CAS to budget ledger reconcile/release

COMPLETED:
- Add version column to budget_reservations and migration.
- Update reconcile/release to use UPDATE ... WHERE version = ? with retry.
- Add concurrency regression test.
- Full suite passes.

TODO:
- Fix minor 2 (keyed stream replay) and minor 4 (delivery_status).

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4 minor 3
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 10"
```


### Task 11: Fix §4 Minor 4 — Update `delivery_status` on Client Disconnect

**Files:**
- Modify: `packages/agent-gateway/src/agent_gateway/api/chat.py`, `packages/agent-gateway/src/agent_gateway/cancellation.py`
- Test: `packages/agent_gateway/tests/unit/test_cancellation.py`

**Interfaces:**
- Consumes: `http.disconnect` event.
- Produces: `RequestExecution.delivery_status` set to `aborted` when the client disconnects.

- [ ] **Step 1: Confirm the model field exists**

Check `store/models.py` for `delivery_status` on `RequestExecution`.

- [ ] **Step 2: Update cancellation path**

In `cancellation.py` or `api/chat.py`, when `ClientDisconnected` is caught, call `store.set_delivery_status(trace_id, "aborted")`.

- [ ] **Step 3: Add the store method if missing**

In `store/trace_store.py`, add:

```python
async def set_delivery_status(self, trace_id: str, status: str) -> None:
    async with self.session() as session:
        await session.execute(
            update(RequestExecution)
            .where(RequestExecution.trace_id == trace_id)
            .values(delivery_status=status)
        )
        await session.commit()
```

- [ ] **Step 4: Write a failing test**

Add `test_disconnect_sets_delivery_status_aborted` in `test_cancellation.py` that simulates a disconnect and checks the database.

- [ ] **Step 5: Run the suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/api/chat.py packages/agent-gateway/src/agent_gateway/cancellation.py packages/agent-gateway/src/agent_gateway/store/trace_store.py packages/agent-gateway/src/agent_gateway/tests/unit/test_cancellation.py
git commit -m "fix(agent-gateway): set delivery_status=aborted on client disconnect

COMPLETED:
- Update delivery_status to aborted when http.disconnect is observed.
- Add store method and regression test.
- Full suite passes.

TODO:
- Fix minor 2 (keyed stream replay) and add parallel tool call SSE test.

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4 minor 4
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 11"
```


### Task 12: Fix §4 Minor 2 — Keyed Stream Requests Can Be Replayed

**Files:**
- Modify: `packages/agent-gateway/src/agent_gateway/store/trace_store.py`, `packages/agent_gateway/src/agent_gateway/api/chat.py`
- Test: `packages/agent_gateway/tests/unit/test_idempotency.py`

**Interfaces:**
- Consumes: `Idempotency-Key` on a `stream: true` request.
- Produces: Re-execution allowed when the previous stream ended but no response body was stored.

- [ ] **Step 1: Identify the current behavior**

When a stream request completes, the idempotency key is not released because the response body is not stored. Subsequent requests with the same key return 409.

- [ ] **Step 2: Change the idempotency policy for streams**

In `chat.py`, after a streaming request reaches `response_closed`, call `store.release_idempotency_key(api_key_id, idempotency_key)` for stream requests only.

- [ ] **Step 3: Add a regression test**

Add `test_streaming_idempotent_key_released_after_completion` in `test_idempotency.py` that:
1. Sends a streaming request with `Idempotency-Key`.
2. Completes the stream.
3. Sends the same request again and expects 200 (not 409).

- [ ] **Step 4: Run the suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/store/trace_store.py packages/agent-gateway/src/agent_gateway/api/chat.py packages/agent-gateway/src/agent_gateway/tests/unit/test_idempotency.py
git commit -m "fix(agent-gateway): allow replay of completed keyed stream requests

COMPLETED:
- Release idempotency key for stream requests after response_closed when no body is stored.
- Add regression test.
- Full suite passes.

TODO:
- Add parallel multi-tool-call SSE test.

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4 minor 2
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 12"
```


### Task 13: Add Parallel Multi Tool-Call SSE Delta Replay Test

**Files:**
- Modify: `packages/agent-gateway/src/agent_gateway/tests/unit/test_sse_streaming.py`
- Test: same file

**Interfaces:**
- Consumes: `FakeProvider` configured to return multiple `tool_calls` in one assistant message.
- Produces: SSE chunks with `tool_calls` deltas indexed correctly for each call.

- [ ] **Step 1: Write the failing test**

Add `test_sse_replays_multiple_parallel_tool_calls`:

```python
async def test_sse_replays_multiple_parallel_tool_calls(
    client: httpx.AsyncClient,
    fake_provider: FakeProvider,
) -> None:
    fake_provider.push(
        ModelResult(
            content=None,
            tool_calls=(
                ToolCallResult(id="call_1", name="get_weather", arguments='{"city":"A"}'),
                ToolCallResult(id="call_2", name="get_time", arguments='{}'),
            ),
            finish_reason="tool_calls",
            prompt_tokens=5,
            completion_tokens=10,
            total_tokens=15,
        )
    )
    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "agent-auto",
            "messages": [{"role": "user", "content": "weather and time"}],
            "tools": [
                {"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object"}}},
                {"type": "function", "function": {"name": "get_time", "parameters": {"type": "object"}}},
            ],
            "stream": True,
        },
        headers=auth(KEY_1),
    )
    assert resp.status_code == 200
    chunks = []
    for line in resp.text.splitlines():
        if line.startswith("data: ") and line[6:] != "[DONE]":
            chunks.append(json.loads(line[6:]))
    tool_deltas = [c for c in chunks if c["choices"][0]["delta"].get("tool_calls")]
    assert len(tool_deltas) >= 2, "expected tool call deltas for each parallel call"
    ids = {d["choices"][0]["delta"]["tool_calls"][0]["id"] for d in tool_deltas}
    assert ids == {"call_1", "call_2"}
```

- [ ] **Step 2: Run the test and fix any issues in `sse.py`**

```bash
uv run pytest -q src/agent_gateway/tests/unit/test_sse_streaming.py::test_sse_replays_multiple_parallel_tool_calls
```

If it fails, adjust `sse.py` to ensure multiple tool calls are emitted as separate deltas with correct `index`.

- [ ] **Step 3: Run the full suite**

```bash
uv run pytest -q
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-gateway/src/agent_gateway/tests/unit/test_sse_streaming.py
# include any sse.py changes if needed
git commit -m "test(agent-gateway): add parallel multi-tool-call SSE delta replay test

COMPLETED:
- Add test_sse_replays_multiple_parallel_tool_calls covering P0-03 test gap.
- Fix sse.py if necessary to emit correct parallel tool call deltas.
- Full suite passes.

TODO:
- V1 is now complete; proceed to V1.1 planning.

Refer Spec:
- design/2026-07-17-agent-gateway-changes-and-decisions.md §4 test gap
- design/2026-07-18-agent-gateway-v1-finalization-plan.md Task 13"
```


---

## Self-Review Checklist

- [ ] Spec coverage: Every V1-A05–A11 acceptance item has a task.
- [ ] Placeholder scan: No "TBD", "TODO", or vague steps remain in tasks.
- [ ] Type consistency: `ModelResult`, `ToolCallResult`, `ChatCompletionEnvelopeV1` names match existing codebase usage.
- [ ] Security: No real API keys appear in plan text; placeholders are used.
- [ ] Scope: This plan is V1-only; V1.1 rules learning will be planned separately after V1 closure.

---

## Execution Handoff

Plan complete and saved to `design/2026-07-18-agent-gateway-v1-finalization-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach do you prefer?
