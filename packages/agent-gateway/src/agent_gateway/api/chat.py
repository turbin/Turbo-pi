"""Chat completions endpoint and internal trace query.

Non-streaming and delayed-SSE pipelines through the request state machine
(received -> queued -> leased -> run_started -> run_succeeded
-> response_started -> response_closed), one ModelRun row per upstream
attempt, and routing to the local omlx provider (V1: one provider per
request, see routing.py). Streaming is delayed replay (see sse.py).

Day 5 (review P0-02/P0-04, plan 5.2/5.4):
- Observable-only quality gates can escalate the same envelope once to the
  single configured cloud provider; the escalation ModelRun is sequence=2
  with purpose="escalation" and the gate reason in quality_signals.
- Before any cloud egress: the channel must allow egress and the cloud
  provider must be enabled (else 422 local_quality_rejected), structured
  DLP must pass (else 403 cloud_egress_forbidden), and an atomic budget
  reservation must fit the (channel, month) cap (else 429 budget_exceeded).
- Client disconnects cancel the upstream call, release the semaphore slot,
  and move the trace to cancelled; nothing is written to the gone client.
- Idempotency-Key requests replay their stored response; response bodies
  are persisted only for requests that carried the header.
No DB transaction is held across a provider call.
"""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError

from agent_gateway.api.deps import (
    get_budget_ledger,
    get_channel_context,
    get_provider,
    get_trace_store,
    map_validation_error,
)
from agent_gateway.cancellation import (
    ClientDisconnected,
    await_provider,
    heartbeats_until_done,
)
from agent_gateway.channel import ChannelContext
from agent_gateway.config import GatewayConfig
from agent_gateway.envelope import ChatCompletionEnvelopeV1, NamedToolChoice
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult, Provider
from agent_gateway.quality import evaluate_quality
from agent_gateway.routing import RouteDecision, select_escalation_provider, select_provider
from agent_gateway.security.dlp import DEFAULT_DLP_PATTERNS, scan_envelope
from agent_gateway.security.redact import redacted_finding_payload
from agent_gateway.sse import (
    DelayedEventStreamResponse,
    build_replay_events,
    usage_payload,
)
from agent_gateway.statemachine import TERMINAL_STATES, RequestState
from agent_gateway.store.budget_ledger import BudgetExceeded, BudgetLedger, BudgetLedgerError
from agent_gateway.store.models import BudgetReservation, RequestExecution
from agent_gateway.store.trace_store import (
    ConcurrencyConflict,
    IdempotencyRaceError,
    InvalidTransition,
    TraceStore,
    TraceStoreError,
)

logger = logging.getLogger(__name__)

router = APIRouter()

STORE_ERRORS = (TraceStoreError, ConcurrencyConflict, InvalidTransition)


def request_digest(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_openai_response(trace_id: str, envelope: ChatCompletionEnvelopeV1, result: ModelResult) -> dict:
    """OpenAI-shaped response: logical model name, trace_id as id."""
    message: dict = {"role": "assistant", "content": result.content}
    if result.tool_calls:
        message["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in result.tool_calls
        ]
    body: dict = {
        "id": trace_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": envelope.model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": result.finish_reason,
            }
        ],
    }
    if (
        result.prompt_tokens is not None
        or result.completion_tokens is not None
        or result.total_tokens is not None
    ):
        body["usage"] = usage_payload(result)
    return body


def quality_signals_for(envelope: ChatCompletionEnvelopeV1, result: ModelResult) -> dict:
    """Observable quality signals persisted on the ModelRun.

    forced_tool_missing records that tool_choice named a function the result
    did not call; the quality gate (quality.py) decides escalation.
    """
    forced_tool_missing = False
    if isinstance(envelope.tool_choice, NamedToolChoice):
        wanted = envelope.tool_choice.function.name
        forced_tool_missing = not any(
            call.name == wanted for call in result.tool_calls or ()
        )
    return {
        "finish_reason": result.finish_reason,
        "has_tool_calls": bool(result.tool_calls),
        "empty_output": result.content is None and not result.tool_calls,
        "forced_tool_missing": forced_tool_missing,
    }


async def record_provider_failure(
    store: TraceStore,
    trace_id: str,
    route: RouteDecision,
    running: RequestExecution,
    timeout_seconds: int,
    exc: GatewayError,
    *,
    sequence: int = 1,
    purpose: str = "primary",
) -> None:
    """Persist a failed ModelRun and move the trace to failed."""
    try:
        await store.record_model_run(
            trace_id=trace_id,
            sequence=sequence,
            purpose=purpose,
            provider=route.provider_name,
            state="failed",
            timeout_ms=timeout_seconds * 1000,
            error_code=exc.code,
        )
        await fail_trace(store, trace_id, running, exc.code)
    except STORE_ERRORS as store_exc:
        raise GatewayError(
            "database_unavailable", f"trace store unavailable: {store_exc}"
        ) from store_exc


async def fail_trace(
    store: TraceStore, trace_id: str, running: RequestExecution, error_code: str
) -> None:
    """Move the trace to failed, clearing the lease."""
    try:
        await store.transition(
            trace_id,
            expected_version=running.version,
            to_state=RequestState.failed,
            event_type="failed",
            clear_lease=True,
            payload={"error_code": error_code},
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc


async def record_succeeded_run(
    store: TraceStore,
    trace_id: str,
    *,
    sequence: int,
    purpose: str,
    provider: str,
    timeout_seconds: int,
    signals: dict,
    result: ModelResult,
) -> None:
    """Persist one succeeded ModelRun; runs in its own short transaction."""
    usage_source = (
        "provider"
        if result.prompt_tokens is not None or result.total_tokens is not None
        else None
    )
    try:
        await store.record_model_run(
            trace_id=trace_id,
            sequence=sequence,
            purpose=purpose,
            provider=provider,
            state="succeeded",
            timeout_ms=timeout_seconds * 1000,
            quality_signals=signals,
            usage_source=usage_source,
            input_tokens=result.prompt_tokens,
            output_tokens=result.completion_tokens,
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc


async def start_response_transition(
    store: TraceStore, trace_id: str, running: RequestExecution
) -> RequestExecution:
    """Walk run_succeeded -> response_started after the final result is known."""
    try:
        succeeded = await store.transition(
            trace_id,
            expected_version=running.version,
            to_state=RequestState.run_succeeded,
            event_type="run_succeeded",
        )
        return await store.transition(
            trace_id,
            expected_version=succeeded.version,
            to_state=RequestState.response_started,
            event_type="response_started",
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc


async def record_cancellation(
    store: TraceStore,
    trace_id: str,
    route: RouteDecision,
    running: RequestExecution,
    timeout_seconds: int,
    *,
    sequence: int,
    purpose: str,
) -> None:
    """Best-effort: record the cancelled run and move the trace to cancelled.

    The client is gone; if the store write also fails, the startup lease
    sweep abandons the trace instead. Internal code 499 client_cancelled is
    recorded but never sent to the client.
    """
    try:
        await store.record_model_run(
            trace_id=trace_id,
            sequence=sequence,
            purpose=purpose,
            provider=route.provider_name,
            state="cancelled",
            timeout_ms=timeout_seconds * 1000,
            error_code="client_cancelled",
        )
        await store.transition(
            trace_id,
            expected_version=running.version,
            to_state=RequestState.cancelled,
            event_type="cancelled",
            clear_lease=True,
            payload={"error_code": "client_cancelled"},
        )
    except STORE_ERRORS:
        logger.warning("failed to record cancellation for trace %s", trace_id)


async def begin_escalation(
    *,
    request: Request,
    store: TraceStore,
    ledger: BudgetLedger,
    context: ChannelContext,
    envelope: ChatCompletionEnvelopeV1,
    trace_id: str,
    running: RequestExecution,
    reason: str,
) -> tuple[RouteDecision, BudgetReservation, "asyncio.Task[ModelResult]"]:
    """Escalation preconditions; on pass, starts the cloud call task.

    Preconditions in order: egress allowed + provider enabled, DLP pass,
    budget reservation. The reservation is reconciled after a successful run
    and released on provider failure (see fail_escalation_wait).
    """
    config: GatewayConfig = request.app.state.config
    decision = select_escalation_provider(config, request.app.state.cloud_provider)
    cloud_config = getattr(config.cloud, config.routing.selected_cloud_provider)
    if not context.cloud_egress_allowed or not cloud_config.enabled or decision is None:
        await fail_trace(store, trace_id, running, "local_quality_rejected")
        raise GatewayError(
            "local_quality_rejected",
            f"local result failed quality gate '{reason}' and cloud egress is not permitted",
        )

    findings = scan_envelope(envelope, {**DEFAULT_DLP_PATTERNS, **config.security.dlp_patterns})
    if findings:
        payload = {"findings": redacted_finding_payload(findings)}
        logger.info("cloud egress blocked by DLP policy: %s", payload)
        try:
            await store.record_event(trace_id, event_type="dlp_blocked", payload=payload)
        except TraceStoreError as exc:
            raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc
        await fail_trace(store, trace_id, running, "cloud_egress_forbidden")
        raise GatewayError("cloud_egress_forbidden", "cloud egress blocked by DLP policy")

    try:
        reservation = await ledger.reserve(
            channel_id=context.channel_id,
            period_yyyymm=datetime.now(UTC).strftime("%Y%m"),
            micro_usd=config.cloud.reserve_micro_usd,
            cap_micro_usd=context.monthly_budget_micro_usd,
            trace_id=trace_id,
        )
    except BudgetExceeded as exc:
        await fail_trace(store, trace_id, running, "budget_exceeded")
        raise GatewayError("budget_exceeded", f"cloud budget exceeded: {exc}") from exc
    except BudgetLedgerError as exc:
        raise GatewayError("database_unavailable", f"budget ledger unavailable: {exc}") from exc

    task = asyncio.ensure_future(decision.provider.complete(envelope))
    return decision, reservation, task


async def fail_escalation_wait(
    *,
    store: TraceStore,
    ledger: BudgetLedger,
    decision: RouteDecision,
    reservation: BudgetReservation,
    trace_id: str,
    running: RequestExecution,
    timeout_seconds: int,
    exc: "ClientDisconnected | GatewayError",
) -> None:
    """Release the reservation and record the failed/cancelled escalation run."""
    await release_quietly(ledger, reservation.id)
    if isinstance(exc, ClientDisconnected):
        await record_cancellation(
            store, trace_id, decision, running, timeout_seconds,
            sequence=2, purpose="escalation",
        )
    else:
        await record_provider_failure(
            store, trace_id, decision, running, timeout_seconds, exc,
            sequence=2, purpose="escalation",
        )


async def finish_escalation(
    *,
    store: TraceStore,
    ledger: BudgetLedger,
    envelope: ChatCompletionEnvelopeV1,
    trace_id: str,
    running: RequestExecution,
    timeout_seconds: int,
    reason: str,
    decision: RouteDecision,
    reservation: BudgetReservation,
    result: ModelResult,
) -> ModelResult:
    """Reconcile the reservation and record the succeeded escalation run."""
    try:
        # V1: actual cloud cost is not known without pricing data, so the
        # full reservation is charged. The ledger supports partial charges.
        await ledger.reconcile(reservation.id, reservation.reserved_micro_usd)
    except BudgetLedgerError as exc:
        raise GatewayError("database_unavailable", f"budget ledger unavailable: {exc}") from exc

    signals = quality_signals_for(envelope, result)
    signals["escalation_reason"] = reason
    await record_succeeded_run(
        store,
        trace_id,
        sequence=2,
        purpose="escalation",
        provider=decision.provider_name,
        timeout_seconds=timeout_seconds,
        signals=signals,
        result=result,
    )
    return result


async def escalate_to_cloud(
    *,
    request: Request,
    store: TraceStore,
    ledger: BudgetLedger,
    context: ChannelContext,
    envelope: ChatCompletionEnvelopeV1,
    trace_id: str,
    running: RequestExecution,
    timeout_seconds: int,
    reason: str,
) -> ModelResult:
    """Retry the same envelope once against the single configured cloud provider."""
    decision, reservation, task = await begin_escalation(
        request=request,
        store=store,
        ledger=ledger,
        context=context,
        envelope=envelope,
        trace_id=trace_id,
        running=running,
        reason=reason,
    )
    try:
        result = await await_provider(request, task)
    except (ClientDisconnected, GatewayError) as exc:
        await fail_escalation_wait(
            store=store,
            ledger=ledger,
            decision=decision,
            reservation=reservation,
            trace_id=trace_id,
            running=running,
            timeout_seconds=timeout_seconds,
            exc=exc,
        )
        raise
    return await finish_escalation(
        store=store,
        ledger=ledger,
        envelope=envelope,
        trace_id=trace_id,
        running=running,
        timeout_seconds=timeout_seconds,
        reason=reason,
        decision=decision,
        reservation=reservation,
        result=result,
    )


async def release_quietly(ledger: BudgetLedger, reservation_id: int) -> None:
    try:
        await ledger.release(reservation_id)
    except BudgetLedgerError:
        logger.warning("failed to release budget reservation %s", reservation_id)


async def execute_with_escalation(
    *,
    request: Request,
    store: TraceStore,
    ledger: BudgetLedger,
    context: ChannelContext,
    route: RouteDecision,
    envelope: ChatCompletionEnvelopeV1,
    trace_id: str,
    running: RequestExecution,
    timeout_seconds: int,
) -> ModelResult:
    """Local call, quality gate, optional single cloud escalation."""
    task = asyncio.ensure_future(route.provider.complete(envelope))
    try:
        result = await await_provider(request, task)
    except ClientDisconnected:
        await record_cancellation(
            store, trace_id, route, running, timeout_seconds, sequence=1, purpose="primary"
        )
        raise
    except GatewayError as exc:
        await record_provider_failure(store, trace_id, route, running, timeout_seconds, exc)
        raise

    await record_succeeded_run(
        store,
        trace_id,
        sequence=1,
        purpose="primary",
        provider=route.provider_name,
        timeout_seconds=timeout_seconds,
        signals=quality_signals_for(envelope, result),
        result=result,
    )
    gate = evaluate_quality(envelope, result)
    if not gate.escalate:
        return result
    assert gate.reason is not None
    return await escalate_to_cloud(
        request=request,
        store=store,
        ledger=ledger,
        context=context,
        envelope=envelope,
        trace_id=trace_id,
        running=running,
        timeout_seconds=timeout_seconds,
        reason=gate.reason,
    )


async def stream_traced_events(
    *,
    request: Request,
    ledger: BudgetLedger,
    context: ChannelContext,
    store: TraceStore,
    route: RouteDecision,
    envelope: ChatCompletionEnvelopeV1,
    trace_id: str,
    running: RequestExecution,
    timeout_seconds: int,
    heartbeat_seconds: float,
) -> AsyncIterator[bytes]:
    """Delayed SSE replay with the same trace handling as the non-streaming path."""
    task = asyncio.ensure_future(route.provider.complete(envelope))
    try:
        async for heartbeat in heartbeats_until_done(request, task, heartbeat_seconds):
            yield heartbeat
        result = task.result()
    except ClientDisconnected:
        await record_cancellation(
            store, trace_id, route, running, timeout_seconds, sequence=1, purpose="primary"
        )
        return  # never write a response to the gone client
    except GatewayError as exc:
        await record_provider_failure(store, trace_id, route, running, timeout_seconds, exc)
        raise

    await record_succeeded_run(
        store,
        trace_id,
        sequence=1,
        purpose="primary",
        provider=route.provider_name,
        timeout_seconds=timeout_seconds,
        signals=quality_signals_for(envelope, result),
        result=result,
    )
    gate = evaluate_quality(envelope, result)
    if gate.escalate:
        assert gate.reason is not None
        reason = gate.reason
        decision, reservation, cloud_task = await begin_escalation(
            request=request,
            store=store,
            ledger=ledger,
            context=context,
            envelope=envelope,
            trace_id=trace_id,
            running=running,
            reason=reason,
        )
        # Heartbeats cover the escalation wait too; a disconnect cancels the
        # cloud task exactly as on the local wait.
        try:
            async for heartbeat in heartbeats_until_done(request, cloud_task, heartbeat_seconds):
                yield heartbeat
            result = cloud_task.result()
        except ClientDisconnected as exc:
            await fail_escalation_wait(
                store=store,
                ledger=ledger,
                decision=decision,
                reservation=reservation,
                trace_id=trace_id,
                running=running,
                timeout_seconds=timeout_seconds,
                exc=exc,
            )
            return  # never write a response to the gone client
        except GatewayError as exc:
            await fail_escalation_wait(
                store=store,
                ledger=ledger,
                decision=decision,
                reservation=reservation,
                trace_id=trace_id,
                running=running,
                timeout_seconds=timeout_seconds,
                exc=exc,
            )
            raise
        result = await finish_escalation(
            store=store,
            ledger=ledger,
            envelope=envelope,
            trace_id=trace_id,
            running=running,
            timeout_seconds=timeout_seconds,
            reason=reason,
            decision=decision,
            reservation=reservation,
            result=result,
        )

    started = await start_response_transition(store, trace_id, running)
    include_usage = envelope.stream_options.include_usage if envelope.stream_options else False
    for event in build_replay_events(trace_id, envelope, result, include_usage=include_usage):
        yield event
    try:
        await store.transition(
            trace_id,
            expected_version=started.version,
            to_state=RequestState.response_closed,
            event_type="response_closed",
            clear_lease=True,
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc


async def idempotent_replay(
    store: TraceStore, context: ChannelContext, idempotency_key: str, digest: str
) -> Response | None:
    """Return the stored response for a duplicate key, or None for a new key.

    Without an Idempotency-Key header the endpoint is at-least-once; with one,
    same key + same body replays, same key + different body is a conflict.
    """
    try:
        existing = await store.find_by_idempotency_key(context.api_key_id, idempotency_key)
    except TraceStoreError as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc
    if existing is None:
        return None
    if existing.request_digest != digest:
        raise GatewayError(
            "idempotency_conflict",
            "Idempotency-Key was already used with a different request body",
        )
    if RequestState(existing.state) not in TERMINAL_STATES:
        raise GatewayError(
            "request_in_progress", "a request with this Idempotency-Key is still in progress"
        )
    if existing.response_body is None or existing.response_status is None:
        raise GatewayError(
            "idempotency_conflict",
            "the original request completed without a replayable response",
        )
    return Response(
        content=existing.response_body,
        status_code=existing.response_status,
        media_type="application/json",
    )


async def save_for_replay(store: TraceStore, trace_id: str, *, status: int, body: dict) -> None:
    """Persist the response so a duplicate Idempotency-Key can replay it."""
    try:
        await store.save_response(trace_id, status=status, body=json.dumps(body))
    except TraceStoreError as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc


@router.post("/v1/chat/completions", response_model=None)
async def chat_completions(
    request: Request,
    context: ChannelContext = Depends(get_channel_context),
    store: TraceStore = Depends(get_trace_store),
    provider: Provider = Depends(get_provider),
    ledger: BudgetLedger = Depends(get_budget_ledger),
) -> dict | Response:
    try:
        raw = await request.json()
    except json.JSONDecodeError as exc:
        raise GatewayError(
            "unsupported_parameter", "request body is not valid JSON", param="body"
        ) from exc
    try:
        envelope = ChatCompletionEnvelopeV1.model_validate(raw)
    except ValidationError as exc:
        raise map_validation_error(exc) from exc

    if envelope.model not in context.allowed_models:
        raise GatewayError(
            "model_not_allowed",
            f"model '{envelope.model}' is not allowed for this API key",
            param="model",
        )

    config: GatewayConfig = request.app.state.config
    timeout_seconds: int = config.local_omlx.timeout_seconds
    route: RouteDecision = select_provider(envelope, context, provider)
    digest = request_digest(raw)
    idempotency_key = request.headers.get("idempotency-key")

    if idempotency_key:
        replay = await idempotent_replay(store, context, idempotency_key, digest)
        if replay is not None:
            return replay

    trace_id = f"chatcmpl-{uuid.uuid4().hex}"
    try:
        trace = await store.create_trace(
            trace_id=trace_id,
            api_key_id=context.api_key_id,
            client_id=context.client_id,
            workspace_id=context.workspace_id,
            channel_id=context.channel_id,
            request_digest=digest,
            deadline_seconds=timeout_seconds,
            idempotency_key=idempotency_key,
        )
    except IdempotencyRaceError as exc:
        raise GatewayError(
            "request_in_progress", "a request with this Idempotency-Key is already in progress"
        ) from exc
    except TraceStoreError as exc:
        # Fail closed: no trace, no model call.
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc

    try:
        queued = await store.transition(
            trace_id, expected_version=trace.version, to_state=RequestState.queued, event_type="queued"
        )
        leased = await store.transition(
            trace_id,
            expected_version=queued.version,
            to_state=RequestState.leased,
            event_type="leased",
            lease_expires_at=datetime.now(UTC) + timedelta(seconds=timeout_seconds),
        )
        running = await store.transition(
            trace_id,
            expected_version=leased.version,
            to_state=RequestState.run_started,
            event_type="run_started",
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc

    # The provider call holds no DB transaction; the lease bounds its runtime.
    if envelope.stream:
        # V1: idempotent replay is only stored for non-streaming responses.
        return DelayedEventStreamResponse(
            stream_traced_events(
                request=request,
                ledger=ledger,
                context=context,
                store=store,
                route=route,
                envelope=envelope,
                trace_id=trace_id,
                running=running,
                timeout_seconds=timeout_seconds,
                heartbeat_seconds=config.server.sse_heartbeat_seconds,
            )
        )

    try:
        result = await execute_with_escalation(
            request=request,
            store=store,
            ledger=ledger,
            context=context,
            route=route,
            envelope=envelope,
            trace_id=trace_id,
            running=running,
            timeout_seconds=timeout_seconds,
        )
    except ClientDisconnected:
        # Abort without writing a response; the client is gone.
        raise asyncio.CancelledError from None
    except GatewayError as exc:
        if idempotency_key:
            await save_for_replay(store, trace_id, status=exc.http_status, body=exc.body())
        raise

    started = await start_response_transition(store, trace_id, running)
    try:
        await store.transition(
            trace_id,
            expected_version=started.version,
            to_state=RequestState.response_closed,
            event_type="response_closed",
            clear_lease=True,
        )
    except STORE_ERRORS as exc:
        raise GatewayError("database_unavailable", f"trace store unavailable: {exc}") from exc

    body = build_openai_response(trace_id, envelope, result)
    if idempotency_key:
        await save_for_replay(store, trace_id, status=200, body=body)
    return body


@router.get("/internal/traces/{trace_id}")
async def get_trace(
    trace_id: str,
    context: ChannelContext = Depends(get_channel_context),
    store: TraceStore = Depends(get_trace_store),
) -> dict:
    trace = await store.get_trace(trace_id)
    # Dual-key isolation: another key's trace is a 404, never a 403, so the
    # response does not leak the trace's existence.
    if trace is None or trace.api_key_id != context.api_key_id:
        raise HTTPException(status_code=404, detail=f"trace not found: {trace_id}")
    return {
        "trace_id": trace.trace_id,
        "api_key_id": trace.api_key_id,
        "client_id": trace.client_id,
        "workspace_id": trace.workspace_id,
        "channel_id": trace.channel_id,
        "state": trace.state,
        "delivery_status": trace.delivery_status,
        "version": trace.version,
        "request_digest": trace.request_digest,
        "created_at": trace.created_at.isoformat(),
    }
