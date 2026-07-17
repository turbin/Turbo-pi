"""RequestExecution persistence: trace creation and CAS state transitions.

Trace creation failure raises TraceStoreError so callers can fail closed
(never call a model without a trace). Transitions use a version CAS and
append a TraceEvent in the same short transaction.
"""

import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_gateway.statemachine import ALLOWED_TRANSITIONS, RequestState
from agent_gateway.store.models import ModelRun, RequestExecution, TraceEvent


class TraceStoreError(Exception):
    """Trace persistence failed; callers must fail closed."""


class ConcurrencyConflict(Exception):
    """The version CAS did not match; another writer moved the trace."""


class InvalidTransition(Exception):
    """The requested state transition is not allowed."""


class IdempotencyRaceError(Exception):
    """Another request inserted the same idempotency key first."""


class TraceStore:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_trace(
        self,
        *,
        trace_id: str,
        api_key_id: str,
        client_id: str,
        workspace_id: str,
        channel_id: str,
        request_digest: str,
        deadline_seconds: int,
        parent_trace_id: str | None = None,
        conversation_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> RequestExecution:
        now = datetime.now(UTC)
        trace = RequestExecution(
            trace_id=trace_id,
            api_key_id=api_key_id,
            client_id=client_id,
            workspace_id=workspace_id,
            channel_id=channel_id,
            parent_trace_id=parent_trace_id,
            conversation_id=conversation_id,
            idempotency_key=idempotency_key,
            request_digest=request_digest,
            state=RequestState.received.value,
            delivery_status="pending",
            version=0,
            lease_expires_at=None,
            deadline_at=now + timedelta(seconds=deadline_seconds),
            created_at=now,
            completed_at=None,
        )
        try:
            async with self._session_factory() as session:
                session.add(trace)
                session.add(
                    TraceEvent(
                        trace_id=trace_id,
                        event_type="received",
                        from_state=None,
                        to_state=RequestState.received.value,
                        payload_json=None,
                        created_at=now,
                    )
                )
                await session.commit()
        except IntegrityError as exc:
            # The unique (api_key_id, idempotency_key) index fired: a duplicate
            # request raced us and is now in flight.
            raise IdempotencyRaceError(f"duplicate idempotency key for trace {trace_id}") from exc
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to create trace {trace_id}: {exc}") from exc
        return trace

    async def get_trace(self, trace_id: str) -> RequestExecution | None:
        async with self._session_factory() as session:
            result = await session.execute(
                select(RequestExecution).where(RequestExecution.trace_id == trace_id)
            )
            return result.scalar_one_or_none()

    async def list_events(self, trace_id: str) -> list[TraceEvent]:
        async with self._session_factory() as session:
            result = await session.execute(
                select(TraceEvent).where(TraceEvent.trace_id == trace_id).order_by(TraceEvent.id)
            )
            return list(result.scalars().all())

    async def transition(
        self,
        trace_id: str,
        *,
        expected_version: int,
        to_state: RequestState,
        event_type: str,
        lease_expires_at: datetime | None = None,
        clear_lease: bool = False,
        payload: dict[str, str] | None = None,
    ) -> RequestExecution:
        """CAS transition: succeeds only if the row still has expected_version."""
        try:
            async with self._session_factory() as session:
                current = await session.execute(
                    select(RequestExecution.state).where(RequestExecution.trace_id == trace_id)
                )
                row = current.scalar_one_or_none()
                if row is None:
                    raise TraceStoreError(f"trace not found: {trace_id}")
                from_state = RequestState(row)
                if to_state not in ALLOWED_TRANSITIONS[from_state]:
                    raise InvalidTransition(f"{from_state.value} -> {to_state.value} not allowed")

                values: dict[str, object] = {"state": to_state.value, "version": expected_version + 1}
                if lease_expires_at is not None:
                    values["lease_expires_at"] = lease_expires_at
                elif clear_lease:
                    values["lease_expires_at"] = None
                if to_state in (
                    RequestState.response_closed,
                    RequestState.cancelled,
                    RequestState.failed,
                    RequestState.abandoned,
                ):
                    values["completed_at"] = datetime.now(UTC)
                result = await session.execute(
                    update(RequestExecution)
                    .where(
                        RequestExecution.trace_id == trace_id,
                        RequestExecution.version == expected_version,
                    )
                    .values(**values)
                )
                if result.rowcount != 1:
                    raise ConcurrencyConflict(
                        f"trace {trace_id}: version {expected_version} no longer current"
                    )
                session.add(
                    TraceEvent(
                        trace_id=trace_id,
                        event_type=event_type,
                        from_state=from_state.value,
                        to_state=to_state.value,
                        payload_json=json.dumps(payload) if payload else None,
                        created_at=datetime.now(UTC),
                    )
                )
                await session.commit()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to transition trace {trace_id}: {exc}") from exc

        updated = await self.get_trace(trace_id)
        if updated is None:
            raise TraceStoreError(f"trace disappeared after transition: {trace_id}")
        return updated

    async def record_model_run(
        self,
        *,
        trace_id: str,
        sequence: int,
        purpose: str,
        provider: str,
        state: str,
        timeout_ms: int | None = None,
        quality_signals: dict[str, object] | None = None,
        usage_source: str | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        error_code: str | None = None,
    ) -> ModelRun:
        """Persist one upstream attempt; runs in its own short transaction."""
        run = ModelRun(
            trace_id=trace_id,
            sequence=sequence,
            purpose=purpose,
            provider=provider,
            provider_attempt=0,
            state=state,
            timeout_ms=timeout_ms,
            quality_signals_json=json.dumps(quality_signals) if quality_signals else None,
            usage_source=usage_source,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_micro_usd=None,
            error_code=error_code,
        )
        try:
            async with self._session_factory() as session:
                session.add(run)
                await session.commit()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to record model run for {trace_id}: {exc}") from exc
        return run

    async def find_by_idempotency_key(
        self, api_key_id: str, idempotency_key: str
    ) -> RequestExecution | None:
        try:
            async with self._session_factory() as session:
                result = await session.execute(
                    select(RequestExecution).where(
                        RequestExecution.api_key_id == api_key_id,
                        RequestExecution.idempotency_key == idempotency_key,
                    )
                )
                return result.scalar_one_or_none()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to look up idempotency key: {exc}") from exc

    async def save_response(self, trace_id: str, *, status: int, body: str) -> None:
        """Store the final response for idempotent replay.

        Only called for requests that carried an Idempotency-Key header; the
        gateway otherwise never persists response bodies.
        """
        try:
            async with self._session_factory() as session:
                result = await session.execute(
                    update(RequestExecution)
                    .where(RequestExecution.trace_id == trace_id)
                    .values(response_status=status, response_body=body)
                )
                if result.rowcount != 1:
                    raise TraceStoreError(f"trace not found: {trace_id}")
                await session.commit()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to save response for {trace_id}: {exc}") from exc

    async def record_event(
        self, trace_id: str, *, event_type: str, payload: dict[str, object] | None = None
    ) -> None:
        """Append a TraceEvent without a state change (e.g. dlp_blocked)."""
        try:
            async with self._session_factory() as session:
                session.add(
                    TraceEvent(
                        trace_id=trace_id,
                        event_type=event_type,
                        from_state=None,
                        to_state=None,
                        payload_json=json.dumps(payload) if payload else None,
                        created_at=datetime.now(UTC),
                    )
                )
                await session.commit()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to record event for {trace_id}: {exc}") from exc

    async def release_idempotency_key(self, trace_id: str) -> None:
        """Detach the idempotency key from a trace abandoned before any
        provider call, so a retry with the same key re-executes instead of
        conflicting with the stranded row."""
        try:
            async with self._session_factory() as session:
                await session.execute(
                    update(RequestExecution)
                    .where(RequestExecution.trace_id == trace_id)
                    .values(idempotency_key=None)
                )
                await session.commit()
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to release idempotency key for {trace_id}: {exc}") from exc

    async def recover_expired_leases(self, now: datetime) -> int:
        """Sweep stale traces -> abandoned.

        Two classes: leased/run_started traces whose lease expired, and
        received/queued traces whose deadline passed (a crash between
        create_trace and the leased transition leaves those without a lease).
        The latter never reached a provider call, so their idempotency key is
        released for a retry. Runs at startup; never calls a provider and
        never re-issues cloud calls. Returns the number of recovered traces.
        """
        running_states = (RequestState.leased.value, RequestState.run_started.value)
        pending_states = (RequestState.received.value, RequestState.queued.value)
        try:
            async with self._session_factory() as session:
                result = await session.execute(
                    select(RequestExecution).where(
                        or_(
                            and_(
                                RequestExecution.state.in_(running_states),
                                RequestExecution.lease_expires_at.is_not(None),
                                RequestExecution.lease_expires_at < now,
                            ),
                            and_(
                                RequestExecution.state.in_(pending_states),
                                RequestExecution.deadline_at < now,
                            ),
                        )
                    )
                )
                stale = list(result.scalars().all())
        except SQLAlchemyError as exc:
            raise TraceStoreError(f"failed to sweep expired leases: {exc}") from exc

        recovered = 0
        for trace in stale:
            reason = "lease_expired" if trace.state in running_states else "deadline_exceeded"
            try:
                await self.transition(
                    trace.trace_id,
                    expected_version=trace.version,
                    to_state=RequestState.abandoned,
                    event_type="lease_expired_recovery",
                    clear_lease=True,
                    payload={"reason": reason},
                )
            except (ConcurrencyConflict, InvalidTransition):
                continue  # a live worker moved it first; leave it alone
            if reason == "deadline_exceeded" and trace.idempotency_key is not None:
                await self.release_idempotency_key(trace.trace_id)
            recovered += 1
        return recovered
