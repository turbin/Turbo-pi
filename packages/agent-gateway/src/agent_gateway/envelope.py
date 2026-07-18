"""ChatCompletionEnvelopeV1: the versioned Chat Completions request contract.

Text-only system/user/assistant/tool messages, function tools, and
tool_choice none/auto/required/named. Anything outside this profile is a
validation error; the API layer maps it to 400 unsupported_parameter with
the offending `param` set. Nothing is silently ignored.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCallFunction(StrictModel):
    name: str
    arguments: str


class ToolCall(StrictModel):
    id: str
    type: Literal["function"]
    function: ToolCallFunction


class SystemMessage(StrictModel):
    role: Literal["system"]
    content: str
    name: str | None = None


class UserMessage(StrictModel):
    role: Literal["user"]
    content: str
    name: str | None = None


class AssistantMessage(StrictModel):
    role: Literal["assistant"]
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    name: str | None = None


class ToolMessage(StrictModel):
    role: Literal["tool"]
    content: str
    tool_call_id: str


Message = Annotated[
    Union[SystemMessage, UserMessage, AssistantMessage, ToolMessage],
    Field(discriminator="role"),
]


class FunctionDefinition(StrictModel):
    name: str
    description: str | None = None
    parameters: dict[str, JsonValue] | None = None


class Tool(StrictModel):
    type: Literal["function"]
    function: FunctionDefinition


class NamedToolChoiceFunction(StrictModel):
    name: str


class NamedToolChoice(StrictModel):
    type: Literal["function"]
    function: NamedToolChoiceFunction


ToolChoice = Union[Literal["none", "auto", "required"], NamedToolChoice]


class StreamOptions(StrictModel):
    include_usage: bool = False


class ChatCompletionEnvelopeV1(StrictModel):
    model: str
    messages: list[Message]
    tools: list[Tool] | None = None
    tool_choice: ToolChoice | None = None
    stream: bool = False
    stream_options: StreamOptions | None = None
    n: Literal[1] = 1
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    stop: str | list[str] | None = None
    reasoning_effort: str | None = None

    @model_validator(mode="after")
    def _check_token_params(self) -> "ChatCompletionEnvelopeV1":
        if self.max_tokens is not None and self.max_completion_tokens is not None:
            raise ValueError("max_tokens and max_completion_tokens cannot both be set")
        return self

    @model_validator(mode="after")
    def _check_message_sequence(self) -> "ChatCompletionEnvelopeV1":
        """A tool message must directly follow the assistant message whose
        tool_calls requested it; tool_call_id is the only link (review 5.1).
        Tool results are treated as untrusted text, keyed by id only."""
        pending: set[str] = set()
        for message in self.messages:
            if isinstance(message, AssistantMessage):
                pending = {call.id for call in message.tool_calls or ()}
            elif isinstance(message, ToolMessage):
                if message.tool_call_id not in pending:
                    raise ValueError(
                        "invalid_message_sequence: tool message with tool_call_id "
                        f"'{message.tool_call_id}' has no matching preceding "
                        "assistant tool_calls"
                    )
                pending.discard(message.tool_call_id)
            else:
                pending = set()
        return self
