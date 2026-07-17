"""FakeProvider: scriptable results/errors, records received envelopes."""

import pytest

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider


def make_envelope(text: str = "你好") -> ChatCompletionEnvelopeV1:
    return ChatCompletionEnvelopeV1.model_validate(
        {"model": "agent-auto", "messages": [{"role": "user", "content": text}]}
    )


def make_result(content: str = "回复") -> ModelResult:
    return ModelResult(
        content=content,
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=1,
        completion_tokens=2,
        total_tokens=3,
    )


async def test_returns_scripted_results_in_order_and_records_envelopes() -> None:
    provider = FakeProvider([make_result("第一"), make_result("第二")])
    first = await provider.complete(make_envelope("问题一"))
    second = await provider.complete(make_envelope("问题二"))
    assert first.content == "第一"
    assert second.content == "第二"
    assert [env.messages[-1].content for env in provider.received] == ["问题一", "问题二"]


async def test_raises_scripted_gateway_error() -> None:
    provider = FakeProvider([GatewayError("upstream_unavailable", "omlx down")])
    with pytest.raises(GatewayError) as exc_info:
        await provider.complete(make_envelope())
    assert exc_info.value.code == "upstream_unavailable"
    assert len(provider.received) == 1


async def test_push_appends_to_script() -> None:
    provider = FakeProvider()
    provider.push(make_result("追加"))
    result = await provider.complete(make_envelope())
    assert result.content == "追加"


async def test_empty_script_raises() -> None:
    provider = FakeProvider()
    with pytest.raises(AssertionError):
        await provider.complete(make_envelope())
