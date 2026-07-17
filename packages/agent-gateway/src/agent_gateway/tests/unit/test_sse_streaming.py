"""Day 4: delayed SSE replay, tool_call deltas, heartbeats, two-round tool flow."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from agent_gateway.config import GatewayConfig, load_config
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult, ToolCallResult
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import ModelRun, RequestExecution

from .conftest import KEY_1
from .test_api import auth, chat_payload
from .test_config import VALID_CONFIG, write_config

# Small heartbeat interval for the whole module so the heartbeat test does not
# wait 15s; other tests are unaffected because FakeProvider answers instantly.
HEARTBEAT_CONFIG = VALID_CONFIG.replace("[server]\n", "[server]\nsse_heartbeat_seconds = 0.05\n")


@pytest.fixture
def config(tmp_path: Path) -> GatewayConfig:
    return load_config(write_config(tmp_path, HEARTBEAT_CONFIG))


def text_result() -> ModelResult:
    return ModelResult(
        content="你好，世界",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=10,
        completion_tokens=8,
        total_tokens=18,
    )


def tool_result() -> ModelResult:
    return ModelResult(
        content=None,
        tool_calls=(
            ToolCallResult(id="call_1", name="get_weather", arguments='{"city":"北京"}'),
        ),
        finish_reason="tool_calls",
        prompt_tokens=12,
        completion_tokens=6,
        total_tokens=18,
    )


def parse_sse(body: str) -> tuple[list[str], list[dict | str]]:
    """Split an SSE body into comment lines and parsed data payloads."""
    comments: list[str] = []
    events: list[dict | str] = []
    for line in body.splitlines():
        if line.startswith(": "):
            comments.append(line[2:])
        elif line.startswith("data: "):
            payload = line[len("data: ") :]
            events.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    return comments, events


async def fetch_runs(app: FastAPI, trace_id: str) -> list[ModelRun]:
    async with create_session_factory(app.state.engine)() as session:
        result = await session.execute(select(ModelRun).where(ModelRun.trace_id == trace_id))
        return list(result.scalars().all())


async def test_sse_happy_path_chunk_sequence(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(text_result())
    resp = await client.post(
        "/v1/chat/completions", json=chat_payload(stream=True), headers=auth(KEY_1)
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/event-stream"
    assert resp.headers["cache-control"] == "no-cache"

    comments, events = parse_sse(resp.text)
    assert comments == []
    assert events[-1] == "[DONE]"
    chunks = [event for event in events[:-1] if isinstance(event, dict)]

    assert all(chunk["object"] == "chat.completion.chunk" for chunk in chunks)
    assert all(chunk["model"] == "agent-auto" for chunk in chunks)
    trace_id = chunks[0]["id"]
    assert trace_id.startswith("chatcmpl-")
    assert all(chunk["id"] == trace_id for chunk in chunks)

    # role chunk -> content chunk -> finish chunk; no usage chunk unless requested.
    assert len(chunks) == 3
    assert chunks[0]["choices"] == [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]
    assert chunks[1]["choices"] == [
        {"index": 0, "delta": {"content": "你好，世界"}, "finish_reason": None}
    ]
    assert chunks[2]["choices"] == [{"index": 0, "delta": {}, "finish_reason": "stop"}]
    assert all("usage" not in chunk for chunk in chunks)

    # The trace walked the same state machine as the non-streaming path.
    trace = await app.state.trace_store.get_trace(trace_id)
    assert trace is not None
    assert trace.state == "response_closed"
    assert trace.lease_expires_at is None
    trace_events = await app.state.trace_store.list_events(trace_id)
    assert [event.to_state for event in trace_events] == [
        "received",
        "queued",
        "leased",
        "run_started",
        "run_succeeded",
        "response_started",
        "response_closed",
    ]
    runs = await fetch_runs(app, trace_id)
    assert len(runs) == 1
    assert runs[0].state == "succeeded"
    assert runs[0].provider == "omlx"


async def test_sse_include_usage_emits_usage_chunk(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(text_result())
    payload = chat_payload(stream=True, stream_options={"include_usage": True})
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 200

    _, events = parse_sse(resp.text)
    assert events[-1] == "[DONE]"
    chunks = [event for event in events[:-1] if isinstance(event, dict)]
    # role, content, finish, usage
    assert len(chunks) == 4
    usage_chunk = chunks[-1]
    assert chunks[-2]["choices"][0]["finish_reason"] == "stop"
    assert usage_chunk["choices"] == []
    assert usage_chunk["usage"] == {
        "prompt_tokens": 10,
        "completion_tokens": 8,
        "total_tokens": 18,
    }


async def test_sse_tool_call_deltas(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(tool_result())
    payload = chat_payload(
        stream=True,
        tools=[
            {
                "type": "function",
                "function": {"name": "get_weather", "parameters": {"type": "object"}},
            }
        ],
    )
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 200

    _, events = parse_sse(resp.text)
    chunks = [event for event in events[:-1] if isinstance(event, dict)]
    # role chunk -> tool_call delta -> finish chunk
    assert len(chunks) == 3
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    tool_calls = chunks[1]["choices"][0]["delta"]["tool_calls"]
    assert len(tool_calls) == 1
    delta = tool_calls[0]
    assert delta["index"] == 0
    assert delta["id"] == "call_1"
    assert delta["type"] == "function"
    assert delta["function"]["name"] == "get_weather"
    assert delta["function"]["arguments"] == '{"city":"北京"}'
    assert chunks[2]["choices"][0]["finish_reason"] == "tool_calls"


class GatedProvider(FakeProvider):
    """FakeProvider whose complete() blocks until the test opens the gate."""

    def __init__(self, gate: asyncio.Event, result: ModelResult) -> None:
        super().__init__()
        self._gate = gate
        self._result = result

    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        self.received.append(envelope)
        await self._gate.wait()
        return self._result


async def test_sse_heartbeat_arrives_before_content(app: FastAPI) -> None:
    gate = asyncio.Event()
    app.state.provider = GatedProvider(gate, text_result())
    request_body = json.dumps(chat_payload(stream=True)).encode()

    # httpx's ASGITransport buffers the whole response body before returning,
    # which deadlocks a gated provider; drive the ASGI interface directly so
    # body chunks are observed as the app sends them.
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
            (b"authorization", f"Bearer {KEY_1}".encode()),
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
            # Client stays connected: block forever (Day 5 polls receive for
            # disconnects; the watcher task is cancelled when the app ends).
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
                    gate.set()

    await app(scope, receive, send)

    assert status == 200
    lines = b"".join(chunks).decode().splitlines()
    assert ": heartbeat" in lines
    first_heartbeat = lines.index(": heartbeat")
    first_data = next(i for i, line in enumerate(lines) if line.startswith("data: "))
    assert first_heartbeat < first_data
    assert "data: [DONE]" in lines


async def test_sse_provider_failure_returns_json_error_not_stream(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(GatewayError("upstream_unavailable", "omlx down"))
    resp = await client.post(
        "/v1/chat/completions", json=chat_payload(stream=True), headers=auth(KEY_1)
    )
    # The provider failed before replay started, so the client (which has not
    # received any SSE bytes yet) gets the stable JSON error body.
    assert resp.status_code == 502
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["error"]["code"] == "upstream_unavailable"

    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
        runs = list((await session.execute(select(ModelRun))).scalars().all())
    assert len(traces) == 1
    assert traces[0].state == "failed"
    assert len(runs) == 1
    assert runs[0].state == "failed"
    assert runs[0].error_code == "upstream_unavailable"


def two_round_payload(**overrides: object) -> dict:
    payload = chat_payload(
        messages=[
            {"role": "user", "content": "北京今天天气？"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city":"北京"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "晴，25C"},
        ],
        tools=[
            {
                "type": "function",
                "function": {"name": "get_weather", "parameters": {"type": "object"}},
            }
        ],
    )
    payload.update(overrides)
    return payload


async def test_two_round_tool_flow_reaches_provider(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(text_result())
    resp = await client.post("/v1/chat/completions", json=two_round_payload(), headers=auth(KEY_1))
    assert resp.status_code == 200

    assert len(fake_provider.received) == 1
    envelope = fake_provider.received[0]
    assistant = envelope.messages[1]
    tool = envelope.messages[2]
    assert assistant.role == "assistant"
    assert assistant.tool_calls is not None
    assert assistant.tool_calls[0].id == "call_1"
    assert tool.role == "tool"
    assert tool.tool_call_id == "call_1"


async def test_tool_message_without_preceding_tool_calls_400(client: httpx.AsyncClient) -> None:
    payload = chat_payload(
        messages=[
            {"role": "user", "content": "hi"},
            {"role": "tool", "tool_call_id": "call_1", "content": "晴"},
        ]
    )
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_message_sequence"


async def test_tool_message_tool_call_id_mismatch_400(client: httpx.AsyncClient) -> None:
    payload = two_round_payload()
    payload["messages"][2]["tool_call_id"] = "call_other"
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_message_sequence"


async def test_tool_message_separated_from_assistant_400(client: httpx.AsyncClient) -> None:
    payload = two_round_payload()
    # A user message between the assistant tool_calls and the tool result
    # breaks the required adjacency.
    payload["messages"].insert(2, {"role": "user", "content": "等等"})
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_message_sequence"


async def test_non_streaming_tool_calls_echoed(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(tool_result())
    resp = await client.post(
        "/v1/chat/completions",
        json=chat_payload(
            tools=[{"type": "function", "function": {"name": "get_weather"}}],
            tool_choice={"type": "function", "function": {"name": "get_weather"}},
        ),
        headers=auth(KEY_1),
    )
    assert resp.status_code == 200
    message = resp.json()["choices"][0]["message"]
    assert message["tool_calls"] == [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "get_weather", "arguments": '{"city":"北京"}'},
        }
    ]
    assert resp.json()["choices"][0]["finish_reason"] == "tool_calls"


async def test_forced_tool_missing_signal_recorded(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    # tool_choice forces get_weather, but the provider answers with plain text.
    fake_provider.push(text_result())
    resp = await client.post(
        "/v1/chat/completions",
        json=chat_payload(
            tools=[{"type": "function", "function": {"name": "get_weather"}}],
            tool_choice={"type": "function", "function": {"name": "get_weather"}},
        ),
        headers=auth(KEY_1),
    )
    # Day 5: the quality gate escalates on this signal; KEY_1's channel
    # forbids cloud egress, so the request is rejected (no cloud call).
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "local_quality_rejected"
    async with create_session_factory(app.state.engine)() as session:
        traces = list((await session.execute(select(RequestExecution))).scalars().all())
    assert len(traces) == 1
    assert traces[0].state == "failed"
    runs = await fetch_runs(app, traces[0].trace_id)
    assert len(runs) == 1
    signals = json.loads(runs[0].quality_signals_json)
    assert signals["forced_tool_missing"] is True


async def test_forced_tool_present_signal_not_set(
    client: httpx.AsyncClient, app: FastAPI, fake_provider: FakeProvider
) -> None:
    fake_provider.push(tool_result())
    resp = await client.post(
        "/v1/chat/completions",
        json=chat_payload(
            tools=[{"type": "function", "function": {"name": "get_weather"}}],
            tool_choice={"type": "function", "function": {"name": "get_weather"}},
        ),
        headers=auth(KEY_1),
    )
    assert resp.status_code == 200
    runs = await fetch_runs(app, resp.json()["id"])
    signals = json.loads(runs[0].quality_signals_json)
    assert signals["forced_tool_missing"] is False
