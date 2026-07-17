# agent-gateway

Local Agent model gateway. FastAPI server exposing an OpenAI-compatible API
(`/v1/chat/completions`, `/v1/models`) that routes requests to a local model
server (omlx) with quality-gated escalation to a single cloud provider.

This package is intentionally independent from the TypeScript packages in this
monorepo. Python 3.12, deps managed with `uv`.

## Setup

```bash
uv sync
cp config.example.toml config.toml  # edit channels/keys
```

## Test

```bash
uv run pytest
```

## Run

```bash
uv run python -m agent_gateway                      # uses ./config.toml
uv run python -m agent_gateway --config <path>      # explicit config path
```

The entry point takes the `server.single_worker_lock` file lock (non-blocking)
and exits with an error if another gateway process already holds it — SQLite
allows a single writer, so only one gateway may run against the database.
It then serves uvicorn on `server.host`/`server.port`.

## Layout

- `__main__.py` — console entry point (config load, single-worker lock, uvicorn)
- `config.py` — TOML config loading with fail-fast validation
- `channel.py` — API key -> ChannelContext mapping
- `envelope.py` — `ChatCompletionEnvelopeV1` request contract
- `quality.py` — observable-only quality gates (accept or escalate with reason)
- `routing.py` — provider routing decision (local omlx; single configured cloud)
- `cancellation.py` — client-disconnect cancellation of in-flight upstream calls
- `security/` — structured DLP scan and redaction helpers for cloud egress
- `store/` — SQLAlchemy async engine, ORM models, Alembic migrations, trace store, budget ledger
- `statemachine.py` — request trace state machine (`received` -> ... -> terminal)
- `api/` — routers (`/healthz`, `/v1/models`, `/v1/chat/completions`, internal traces)
- `providers/` — provider seam: omlx (local), kimi (cloud), fake (tests)

## Behavior notes

- Escalation: observable gate failure retries the same envelope once against
  `routing.selected_cloud_provider`, after channel-egress, DLP, and budget
  checks (422 `local_quality_rejected` / 403 `cloud_egress_forbidden` /
  429 `budget_exceeded` on failure).
- `Idempotency-Key` on `/v1/chat/completions`: same key + same body replays
  the stored response; different body -> 409 `idempotency_conflict`; a
  duplicate key still in flight -> 409 `request_in_progress`. Without the
  header the endpoint is at-least-once. Response bodies are persisted only
  for keyed, non-streaming requests.
- `/internal/traces/{trace_id}` is scoped to the caller's API key; foreign
  traces return 404.
