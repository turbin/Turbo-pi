import httpx
import pytest

from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider

from .conftest import KEY_1, KEY_2


def auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def chat_payload(**overrides: object) -> dict:
    payload: dict = {
        "model": "agent-auto",
        "messages": [{"role": "user", "content": "你好"}],
    }
    payload.update(overrides)
    return payload


async def test_healthz(client: httpx.AsyncClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_models_requires_auth(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/models")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "invalid_api_key"


async def test_models_rejects_bad_key(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/models", headers=auth("wrong-key"))
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "invalid_api_key"


async def test_models_filtered_by_key(client: httpx.AsyncClient) -> None:
    resp1 = await client.get("/v1/models", headers=auth(KEY_1))
    assert resp1.status_code == 200
    ids1 = {m["id"] for m in resp1.json()["data"]}
    assert ids1 == {"agent-auto", "agent-local"}

    resp2 = await client.get("/v1/models", headers=auth(KEY_2))
    ids2 = {m["id"] for m in resp2.json()["data"]}
    assert ids2 == {"agent-cloud"}


async def test_chat_rejects_bad_key(client: httpx.AsyncClient) -> None:
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth("nope"))
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "invalid_api_key"


async def test_chat_malformed_json_body_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/v1/chat/completions",
        content=b"{not json",
        headers={**auth(KEY_1), "Content-Type": "application/json"},
    )
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "unsupported_parameter"
    assert body["param"] == "body"
    assert body["message"] == "request body is not valid JSON"


async def test_chat_unknown_field_400_with_param(client: httpx.AsyncClient) -> None:
    resp = await client.post("/v1/chat/completions", json=chat_payload(logprobs=True), headers=auth(KEY_1))
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "unsupported_parameter"
    assert body["param"] == "logprobs"


async def test_chat_n_two_400(client: httpx.AsyncClient) -> None:
    resp = await client.post("/v1/chat/completions", json=chat_payload(n=2), headers=auth(KEY_1))
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "unsupported_parameter"
    assert body["param"] == "n"


async def test_chat_max_tokens_conflict_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/v1/chat/completions",
        json=chat_payload(max_tokens=100, max_completion_tokens=100),
        headers=auth(KEY_1),
    )
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "unsupported_parameter"
    assert body["param"] == "max_tokens"


async def test_chat_tool_message_without_tool_call_id_400(client: httpx.AsyncClient) -> None:
    payload = chat_payload()
    payload["messages"].append({"role": "tool", "content": "result"})
    resp = await client.post("/v1/chat/completions", json=payload, headers=auth(KEY_1))
    assert resp.status_code == 400
    body = resp.json()["error"]
    assert body["code"] == "invalid_message_sequence"
    assert body["param"] is not None


async def test_chat_disallowed_model_403(client: httpx.AsyncClient) -> None:
    resp = await client.post("/v1/chat/completions", json=chat_payload(model="agent-cloud"), headers=auth(KEY_1))
    assert resp.status_code == 403
    body = resp.json()["error"]
    assert body["code"] == "model_not_allowed"
    assert body["param"] == "model"


async def test_chat_success_creates_trace_and_echoes_logical_model(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(
        ModelResult(
            content="本地回复",
            tool_calls=None,
            finish_reason="stop",
            prompt_tokens=2,
            completion_tokens=3,
            total_tokens=5,
        )
    )
    resp = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "chat.completion"
    assert body["model"] == "agent-auto"
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["choices"][0]["message"]["content"] == "本地回复"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert "usage" in body

    trace_id = body["id"]
    trace_resp = await client.get(f"/internal/traces/{trace_id}", headers=auth(KEY_1))
    assert trace_resp.status_code == 200
    trace = trace_resp.json()
    assert trace["state"] == "response_closed"
    assert trace["version"] == 6


async def test_internal_trace_requires_auth(client: httpx.AsyncClient) -> None:
    resp = await client.get("/internal/traces/whatever")
    assert resp.status_code == 401


async def test_internal_trace_not_found(client: httpx.AsyncClient) -> None:
    resp = await client.get("/internal/traces/does-not-exist", headers=auth(KEY_1))
    assert resp.status_code == 404
