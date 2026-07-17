"""Day 5: quality-gated escalation to the single configured cloud provider.

Precondition order (review P0-04): channel egress + provider enabled, then
structured DLP, then the atomic budget reservation. The escalation attempt
is ModelRun sequence=2 with purpose="escalation".
"""

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_gateway.config import GatewayConfig, load_config
from agent_gateway.errors import GatewayError
from agent_gateway.main import create_app
from agent_gateway.providers.base import ModelResult, ToolCallResult
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.statemachine import RequestState
from agent_gateway.store.budget_ledger import BudgetLedgerError
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import BudgetReservation, ModelRun, RequestExecution, TraceEvent
from agent_gateway.store.trace_store import TraceStore, TraceStoreError

from .conftest import KEY_1, KEY_2
from .test_api import auth, chat_payload
from .test_config import VALID_CONFIG, write_config
from .test_sse_streaming import GatedProvider

WEATHER_TOOL = {
    "type": "function",
    "function": {"name": "get_weather", "parameters": {"type": "object"}},
}


def cloud_payload(**overrides: object) -> dict:
    return chat_payload(model="agent-cloud", **overrides)


def text_result(finish_reason: str = "stop") -> ModelResult:
    return ModelResult(
        content="本地回复",
        tool_calls=None,
        finish_reason=finish_reason,
        prompt_tokens=10,
        completion_tokens=8,
        total_tokens=18,
    )


def cloud_result() -> ModelResult:
    return ModelResult(
        content="云端回复",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=20,
        completion_tokens=9,
        total_tokens=29,
    )


def bad_tool_result() -> ModelResult:
    return ModelResult(
        content=None,
        tool_calls=(ToolCallResult(id="call_1", name="get_weather", arguments="{oops"),),
        finish_reason="tool_calls",
        prompt_tokens=None,
        completion_tokens=None,
        total_tokens=None,
    )


def empty_result() -> ModelResult:
    return ModelResult(
        content=None,
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=None,
        completion_tokens=None,
        total_tokens=None,
    )


async def fetch_all(engine: AsyncEngine, model: type) -> list:
    async with create_session_factory(engine)() as session:
        result = await session.execute(select(model))
        return list(result.scalars().all())


ESCALATION_CASES = [
    pytest.param(text_result("length"), {}, "finish_reason_length", id="finish_reason_length"),
    pytest.param(empty_result(), {}, "empty_output", id="empty_output"),
    pytest.param(bad_tool_result(), {"tools": [WEATHER_TOOL]}, "invalid_tool_schema", id="invalid_tool_schema"),
    pytest.param(
        text_result(),
        {
            "tools": [WEATHER_TOOL],
            "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
        },
        "forced_tool_missing",
        id="forced_tool_missing",
    ),
]


@pytest.mark.parametrize("local_result,overrides,reason", ESCALATION_CASES)
async def test_each_gate_escalates_to_cloud(
    client: httpx.AsyncClient,
    app: FastAPI,
    fake_provider: FakeProvider,
    fake_cloud: FakeProvider,
    local_result: ModelResult,
    overrides: dict,
    reason: str,
) -> None:
    fake_provider.push(local_result)
    fake_cloud.push(cloud_result())

    resp = await client.post("/v1/chat/completions", json=cloud_payload(**overrides), headers=auth(KEY_2))
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "云端回复"

    # The same envelope went to the local provider once and the cloud once.
    assert len(fake_provider.received) == 1
    assert len(fake_cloud.received) == 1

    trace_id = resp.json()["id"]
    runs = await fetch_all(app.state.engine, ModelRun)
    assert len(runs) == 2
    primary, escalation = runs
    assert (primary.sequence, primary.purpose, primary.provider, primary.state) == (
        1,
        "primary",
        "omlx",
        "succeeded",
    )
    assert (escalation.sequence, escalation.purpose, escalation.provider, escalation.state) == (
        2,
        "escalation",
        "kimi",
        "succeeded",
    )
    signals = json.loads(escalation.quality_signals_json)
    assert signals["escalation_reason"] == reason

    trace = await app.state.trace_store.get_trace(trace_id)
    assert trace is not None
    assert trace.state == "response_closed"

    # The reservation was reconciled; V1 charges the full reserve amount.
    reservations = await fetch_all(app.state.engine, BudgetReservation)
    assert len(reservations) == 1
    assert reservations[0].state == "reconciled"
    assert reservations[0].reserved_micro_usd == 100_000
    assert reservations[0].charged_micro_usd == 100_000


async def test_accepted_result_does_not_escalate(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    fake_provider.push(text_result())
    resp = await client.post("/v1/chat/completions", json=cloud_payload(), headers=auth(KEY_2))
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "本地回复"
    assert len(fake_cloud.received) == 0
    runs = await fetch_all(app.state.engine, ModelRun)
    assert len(runs) == 1
    assert await fetch_all(app.state.engine, BudgetReservation) == []


async def test_escalation_denied_when_channel_forbids_egress(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    # KEY_1's channel has cloud_egress_allowed = false.
    fake_provider.push(text_result("length"))
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "local_quality_rejected"
    assert len(fake_cloud.received) == 0

    traces = await fetch_all(app.state.engine, RequestExecution)
    assert len(traces) == 1
    assert traces[0].state == "failed"
    assert traces[0].lease_expires_at is None


DISABLED_CLOUD_CONFIG = VALID_CONFIG.replace(
    "[cloud.kimi]\nenabled = true", "[cloud.kimi]\nenabled = false"
)

BUDGET_CONFIG = VALID_CONFIG.replace(
    'channel_id = "ch-b"\n', 'channel_id = "ch-b"\nmonthly_budget_micro_usd = 1\n'
)


async def build_custom_app(
    tmp_path: Path, config_body: str
) -> tuple[FastAPI, httpx.AsyncClient, FakeProvider, FakeProvider]:
    config: GatewayConfig = load_config(write_config(tmp_path, config_body))
    application = await create_app(config)
    local = FakeProvider()
    cloud = FakeProvider()
    application.state.provider = local
    application.state.cloud_provider = cloud
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    )
    return application, client, local, cloud


async def test_escalation_denied_when_cloud_provider_disabled(tmp_path: Path) -> None:
    _app, client, local, cloud = await build_custom_app(tmp_path, DISABLED_CLOUD_CONFIG)
    local.push(text_result("length"))
    cloud.push(cloud_result())
    resp = await client.post("/v1/chat/completions", json=cloud_payload(), headers=auth(KEY_2))
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "local_quality_rejected"
    assert len(cloud.received) == 0
    await client.aclose()


async def test_escalation_denied_when_budget_exceeded(tmp_path: Path) -> None:
    app, client, local, cloud = await build_custom_app(tmp_path, BUDGET_CONFIG)
    local.push(text_result("length"))
    cloud.push(cloud_result())
    resp = await client.post("/v1/chat/completions", json=cloud_payload(), headers=auth(KEY_2))
    assert resp.status_code == 429
    assert resp.json()["error"]["code"] == "budget_exceeded"
    assert len(cloud.received) == 0

    traces = await fetch_all(app.state.engine, RequestExecution)
    assert traces[0].state == "failed"
    assert await fetch_all(app.state.engine, BudgetReservation) == []
    await client.aclose()


async def test_dlp_blocks_egress_and_never_persists_secret(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    secret = "AKIAIOSFODNN7EXAMPLE"
    fake_provider.push(text_result("length"))
    fake_cloud.push(cloud_result())
    payload = cloud_payload(messages=[{"role": "user", "content": f"use key {secret} please"}])
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_2))
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "cloud_egress_forbidden"
    assert len(fake_cloud.received) == 0

    traces = await fetch_all(app.state.engine, RequestExecution)
    assert traces[0].state == "failed"
    events = await fetch_all(app.state.engine, TraceEvent)
    dlp_events = [event for event in events if event.event_type == "dlp_blocked"]
    assert len(dlp_events) == 1
    payload_json = json.loads(dlp_events[0].payload_json)
    assert payload_json["findings"] == [
        {"pattern": "aws_access_key_id", "location": "messages[0].content"}
    ]

    # The secret itself must not appear in any stored row of any table.
    async with create_session_factory(app.state.engine)() as session:
        for table in (
            RequestExecution.__table__,
            ModelRun.__table__,
            TraceEvent.__table__,
            BudgetReservation.__table__,
        ):
            rows = (await session.execute(select(table))).mappings().all()
            for row in rows:
                assert secret not in json.dumps(dict(row), default=str)


async def test_cloud_failure_releases_reservation(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    fake_provider.push(text_result("length"))
    fake_cloud.push(GatewayError("upstream_unavailable", "cloud down"))
    resp = await client.post("/v1/chat/completions", json=cloud_payload(), headers=auth(KEY_2))
    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "upstream_unavailable"

    runs = await fetch_all(app.state.engine, ModelRun)
    assert len(runs) == 2
    assert (runs[1].sequence, runs[1].purpose, runs[1].provider, runs[1].state) == (
        2,
        "escalation",
        "kimi",
        "failed",
    )
    assert runs[1].error_code == "upstream_unavailable"

    reservations = await fetch_all(app.state.engine, BudgetReservation)
    assert len(reservations) == 1
    assert reservations[0].state == "released"
    assert reservations[0].charged_micro_usd == 0

    traces = await fetch_all(app.state.engine, RequestExecution)
    assert traces[0].state == "failed"


class FailOnFailedTransition:
    """TraceStore wrapper whose fail-transition raises, simulating a dead DB
    exactly on the rejection path."""

    def __init__(self, inner: TraceStore) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)

    async def transition(self, trace_id: str, *, to_state: RequestState, **kwargs: object) -> object:
        if to_state == RequestState.failed:
            raise TraceStoreError("disk on fire")
        return await self._inner.transition(trace_id, to_state=to_state, **kwargs)  # type: ignore[arg-type]


async def test_escalation_rejection_fails_closed_when_store_dies(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    app.state.trace_store = FailOnFailedTransition(app.state.trace_store)
    fake_provider.push(text_result("length"))
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
    assert len(fake_cloud.received) == 0


class FailingLedger:
    """Budget ledger whose reserve raises, simulating a dead DB."""

    async def reserve(self, **_kwargs: object) -> object:
        raise BudgetLedgerError("disk on fire")


async def test_escalation_fails_closed_when_ledger_dies(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    app.state.budget_ledger = FailingLedger()
    fake_provider.push(text_result("length"))
    resp = await client.post("/v1/chat/completions", json=cloud_payload(), headers=auth(KEY_2))
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
    assert len(fake_cloud.received) == 0


def parse_sse_data(body: str) -> list[dict | str]:
    events: list[dict | str] = []
    for line in body.splitlines():
        if line.startswith("data: "):
            payload = line[len("data: ") :]
            events.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    return events


async def test_sse_path_escalates_and_replays_cloud_result(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    fake_provider.push(text_result("length"))
    fake_cloud.push(cloud_result())
    resp = await client.post(
        "/v1/chat/completions",
        json=cloud_payload(stream=True),
        headers=auth(KEY_2),
    )
    assert resp.status_code == 200
    events = parse_sse_data(resp.text)
    assert events[-1] == "[DONE]"
    chunks = [event for event in events[:-1] if isinstance(event, dict)]
    assert chunks[1]["choices"][0]["delta"] == {"content": "云端回复"}

    runs = await fetch_all(app.state.engine, ModelRun)
    assert [(run.sequence, run.purpose, run.provider) for run in runs] == [
        (1, "primary", "omlx"),
        (2, "escalation", "kimi"),
    ]


async def test_sse_path_rejection_returns_json_error_not_stream(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, fake_cloud: FakeProvider
) -> None:
    # KEY_1 forbids egress; the rejection happens before any SSE bytes, so
    # the client gets the stable JSON error body.
    fake_provider.push(text_result("length"))
    resp = await client.post(
        "/v1/chat/completions", json=chat_payload(stream=True), headers=auth(KEY_1)
    )
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["error"]["code"] == "local_quality_rejected"
    assert len(fake_cloud.received) == 0


HEARTBEAT_CONFIG = VALID_CONFIG.replace("[server]\n", "[server]\nsse_heartbeat_seconds = 0.05\n")


async def test_sse_heartbeats_continue_during_escalation_wait(tmp_path: Path) -> None:
    """Heartbeats must cover the whole wait unit (local attempt + cloud
    escalation), not just the local call: the client should see a heartbeat
    while the gated cloud provider is still working."""
    config = load_config(write_config(tmp_path, HEARTBEAT_CONFIG))
    app = await create_app(config)
    app.state.provider = FakeProvider([text_result("length")])  # fails the quality gate
    gate = asyncio.Event()
    app.state.cloud_provider = GatedProvider(gate, cloud_result())

    request_body = json.dumps(cloud_payload(stream=True)).encode()
    # httpx's ASGITransport buffers the whole body, which deadlocks a gated
    # provider; drive the ASGI interface directly (same as test_sse_streaming).
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/chat/completions",
        "raw_path": b"/v1/chat/completions",
        "query_string": b"",
        "headers": [
            (b"authorization", f"Bearer {KEY_2}".encode()),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(request_body)).encode()),
        ],
        "server": ("test", 80),
        "client": ("testclient", 123),
        "root_path": "",
    }
    request_sent = False

    async def receive() -> dict:
        nonlocal request_sent
        if request_sent:
            # Client stays connected; the disconnect watcher is cancelled when
            # the app ends.
            await asyncio.Event().wait()
        request_sent = True
        return {"type": "http.request", "body": request_body, "more_body": False}

    status: int | None = None
    chunks: list[bytes] = []

    async def send(message: dict) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                chunks.append(chunk)
                if b": heartbeat" in chunk:
                    gate.set()  # release the cloud only after a heartbeat arrived

    await asyncio.wait_for(app(scope, receive, send), timeout=10)

    assert status == 200
    lines = b"".join(chunks).decode().splitlines()
    assert ": heartbeat" in lines
    first_heartbeat = lines.index(": heartbeat")
    first_data = next(i for i, line in enumerate(lines) if line.startswith("data: "))
    assert first_heartbeat < first_data
    assert any("云端回复" in line for line in lines)
    assert "data: [DONE]" in lines
    await app.state.engine.dispose()
