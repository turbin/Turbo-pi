"""Provider protocol and OpenAI chat translation shared by local and cloud adapters.

build_chat_request/parse_chat_response are pure functions so translation and
parsing are unit-tested without any network; both the local omlx adapter and
the cloud adapters use them.
"""

import json
from dataclasses import dataclass
from typing import Protocol

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError


@dataclass(frozen=True)
class ToolCallResult:
    id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ModelResult:
    """One upstream completion. Usage fields are None when the provider did
    not return a usage object."""

    content: str | None
    tool_calls: tuple[ToolCallResult, ...] | None
    finish_reason: str
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None


class Provider(Protocol):
    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult: ...


def build_chat_request(envelope: ChatCompletionEnvelopeV1, *, model: str) -> dict:
    """Translate ChatCompletionEnvelopeV1 into an OpenAI chat request body."""
    payload: dict = {
        "model": model,
        "messages": [message.model_dump(exclude_none=True) for message in envelope.messages],
    }
    if envelope.tools is not None:
        payload["tools"] = [tool.model_dump(exclude_none=True) for tool in envelope.tools]
    if envelope.tool_choice is not None:
        choice = envelope.tool_choice
        payload["tool_choice"] = (
            choice if isinstance(choice, str) else choice.model_dump(exclude_none=True)
        )
    max_tokens = (
        envelope.max_tokens
        if envelope.max_tokens is not None
        else envelope.max_completion_tokens
    )
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if envelope.temperature is not None:
        payload["temperature"] = envelope.temperature
    if envelope.top_p is not None:
        payload["top_p"] = envelope.top_p
    if envelope.stop is not None:
        payload["stop"] = envelope.stop
    return payload


def _invalid(message: str) -> GatewayError:
    return GatewayError("provider_invalid_response", message)


def parse_chat_response(body: object) -> ModelResult:
    """Parse an upstream chat completion body into a ModelResult.

    Required: non-empty choices, a message object, a string finish_reason.
    Usage is optional; when present its fields must be ints.
    """
    if not isinstance(body, dict):
        raise _invalid("upstream response is not a JSON object")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise _invalid("upstream response has no choices")
    choice = choices[0]
    if not isinstance(choice, dict):
        raise _invalid("upstream choice is not an object")
    finish_reason = choice.get("finish_reason")
    if not isinstance(finish_reason, str):
        raise _invalid("upstream choice is missing finish_reason")
    message = choice.get("message")
    if not isinstance(message, dict):
        raise _invalid("upstream choice is missing message")

    content = message.get("content")
    if content is not None and not isinstance(content, str):
        raise _invalid("upstream message content is not a string")

    tool_calls: tuple[ToolCallResult, ...] | None = None
    raw_tool_calls = message.get("tool_calls")
    if raw_tool_calls is not None:
        if not isinstance(raw_tool_calls, list):
            raise _invalid("upstream tool_calls is not a list")
        parsed: list[ToolCallResult] = []
        for raw_call in raw_tool_calls:
            if not isinstance(raw_call, dict):
                raise _invalid("upstream tool_call is not an object")
            function = raw_call.get("function")
            call_id = raw_call.get("id")
            if (
                not isinstance(call_id, str)
                or not isinstance(function, dict)
                or not isinstance(function.get("name"), str)
                or not isinstance(function.get("arguments"), str)
            ):
                raise _invalid("upstream tool_call is missing id/function.name/function.arguments")
            parsed.append(
                ToolCallResult(
                    id=call_id,
                    name=function["name"],
                    arguments=function["arguments"],
                )
            )
        tool_calls = tuple(parsed)

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    usage = body.get("usage")
    if usage is not None:
        if not isinstance(usage, dict):
            raise _invalid("upstream usage is not an object")
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        total_tokens = usage.get("total_tokens")
        if not all(
            value is None or isinstance(value, int)
            for value in (prompt_tokens, completion_tokens, total_tokens)
        ):
            raise _invalid("upstream usage fields are not ints")

    return ModelResult(
        content=content,
        tool_calls=tool_calls,
        finish_reason=finish_reason,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )
