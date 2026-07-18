import pytest
from pydantic import ValidationError

from agent_gateway.envelope import ChatCompletionEnvelopeV1


def valid_payload() -> dict:
    return {
        "model": "agent-auto",
        "messages": [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "你好"},
        ],
    }


def test_valid_envelope_parses() -> None:
    env = ChatCompletionEnvelopeV1.model_validate(valid_payload())
    assert env.model == "agent-auto"
    assert env.n == 1
    assert len(env.messages) == 2
    assert env.messages[1].role == "user"


def test_full_envelope_with_tools_parses() -> None:
    payload = valid_payload()
    payload["messages"].append(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}
            ],
        }
    )
    payload["messages"].append({"role": "tool", "tool_call_id": "call_1", "content": "sunny"})
    payload["tools"] = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
            },
        }
    ]
    payload["tool_choice"] = {"type": "function", "function": {"name": "get_weather"}}
    payload["max_completion_tokens"] = 512
    payload["temperature"] = 0.2
    env = ChatCompletionEnvelopeV1.model_validate(payload)
    assert env.tool_choice is not None
    assert env.messages[2].role == "assistant"
    assert env.messages[3].role == "tool"


def test_unknown_top_level_field_rejected() -> None:
    payload = valid_payload()
    payload["logprobs"] = True
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


@pytest.mark.parametrize("field", ["audio", "functions", "function_call", "response_format", "top_logprobs"])
def test_unsupported_known_fields_rejected(field: str) -> None:
    payload = valid_payload()
    payload[field] = "x"
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


def test_stream_and_stream_options_parse() -> None:
    payload = valid_payload()
    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    env = ChatCompletionEnvelopeV1.model_validate(payload)
    assert env.stream is True
    assert env.stream_options is not None
    assert env.stream_options.include_usage is True


def test_stream_defaults_to_false() -> None:
    env = ChatCompletionEnvelopeV1.model_validate(valid_payload())
    assert env.stream is False
    assert env.stream_options is None


def test_n_greater_than_one_rejected() -> None:
    payload = valid_payload()
    payload["n"] = 2
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


def test_max_tokens_conflict_rejected() -> None:
    payload = valid_payload()
    payload["max_tokens"] = 100
    payload["max_completion_tokens"] = 100
    with pytest.raises(ValidationError, match="max_tokens"):
        ChatCompletionEnvelopeV1.model_validate(payload)


def test_tool_message_requires_tool_call_id() -> None:
    payload = valid_payload()
    payload["messages"].append({"role": "tool", "content": "result"})
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


def test_multimodal_content_rejected() -> None:
    payload = valid_payload()
    payload["messages"][1]["content"] = [{"type": "text", "text": "hi"}]
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


@pytest.mark.parametrize("choice", ["none", "auto", "required"])
def test_tool_choice_string_variants(choice: str) -> None:
    payload = valid_payload()
    payload["tool_choice"] = choice
    env = ChatCompletionEnvelopeV1.model_validate(payload)
    assert env.tool_choice == choice


def test_unknown_message_role_rejected() -> None:
    payload = valid_payload()
    payload["messages"].append({"role": "developer", "content": "x"})
    with pytest.raises(ValidationError):
        ChatCompletionEnvelopeV1.model_validate(payload)


def test_reasoning_effort_accepted_but_not_forwarded() -> None:
    from agent_gateway.providers.base import build_chat_request

    payload = valid_payload()
    payload["reasoning_effort"] = "high"
    env = ChatCompletionEnvelopeV1.model_validate(payload)
    assert env.reasoning_effort == "high"
    upstream = build_chat_request(env, model="agent-auto")
    assert "reasoning_effort" not in upstream
