import pytest

from agent_gateway.statemachine import RequestState
from agent_gateway.store.trace_store import ConcurrencyConflict, TraceStore, TraceStoreError


async def test_create_trace_initial_state(session_factory) -> None:
    store = TraceStore(session_factory)
    trace = await store.create_trace(
        trace_id="trace-1",
        api_key_id="key-id-1",
        client_id="lobsterai",
        workspace_id="ws-a",
        channel_id="ch-a",
        request_digest="digest-1",
        deadline_seconds=120,
    )
    assert trace.state == RequestState.received.value
    assert trace.version == 0
    assert trace.delivery_status == "pending"


async def test_cas_transition_success(session_factory) -> None:
    store = TraceStore(session_factory)
    await store.create_trace(
        trace_id="trace-2",
        api_key_id="key-id-1",
        client_id="lobsterai",
        workspace_id="ws-a",
        channel_id="ch-a",
        request_digest="digest-2",
        deadline_seconds=120,
    )
    updated = await store.transition(
        "trace-2",
        expected_version=0,
        to_state=RequestState.queued,
        event_type="queued",
    )
    assert updated.state == RequestState.queued.value
    assert updated.version == 1
    events = await store.list_events("trace-2")
    assert len(events) == 2
    assert events[0].to_state == RequestState.received.value
    assert events[1].to_state == RequestState.queued.value


async def test_cas_transition_conflict_detected(session_factory) -> None:
    store = TraceStore(session_factory)
    await store.create_trace(
        trace_id="trace-3",
        api_key_id="key-id-1",
        client_id="lobsterai",
        workspace_id="ws-a",
        channel_id="ch-a",
        request_digest="digest-3",
        deadline_seconds=120,
    )
    await store.transition("trace-3", expected_version=0, to_state=RequestState.queued, event_type="queued")
    with pytest.raises(ConcurrencyConflict):
        await store.transition("trace-3", expected_version=0, to_state=RequestState.leased, event_type="leased")


async def test_create_trace_fails_closed(tmp_path) -> None:
    from agent_gateway.store.engine import create_engine, create_session_factory

    bad_engine = create_engine(f"sqlite+aiosqlite:///{tmp_path}/no-such-dir/gw.db")
    store = TraceStore(create_session_factory(bad_engine))
    with pytest.raises(TraceStoreError):
        await store.create_trace(
            trace_id="trace-x",
            api_key_id="key-id-1",
            client_id="lobsterai",
            workspace_id="ws-a",
            channel_id="ch-a",
            request_digest="digest-x",
            deadline_seconds=120,
        )
    await bad_engine.dispose()
