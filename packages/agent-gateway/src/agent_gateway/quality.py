"""Observable-only quality gates (review P0-02).

V1 gates use only evidence visible in the upstream response and the request
envelope: invalid tool call structure, finish_reason=length, empty output,
and a forced tool the result did not call. Confidence/complexity/history
signals are out of scope; they may only be shadow-recorded elsewhere.

Tool argument schema checks are deliberately minimal (required properties
and top-level property types): the gateway does not depend on a full JSON
Schema implementation for V1.
"""

import json
from dataclasses import dataclass

from agent_gateway.envelope import ChatCompletionEnvelopeV1, NamedToolChoice
from agent_gateway.providers.base import ModelResult

REASON_INVALID_TOOL_SCHEMA = "invalid_tool_schema"
REASON_FINISH_REASON_LENGTH = "finish_reason_length"
REASON_EMPTY_OUTPUT = "empty_output"
REASON_FORCED_TOOL_MISSING = "forced_tool_missing"


@dataclass(frozen=True)
class GateDecision:
    escalate: bool
    reason: str | None = None


ACCEPT = GateDecision(escalate=False)


def _type_matches(value: object, schema_type: str) -> bool:
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "array":
        return isinstance(value, list)
    return True  # unknown type keyword: not observable enough to reject


def _satisfies_schema(arguments: object, schema: dict) -> bool:
    """Minimal object-schema check: required properties and property types."""
    if schema.get("type", "object") != "object" and "properties" not in schema:
        return True  # non-object root schemas are not checked in V1
    if not isinstance(arguments, dict):
        return False
    required = schema.get("required", [])
    if isinstance(required, list) and any(name not in arguments for name in required):
        return False
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return True
    for key, value in arguments.items():
        spec = properties.get(key)
        if isinstance(spec, dict):
            schema_type = spec.get("type")
            if isinstance(schema_type, str) and not _type_matches(value, schema_type):
                return False
    return True


def _invalid_tool_call(envelope: ChatCompletionEnvelopeV1, result: ModelResult) -> bool:
    declared = {tool.function.name: tool.function for tool in envelope.tools or ()}
    for call in result.tool_calls or ():
        function = declared.get(call.name)
        if function is None:
            return True  # tool call for a tool the request never declared
        try:
            arguments = json.loads(call.arguments)
        except json.JSONDecodeError:
            return True
        if function.parameters and not _satisfies_schema(arguments, function.parameters):
            return True
    return False


def evaluate_quality(envelope: ChatCompletionEnvelopeV1, result: ModelResult) -> GateDecision:
    """Accept the local result, or escalate to cloud with an observable reason."""
    if result.tool_calls and _invalid_tool_call(envelope, result):
        return GateDecision(escalate=True, reason=REASON_INVALID_TOOL_SCHEMA)
    if result.finish_reason == "length":
        return GateDecision(escalate=True, reason=REASON_FINISH_REASON_LENGTH)
    if not result.content and not result.tool_calls:
        return GateDecision(escalate=True, reason=REASON_EMPTY_OUTPUT)
    if isinstance(envelope.tool_choice, NamedToolChoice):
        wanted = envelope.tool_choice.function.name
        if not any(call.name == wanted for call in result.tool_calls or ()):
            return GateDecision(escalate=True, reason=REASON_FORCED_TOOL_MISSING)
    return ACCEPT
