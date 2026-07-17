"""Day 5: observable-only quality gates (review P0-02)."""

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.providers.base import ModelResult, ToolCallResult
from agent_gateway.quality import evaluate_quality

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}


def make_envelope(**overrides: object) -> ChatCompletionEnvelopeV1:
    payload: dict = {
        "model": "agent-auto",
        "messages": [{"role": "user", "content": "你好"}],
    }
    payload.update(overrides)
    return ChatCompletionEnvelopeV1.model_validate(payload)


def make_result(**overrides: object) -> ModelResult:
    values: dict = {
        "content": "你好",
        "tool_calls": None,
        "finish_reason": "stop",
        "prompt_tokens": None,
        "completion_tokens": None,
        "total_tokens": None,
    }
    values.update(overrides)
    return ModelResult(**values)  # type: ignore[arg-type]


def weather_call(arguments: str, name: str = "get_weather") -> tuple[ToolCallResult, ...]:
    return (ToolCallResult(id="call_1", name=name, arguments=arguments),)


def test_clean_result_accepted() -> None:
    decision = evaluate_quality(make_envelope(), make_result())
    assert decision.escalate is False
    assert decision.reason is None


def test_tool_call_with_valid_arguments_accepted() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(
        content=None,
        tool_calls=weather_call('{"city":"北京"}'),
        finish_reason="tool_calls",
    )
    assert evaluate_quality(envelope, result).escalate is False


def test_arguments_not_json_escalates() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(content=None, tool_calls=weather_call("{city:"), finish_reason="tool_calls")
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_arguments_missing_required_property_escalates() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(content=None, tool_calls=weather_call("{}"), finish_reason="tool_calls")
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_arguments_wrong_property_type_escalates() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(
        content=None, tool_calls=weather_call('{"city": 42}'), finish_reason="tool_calls"
    )
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_arguments_not_an_object_escalates() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(
        content=None, tool_calls=weather_call('["北京"]'), finish_reason="tool_calls"
    )
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_undeclared_tool_call_escalates() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(
        content=None,
        tool_calls=weather_call("{}", name="delete_everything"),
        finish_reason="tool_calls",
    )
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_tool_call_without_declared_tools_escalates() -> None:
    envelope = make_envelope()
    result = make_result(
        content=None, tool_calls=weather_call("{}"), finish_reason="tool_calls"
    )
    decision = evaluate_quality(envelope, result)
    assert decision.escalate is True
    assert decision.reason == "invalid_tool_schema"


def test_finish_reason_length_escalates() -> None:
    result = make_result(content="truncated…", finish_reason="length")
    decision = evaluate_quality(make_envelope(), result)
    assert decision.escalate is True
    assert decision.reason == "finish_reason_length"


def test_none_content_without_tool_calls_escalates() -> None:
    result = make_result(content=None)
    decision = evaluate_quality(make_envelope(), result)
    assert decision.escalate is True
    assert decision.reason == "empty_output"


def test_empty_string_content_escalates() -> None:
    result = make_result(content="")
    decision = evaluate_quality(make_envelope(), result)
    assert decision.escalate is True
    assert decision.reason == "empty_output"


def test_tool_call_without_content_is_not_empty_output() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL])
    result = make_result(
        content=None,
        tool_calls=weather_call('{"city":"北京"}'),
        finish_reason="tool_calls",
    )
    assert evaluate_quality(envelope, result).escalate is False


def test_forced_tool_missing_escalates() -> None:
    envelope = make_envelope(
        tools=[WEATHER_TOOL],
        tool_choice={"type": "function", "function": {"name": "get_weather"}},
    )
    decision = evaluate_quality(envelope, make_result())
    assert decision.escalate is True
    assert decision.reason == "forced_tool_missing"


def test_forced_tool_present_accepted() -> None:
    envelope = make_envelope(
        tools=[WEATHER_TOOL],
        tool_choice={"type": "function", "function": {"name": "get_weather"}},
    )
    result = make_result(
        content=None,
        tool_calls=weather_call('{"city":"北京"}'),
        finish_reason="tool_calls",
    )
    assert evaluate_quality(envelope, result).escalate is False


def test_auto_tool_choice_does_not_force() -> None:
    envelope = make_envelope(tools=[WEATHER_TOOL], tool_choice="auto")
    assert evaluate_quality(envelope, make_result()).escalate is False
