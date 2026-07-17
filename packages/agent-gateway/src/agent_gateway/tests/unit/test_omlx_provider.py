"""OmlxProvider: envelope translation, response parsing, error mapping, concurrency."""

import asyncio
import json

import httpx
import pytest

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ToolCallResult
from agent_gateway.providers.omlx import OmlxProvider, build_chat_request, parse_chat_response

GOOD_RESPONSE_BODY = {
    "id": "chatcmpl-upstream-1",
    "object": "chat.completion",
    "created": 1750000000,
    "model": "gemma-4-12b-it-4bit",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "你好！有什么可以帮你？"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10},
}


def make_envelope(**overrides: object) -> ChatCompletionEnvelopeV1:
    payload: dict = {"model": "agent-auto", "messages": [{"role": "user", "content": "你好"}]}
    payload.update(overrides)
    return ChatCompletionEnvelopeV1.model_validate(payload)


def make_provider(handler: object, *, concurrency: int = 1) -> OmlxProvider:
    return OmlxProvider(
        base_url="http://omlx.test/v1",
        model="gemma-4-12b-it-4bit",
        timeout_seconds=5,
        concurrency=concurrency,
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )


# --- build_chat_request (pure translation, no network) ---


def test_build_request_translates_messages_tools_and_params() -> None:
    envelope = make_envelope(
        messages=[
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "查一下北京天气"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
                    }
                ],
            },
            {"role": "tool", "content": "晴，25度", "tool_call_id": "call_1"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "查询天气",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ],
        tool_choice="auto",
        max_tokens=256,
        temperature=0.2,
    )
    body = build_chat_request(envelope, model="gemma-4-12b-it-4bit")

    assert body["model"] == "gemma-4-12b-it-4bit"
    messages = body["messages"]
    assert messages[0] == {"role": "system", "content": "你是助手"}
    assert messages[1] == {"role": "user", "content": "查一下北京天气"}
    assert messages[2]["role"] == "assistant"
    assert "content" not in messages[2]
    assert messages[2]["tool_calls"] == [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
        }
    ]
    assert messages[3] == {"role": "tool", "content": "晴，25度", "tool_call_id": "call_1"}
    assert body["tools"][0]["type"] == "function"
    assert body["tools"][0]["function"]["name"] == "get_weather"
    assert body["tool_choice"] == "auto"
    assert body["max_tokens"] == 256
    assert body["temperature"] == 0.2


def test_build_request_named_tool_choice() -> None:
    envelope = make_envelope(
        tool_choice={"type": "function", "function": {"name": "get_weather"}},
        tools=[{"type": "function", "function": {"name": "get_weather"}}],
    )
    body = build_chat_request(envelope, model="m")
    assert body["tool_choice"] == {"type": "function", "function": {"name": "get_weather"}}


def test_build_request_maps_max_completion_tokens_to_max_tokens() -> None:
    body = build_chat_request(make_envelope(max_completion_tokens=64), model="m")
    assert body["max_tokens"] == 64


def test_build_request_omits_unset_optionals() -> None:
    body = build_chat_request(make_envelope(), model="m")
    assert "tools" not in body
    assert "tool_choice" not in body
    assert "max_tokens" not in body
    assert "temperature" not in body


# --- parse_chat_response (pure parsing) ---


def test_parse_response_text_finish_reason_and_usage() -> None:
    result = parse_chat_response(GOOD_RESPONSE_BODY)
    assert result.content == "你好！有什么可以帮你？"
    assert result.tool_calls is None
    assert result.finish_reason == "stop"
    assert result.prompt_tokens == 4
    assert result.completion_tokens == 6
    assert result.total_tokens == 10


def test_parse_response_tool_calls() -> None:
    result = parse_chat_response(
        {
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_9",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": "{}"},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
    )
    assert result.content is None
    assert result.tool_calls == (
        ToolCallResult(id="call_9", name="get_weather", arguments="{}"),
    )
    assert result.finish_reason == "tool_calls"
    assert result.prompt_tokens is None


@pytest.mark.parametrize(
    "body",
    [
        "not a dict",
        {},
        {"choices": []},
        {"choices": [{"message": {"role": "assistant", "content": "x"}}]},
        {"choices": [{"finish_reason": "stop"}]},
        {"choices": [{"message": {"content": "x"}, "finish_reason": 3}]},
        {"choices": [{"message": {"content": "x"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": "a lot"}},
    ],
)
def test_parse_response_missing_or_malformed_fields(body: object) -> None:
    with pytest.raises(GatewayError) as exc_info:
        parse_chat_response(body)
    assert exc_info.value.code == "provider_invalid_response"
    assert exc_info.value.http_status == 502


# --- OmlxProvider.complete via httpx.MockTransport (no live server) ---


async def test_complete_posts_translated_request_and_parses() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=GOOD_RESPONSE_BODY)

    provider = make_provider(handler)
    result = await provider.complete(make_envelope(max_tokens=32))

    assert seen["url"] == "http://omlx.test/v1/chat/completions"
    assert seen["body"]["model"] == "gemma-4-12b-it-4bit"
    assert seen["body"]["messages"] == [{"role": "user", "content": "你好"}]
    assert seen["body"]["max_tokens"] == 32
    assert result.content == "你好！有什么可以帮你？"
    assert result.finish_reason == "stop"
    assert result.total_tokens == 10


async def test_complete_malformed_json_is_provider_invalid_response() -> None:
    provider = make_provider(lambda _request: httpx.Response(200, content=b"<html>not json</html>"))
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "provider_invalid_response"
    assert exc_info.value.http_status == 502


async def test_complete_missing_fields_is_provider_invalid_response() -> None:
    provider = make_provider(lambda _request: httpx.Response(200, json={"choices": []}))
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "provider_invalid_response"


async def test_complete_timeout_is_upstream_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("upstream too slow")

    provider = make_provider(handler)
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"
    assert exc_info.value.http_status == 502


async def test_complete_connect_error_is_upstream_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    provider = make_provider(handler)
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"


async def test_complete_upstream_http_error_is_upstream_unavailable() -> None:
    provider = make_provider(lambda _request: httpx.Response(500, json={"error": "boom"}))
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"


async def test_concurrency_semaphore_limits_upstream_to_one() -> None:
    gate = asyncio.Event()
    inflight = 0
    max_inflight = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal inflight, max_inflight
        inflight += 1
        max_inflight = max(max_inflight, inflight)
        await gate.wait()
        inflight -= 1
        return httpx.Response(200, json=GOOD_RESPONSE_BODY)

    provider = make_provider(handler, concurrency=1)
    first = asyncio.create_task(provider.complete(make_envelope()))
    await asyncio.sleep(0.05)
    assert inflight == 1

    second = asyncio.create_task(provider.complete(make_envelope()))
    await asyncio.sleep(0.05)
    # Second call is blocked on the semaphore, not yet at the upstream handler.
    assert inflight == 1

    gate.set()
    results = await asyncio.gather(first, second)
    assert all(r.content == "你好！有什么可以帮你？" for r in results)
    assert max_inflight == 1
