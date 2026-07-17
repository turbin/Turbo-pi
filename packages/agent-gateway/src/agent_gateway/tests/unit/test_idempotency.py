"""Day 5: Idempotency-Key replay on POST /v1/chat/completions (review 5.2).

Unique key: (api_key_id, endpoint, idempotency_key) — V1 has exactly one
endpoint accepting the header. Without the header the endpoint remains
at-least-once. Response bodies are persisted only for keyed requests.
"""

import asyncio
import json

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import ModelRun, RequestExecution

from .conftest import KEY_1, KEY_2
from .test_api import auth, chat_payload


def make_result(content: str = "幂等回复") -> ModelResult:
    return ModelResult(
        content=content,
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=2,
        completion_tokens=3,
        total_tokens=5,
    )


def keyed(key: str, idem: str) -> dict[str, str]:
    return {**auth(key), "Idempotency-Key": idem}


async def count_rows(app: FastAPI, model: type) -> int:
    async with create_session_factory(app.state.engine)() as session:
        result = await session.execute(select(func.count()).select_from(model))
        return int(result.scalar_one())


async def test_same_key_same_body_replays_stored_response(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result())
    first = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-1")
    )
    assert first.status_code == 200

    second = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-1")
    )
    assert second.status_code == 200
    assert second.json() == first.json()

    # No second provider call, no second ModelRun, no second trace.
    assert len(fake_provider.received) == 1
    assert await count_rows(app, ModelRun) == 1
    assert await count_rows(app, RequestExecution) == 1


async def test_same_key_different_body_conflicts(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result())
    first = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-2")
    )
    assert first.status_code == 200

    other = chat_payload(messages=[{"role": "user", "content": "不一样的请求"}])
    second = await client.post("/v1/chat/completions", json=other, headers=keyed(KEY_1, "idem-2"))
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "idempotency_conflict"


async def test_concurrent_duplicate_in_flight_conflicts(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    gate = asyncio.Event()

    class GatedProvider(FakeProvider):
        async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
            self.received.append(envelope)
            await gate.wait()
            return make_result()

    gated = GatedProvider()
    app.state.provider = gated

    first_task = asyncio.create_task(
        client.post("/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-3"))
    )
    while not gated.received:
        await asyncio.sleep(0.01)

    second = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-3")
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "request_in_progress"

    gate.set()
    first = await first_task
    assert first.status_code == 200


async def test_error_response_is_replayed(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(GatewayError("upstream_unavailable", "omlx down"))
    first = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-4")
    )
    assert first.status_code == 502

    second = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-4")
    )
    assert second.status_code == 502
    assert second.json() == first.json()
    assert len(fake_provider.received) == 1
    assert await count_rows(app, ModelRun) == 1


async def test_key_is_scoped_per_api_key(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result("回复一"))
    fake_provider.push(make_result("回复二"))
    first = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-5")
    )
    second = await client.post(
        "/v1/chat/completions",
        json=chat_payload(model="agent-cloud"),
        headers=keyed(KEY_2, "idem-5"),
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] != second.json()["id"]
    assert len(fake_provider.received) == 2


async def test_without_key_is_at_least_once_and_persists_no_body(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result())
    fake_provider.push(make_result())
    first = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    second = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] != second.json()["id"]
    assert len(fake_provider.received) == 2

    # No Idempotency-Key -> response bodies are never persisted.
    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
    assert all(trace.response_body is None for trace in traces)


async def test_keyed_request_persists_body_only_then(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result())
    resp = await client.post(
        "/v1/chat/completions", json=chat_payload(), headers=keyed(KEY_1, "idem-6")
    )
    assert resp.status_code == 200
    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
    assert len(traces) == 1
    assert traces[0].response_status == 200
    assert json.loads(traces[0].response_body) == resp.json()
