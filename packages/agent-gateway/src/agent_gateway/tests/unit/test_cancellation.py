"""Day 5: client-disconnect cancellation (review 5.2).

Driven through the raw ASGI interface like the heartbeat test: after the
request body, receive() reports http.disconnect, which must cancel the
in-flight upstream call, release the omlx semaphore slot, and move the
trace to cancelled. Nothing is written to the gone client.
"""

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from agent_gateway.providers.omlx import OmlxProvider
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import ModelRun, RequestExecution

from .conftest import KEY_1
from .test_api import auth, chat_payload

OMLX_BODY = {
    "id": "chatcmpl-upstream-1",
    "object": "chat.completion",
    "created": 1750000000,
    "model": "test-model",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "ok"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


def blocking_provider(calls: list[int]) -> OmlxProvider:
    """omlx provider (concurrency=1) whose first call blocks forever."""

    async def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            await asyncio.Event().wait()  # released only by gateway cancellation
        return httpx.Response(200, json=OMLX_BODY)

    return OmlxProvider(model="test-model", concurrency=1, transport=httpx.MockTransport(handler))


def make_scope(request_body: bytes) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/chat/completions",
        "raw_path": b"/v1/chat/completions",
        "query_string": b"",
        "headers": [
            (b"authorization", f"Bearer {KEY_1}".encode()),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(request_body)).encode()),
        ],
        "server": ("test", 80),
        "client": ("testclient", 123),
        "root_path": "",
    }


def disconnecting_receive(request_body: bytes):  # type: ignore[no-untyped-def]
    request_sent = False

    async def receive() -> dict:
        nonlocal request_sent
        if request_sent:
            return {"type": "http.disconnect"}
        request_sent = True
        return {"type": "http.request", "body": request_body, "more_body": False}

    return receive


async def fetch_trace_and_runs(app: FastAPI) -> tuple[RequestExecution, list[ModelRun]]:
    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
        runs = list((await session.execute(select(ModelRun))).scalars().all())
    assert len(traces) == 1
    return traces[0], runs


async def test_disconnect_mid_upstream_cancels_and_releases_semaphore(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    calls: list[int] = []
    app.state.provider = blocking_provider(calls)
    request_body = json.dumps(chat_payload()).encode()
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    # The endpoint aborts without writing any response to the gone client.
    with pytest.raises(asyncio.CancelledError):
        await app(make_scope(request_body), disconnecting_receive(request_body), send)
    assert sent == []

    trace, runs = await fetch_trace_and_runs(app)
    assert trace.state == "cancelled"
    assert trace.lease_expires_at is None
    assert trace.completed_at is not None
    assert len(runs) == 1
    assert runs[0].state == "cancelled"
    assert runs[0].error_code == "client_cancelled"

    # The semaphore slot was released: a follow-up request proceeds.
    follow_up = await asyncio.wait_for(
        client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1)),
        timeout=10,
    )
    assert follow_up.status_code == 200
    assert follow_up.json()["choices"][0]["message"]["content"] == "ok"
    assert len(calls) == 2


async def test_disconnect_mid_upstream_cancels_sse_path(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    calls: list[int] = []
    app.state.provider = blocking_provider(calls)
    request_body = json.dumps(chat_payload(stream=True)).encode()
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    # The SSE generator stops silently; no error payload is written.
    await app(make_scope(request_body), disconnecting_receive(request_body), send)

    trace, runs = await fetch_trace_and_runs(app)
    assert trace.state == "cancelled"
    assert trace.lease_expires_at is None
    assert len(runs) == 1
    assert runs[0].state == "cancelled"
    assert runs[0].error_code == "client_cancelled"

    # The semaphore slot was released here too.
    follow_up = await asyncio.wait_for(
        client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1)),
        timeout=10,
    )
    assert follow_up.status_code == 200
