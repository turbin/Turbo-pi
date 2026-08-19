"""Optional Langfuse export of provider generations (2026-08-19, 9B 跑批监视).

Disabled by default (``[langfuse] enabled = false`` in config.toml -> zero
behavior change). When enabled, main.py wraps both providers in
:class:`LangfuseTracedProvider`: every upstream call becomes one Langfuse
generation whose trace id derives deterministically from the gateway
trace_id (``client.create_trace_id(seed=trace_id)``), so eval run.jsonl
trace_ids and agent-server gateway_marker session entries join 1:1 with
Langfuse traces — the same reconciliation key as model_runs (台账 2 口径).

Tracing must never break the request path (issue-008/009/011 lesson:
observability must not kill a batch). Span-creation failures fall back to an
untraced provider call; span-update failures are logged and swallowed.
"""

import logging
import os
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any

from langfuse import Langfuse
from langfuse.types import TraceContext

from agent_gateway.config import LangfuseConfig
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult, Provider

logger = logging.getLogger(__name__)

# Set by the chat pipeline (non-stream route, and the top of the SSE replay
# generator) before any provider call is scheduled. asyncio.ensure_future
# copies the current context, so the provider wrapper observes the id of the
# request that scheduled the call; requests are handled one per task, so no
# cross-request leak and no reset is needed.
current_trace_id: ContextVar[str | None] = ContextVar("langfuse_gateway_trace_id", default=None)


def init_langfuse(
    config: LangfuseConfig, environ: Mapping[str, str] = os.environ
) -> Langfuse | None:
    """Build the Langfuse client; None when disabled or keys are missing."""
    if not config.enabled:
        return None
    public_key = environ.get(config.public_key_env)
    secret_key = environ.get(config.secret_key_env)
    if not (public_key and secret_key):
        logger.warning(
            "[langfuse] enabled but %s/%s are not set — tracing disabled",
            config.public_key_env,
            config.secret_key_env,
        )
        return None
    return Langfuse(
        public_key=public_key,
        secret_key=secret_key,
        host=config.host,
        environment=config.environment,
    )


def shutdown_langfuse(client: Langfuse | None) -> None:
    """Flush pending spans and stop the exporter; never raises."""
    if client is None:
        return
    try:
        client.flush()
        client.shutdown()
    except Exception:  # noqa: BLE001 - shutdown must not mask app teardown
        logger.exception("[langfuse] flush/shutdown failed")


def _envelope_input(envelope: ChatCompletionEnvelopeV1) -> dict:
    try:
        return envelope.model_dump(mode="json", exclude_none=True)
    except Exception:  # noqa: BLE001 - serialization must not break tracing
        return {"model": envelope.model}


def _result_output(result: ModelResult) -> dict[str, Any]:
    return {
        "content": result.content,
        "finish_reason": result.finish_reason,
        "tool_calls": [call.name for call in result.tool_calls or []],
    }


def _usage_details(result: ModelResult) -> dict[str, int]:
    usage: dict[str, int] = {}
    if result.prompt_tokens is not None:
        usage["input"] = result.prompt_tokens
    if result.completion_tokens is not None:
        usage["output"] = result.completion_tokens
    if result.total_tokens is not None:
        usage["total"] = result.total_tokens
    return usage


class LangfuseTracedProvider:
    """Provider wrapper exporting each complete() call as a Langfuse generation.

    Satisfies the Provider protocol structurally; wrapping happens once in
    main.py so every call site (non-stream, SSE replay, escalation leg) is
    covered. The cloud provider is only ever called as the escalation leg,
    so provider_name alone distinguishes primary (omlx) from escalation
    (kimi/deepseek) generations.
    """

    def __init__(self, inner: Provider, *, client: Langfuse, provider_name: str, model: str) -> None:
        self._inner = inner
        self._client = client
        self._provider_name = provider_name
        self._model = model

    async def aclose(self) -> None:
        await self._inner.aclose()

    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        trace_id = current_trace_id.get()
        if trace_id is None:
            return await self._inner.complete(envelope)
        try:
            generation_cm = self._client.start_as_current_observation(
                trace_context=TraceContext(trace_id=self._client.create_trace_id(seed=trace_id)),
                name=self._provider_name,
                as_type="generation",
                model=self._model,
                input=_envelope_input(envelope),
                metadata={"gateway_trace_id": trace_id, "provider": self._provider_name},
            )
        except Exception:  # noqa: BLE001 - SDK failure must not block the call
            logger.exception("[langfuse] failed to start generation; calling provider untraced")
            return await self._inner.complete(envelope)
        # with: span .end() on exit is an in-memory OTel op (export is
        # batched in the background), so __exit__ cannot plausibly raise.
        # (The SDK's agnostic context manager only supports sync ``with`` for
        # this observation type.)
        with generation_cm as generation:
            try:
                result = await self._inner.complete(envelope)
            except GatewayError as exc:
                self._update_quietly(generation, level="ERROR", status_message=exc.code)
                raise
            self._update_quietly(
                generation,
                output=_result_output(result),
                usage_details=_usage_details(result) or None,
            )
            return result

    def _update_quietly(self, generation: Any, **fields: Any) -> None:
        try:
            generation.update(**fields)
        except Exception:  # noqa: BLE001 - a lost span update is acceptable
            logger.exception("[langfuse] generation update failed")
