"""Shared API dependencies: bearer auth and envelope error mapping."""

from fastapi import Depends, Header, Request
from pydantic import ValidationError

from agent_gateway.channel import ChannelContext, ChannelRegistry
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import Provider
from agent_gateway.store.budget_ledger import BudgetLedger
from agent_gateway.store.trace_store import TraceStore


def get_registry(request: Request) -> ChannelRegistry:
    return request.app.state.registry


def get_trace_store(request: Request) -> TraceStore:
    return request.app.state.trace_store


def get_provider(request: Request) -> Provider:
    """Provider seam: app.state.provider is the OmlxProvider by default;
    tests inject a FakeProvider."""
    return request.app.state.provider


def get_budget_ledger(request: Request) -> BudgetLedger:
    return request.app.state.budget_ledger


async def get_channel_context(
    authorization: str | None = Header(default=None),
    registry: ChannelRegistry = Depends(get_registry),
) -> ChannelContext:
    key: str | None = None
    if authorization is not None:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            key = token
    context = registry.resolve(key)
    if context is None:
        raise GatewayError("invalid_api_key", "missing or invalid API key")
    return context


def _param_from_loc(loc: tuple[object, ...]) -> str | None:
    parts = [str(part) for part in loc if part != "__root__"]
    return ".".join(parts) if parts else None


def map_validation_error(exc: ValidationError) -> GatewayError:
    """Map a pydantic ValidationError to the stable error contract.

    Unknown fields, unsupported profile features, n != 1, and the
    max_tokens/max_completion_tokens conflict all become 400
    unsupported_parameter with `param` set. A tool message missing
    tool_call_id becomes 400 invalid_message_sequence.
    """
    for err in exc.errors():
        err_type: str = err["type"]
        loc: tuple[object, ...] = err["loc"]
        param = _param_from_loc(loc)
        if err_type == "extra_forbidden":
            return GatewayError("unsupported_parameter", f"unsupported parameter: {param}", param=param)
        if err_type == "missing" and loc and loc[-1] == "tool_call_id":
            return GatewayError(
                "invalid_message_sequence", "tool message requires tool_call_id", param=param
            )
        if err_type == "value_error" and "invalid_message_sequence" in str(err["msg"]):
            return GatewayError("invalid_message_sequence", str(err["msg"]), param="messages")
        if err_type == "value_error" and "max_tokens" in str(err["msg"]):
            return GatewayError("unsupported_parameter", str(err["msg"]), param="max_tokens")
        if err_type == "literal_error" and loc and loc[-1] == "n":
            return GatewayError("unsupported_parameter", "only n=1 is supported", param="n")
    first = exc.errors()[0]
    return GatewayError(
        "unsupported_parameter", str(first["msg"]), param=_param_from_loc(first["loc"])
    )
