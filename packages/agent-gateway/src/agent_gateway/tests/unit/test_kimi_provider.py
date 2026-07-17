"""Day 5: KimiProvider cloud adapter (OpenAI-compatible, env-configured)."""

import json

import httpx
import pytest

from agent_gateway.config import CloudProviderConfig
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.kimi import KimiProvider

CLOUD_CONFIG = CloudProviderConfig(
    enabled=True,
    base_url_env="KIMI_BASE_URL",
    api_key_env="KIMI_API_KEY",
    model_env="KIMI_MODEL",
)

ENV = {
    "KIMI_BASE_URL": "https://api.moonshot.cn/v1",
    "KIMI_API_KEY": "sk-test-key",
    "KIMI_MODEL": "kimi-k2",
}


def make_envelope() -> ChatCompletionEnvelopeV1:
    return ChatCompletionEnvelopeV1.model_validate(
        {"model": "agent-cloud", "messages": [{"role": "user", "content": "你好"}]}
    )


def good_body() -> dict:
    return {
        "id": "chatcmpl-cloud-1",
        "object": "chat.completion",
        "created": 1750000000,
        "model": "kimi-k2",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "云端回复"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
    }


def test_from_config_builds_provider_from_env() -> None:
    provider = KimiProvider.from_config(CLOUD_CONFIG, environ=ENV)
    assert provider is not None
    assert provider.model == "kimi-k2"


def test_from_config_missing_env_returns_none() -> None:
    assert KimiProvider.from_config(CLOUD_CONFIG, environ={}) is None
    assert (
        KimiProvider.from_config(
            CLOUD_CONFIG,
            environ={"KIMI_BASE_URL": "https://x", "KIMI_API_KEY": "k"},
        )
        is None
    )


def test_from_config_without_env_names_returns_none() -> None:
    assert KimiProvider.from_config(CloudProviderConfig(enabled=True), environ=ENV) is None


async def test_complete_posts_openai_request_with_bearer() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=good_body())

    provider = KimiProvider(
        base_url=ENV["KIMI_BASE_URL"],
        api_key=ENV["KIMI_API_KEY"],
        model=ENV["KIMI_MODEL"],
        transport=httpx.MockTransport(handler),
    )
    result = await provider.complete(make_envelope())
    await provider.aclose()

    assert result.content == "云端回复"
    assert result.finish_reason == "stop"
    assert result.total_tokens == 12

    request = seen[0]
    assert request.url.path == "/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer sk-test-key"
    body = json.loads(request.content)
    assert body["model"] == "kimi-k2"
    assert body["messages"] == [{"role": "user", "content": "你好"}]


async def test_http_error_maps_to_upstream_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    provider = KimiProvider(
        base_url=ENV["KIMI_BASE_URL"],
        api_key=ENV["KIMI_API_KEY"],
        model=ENV["KIMI_MODEL"],
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(GatewayError, match="HTTP 500") as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"


async def test_malformed_json_maps_to_provider_invalid_response() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    provider = KimiProvider(
        base_url=ENV["KIMI_BASE_URL"],
        api_key=ENV["KIMI_API_KEY"],
        model=ENV["KIMI_MODEL"],
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "provider_invalid_response"


async def test_unreachable_maps_to_upstream_unavailable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    provider = KimiProvider(
        base_url=ENV["KIMI_BASE_URL"],
        api_key=ENV["KIMI_API_KEY"],
        model=ENV["KIMI_MODEL"],
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"
