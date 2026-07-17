"""End-to-end non-streaming pipeline: state machine, routing, ModelRun persistence."""

import json

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import ModelRun, RequestExecution

from .conftest import KEY_1
from .test_api import auth, chat_payload


def make_result() -> ModelResult:
    return ModelResult(
        content="你好，有什么可以帮你？",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=10,
        completion_tokens=8,
        total_tokens=18,
    )


async def fetch_model_runs(app: FastAPI, trace_id: str) -> list[ModelRun]:
    async with create_session_factory(app.state.engine)() as session:
        result = await session.execute(select(ModelRun).where(ModelRun.trace_id == trace_id))
        return list(result.scalars().all())


async def test_chat_success_full_pipeline(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result())
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert resp.status_code == 200
    body = resp.json()

    # OpenAI-shaped response: logical model name, trace_id as id, usage included.
    assert body["object"] == "chat.completion"
    assert body["model"] == "agent-auto"
    assert body["id"].startswith("chatcmpl-")
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["choices"][0]["message"]["content"] == "你好，有什么可以帮你？"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["usage"] == {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}

    # The provider saw the validated envelope.
    assert len(fake_provider.received) == 1
    assert fake_provider.received[0].model == "agent-auto"

    # Trace walked the full state machine and the lease was cleared.
    trace_id = body["id"]
    trace = await app.state.trace_store.get_trace(trace_id)
    assert trace is not None
    assert trace.state == "response_closed"
    assert trace.completed_at is not None
    assert trace.lease_expires_at is None

    events = await app.state.trace_store.list_events(trace_id)
    assert [event.to_state for event in events] == [
        "received",
        "queued",
        "leased",
        "run_started",
        "run_succeeded",
        "response_started",
        "response_closed",
    ]

    # ModelRun persisted: omlx route, token counts, finish signals.
    runs = await fetch_model_runs(app, trace_id)
    assert len(runs) == 1
    run = runs[0]
    assert run.provider == "omlx"
    assert run.purpose == "primary"
    assert run.sequence == 1
    assert run.state == "succeeded"
    assert run.input_tokens == 10
    assert run.output_tokens == 8
    assert run.usage_source == "provider"
    assert run.error_code is None
    signals = json.loads(run.quality_signals_json)
    assert signals["finish_reason"] == "stop"
    assert signals["has_tool_calls"] is False


@pytest.mark.parametrize("code", ["upstream_unavailable", "provider_invalid_response"])
async def test_provider_failure_returns_502_and_fails_trace(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider, code: str
) -> None:
    fake_provider.push(GatewayError(code, "upstream exploded"))
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == code

    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
        runs = list((await session.execute(select(ModelRun))).scalars().all())

    assert len(traces) == 1
    assert traces[0].state == "failed"
    assert traces[0].completed_at is not None

    assert len(runs) == 1
    assert runs[0].provider == "omlx"
    assert runs[0].state == "failed"
    assert runs[0].error_code == code
