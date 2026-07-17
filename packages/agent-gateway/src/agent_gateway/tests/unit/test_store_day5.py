"""Day 5 store additions: idempotency lookup/race, response storage, events,
expired-lease recovery."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_gateway.statemachine import RequestState
from agent_gateway.store.trace_store import IdempotencyRaceError, TraceStore


@pytest.fixture
def store(session_factory: async_sessionmaker[AsyncSession]) -> TraceStore:
    return TraceStore(session_factory)


async def make_trace(store: TraceStore, trace_id: str, **overrides: object) -> None:
    kwargs: dict = {
        "trace_id": trace_id,
        "api_key_id": "key-1",
        "client_id": "client",
        "workspace_id": "ws",
        "channel_id": "ch",
        "request_digest": "digest",
        "deadline_seconds": 60,
    }
    kwargs.update(overrides)
    await store.create_trace(**kwargs)  # type: ignore[arg-type]


async def test_find_by_idempotency_key(store: TraceStore) -> None:
    await make_trace(store, "chatcmpl-a", idempotency_key="idem-1")
    found = await store.find_by_idempotency_key("key-1", "idem-1")
    assert found is not None
    assert found.trace_id == "chatcmpl-a"
    # A different api_key_id does not see the key.
    assert await store.find_by_idempotency_key("key-2", "idem-1") is None
    assert await store.find_by_idempotency_key("key-1", "other") is None


async def test_duplicate_idempotency_key_races(store: TraceStore) -> None:
    await make_trace(store, "chatcmpl-a", idempotency_key="idem-1")
    with pytest.raises(IdempotencyRaceError):
        await make_trace(store, "chatcmpl-b", idempotency_key="idem-1")
    # Same key under another api_key_id is a different idempotency scope.
    await make_trace(store, "chatcmpl-c", api_key_id="key-2", idempotency_key="idem-1")
    # Requests without a key never conflict.
    await make_trace(store, "chatcmpl-d")
    await make_trace(store, "chatcmpl-e")


async def test_save_response_roundtrip(store: TraceStore) -> None:
    await make_trace(store, "chatcmpl-a", idempotency_key="idem-1")
    trace = await store.get_trace("chatcmpl-a")
    assert trace is not None
    assert trace.response_body is None
    await store.save_response("chatcmpl-a", status=200, body='{"ok": true}')
    trace = await store.get_trace("chatcmpl-a")
    assert trace is not None
    assert trace.response_status == 200
    assert trace.response_body == '{"ok": true}'


async def test_record_event_appends_without_state_change(store: TraceStore) -> None:
    await make_trace(store, "chatcmpl-a")
    await store.record_event(
        "chatcmpl-a",
        event_type="dlp_blocked",
        payload={"findings": [{"pattern": "aws_access_key_id", "location": "messages[0].content"}]},
    )
    events = await store.list_events("chatcmpl-a")
    assert [event.event_type for event in events] == ["received", "dlp_blocked"]
    trace = await store.get_trace("chatcmpl-a")
    assert trace is not None
    assert trace.state == "received"
    assert trace.version == 0


async def test_recover_expired_leases_marks_abandoned(store: TraceStore) -> None:
    now = datetime.now(UTC)
    await make_trace(store, "chatcmpl-stale")
    queued = await store.transition(
        "chatcmpl-stale", expected_version=0, to_state=RequestState.queued, event_type="queued"
    )
    await store.transition(
        "chatcmpl-stale",
        expected_version=queued.version,
        to_state=RequestState.leased,
        event_type="leased",
        lease_expires_at=now - timedelta(seconds=1),
    )
    # A run_started trace with an expired lease is also recovered.
    await make_trace(store, "chatcmpl-stale-2")
    q2 = await store.transition(
        "chatcmpl-stale-2", expected_version=0, to_state=RequestState.queued, event_type="queued"
    )
    l2 = await store.transition(
        "chatcmpl-stale-2",
        expected_version=q2.version,
        to_state=RequestState.leased,
        event_type="leased",
        lease_expires_at=now - timedelta(seconds=1),
    )
    await store.transition(
        "chatcmpl-stale-2",
        expected_version=l2.version,
        to_state=RequestState.run_started,
        event_type="run_started",
    )
    # A leased trace with a live lease is left alone.
    await make_trace(store, "chatcmpl-live")
    q3 = await store.transition(
        "chatcmpl-live", expected_version=0, to_state=RequestState.queued, event_type="queued"
    )
    await store.transition(
        "chatcmpl-live",
        expected_version=q3.version,
        to_state=RequestState.leased,
        event_type="leased",
        lease_expires_at=now + timedelta(seconds=600),
    )

    recovered = await store.recover_expired_leases(now)
    assert recovered == 2

    stale = await store.get_trace("chatcmpl-stale")
    assert stale is not None
    assert stale.state == "abandoned"
    assert stale.lease_expires_at is None
    assert stale.completed_at is not None
    events = await store.list_events("chatcmpl-stale")
    assert events[-1].event_type == "lease_expired_recovery"

    stale2 = await store.get_trace("chatcmpl-stale-2")
    assert stale2 is not None
    assert stale2.state == "abandoned"

    live = await store.get_trace("chatcmpl-live")
    assert live is not None
    assert live.state == "leased"
    assert live.lease_expires_at is not None
