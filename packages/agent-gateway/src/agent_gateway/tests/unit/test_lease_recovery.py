"""Day 5: startup lease recovery (review P0-05) and DB file permissions."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from agent_gateway.api.chat import request_digest
from agent_gateway.channel import api_key_id_for
from agent_gateway.config import load_config
from agent_gateway.main import create_app
from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.statemachine import RequestState
from agent_gateway.store.engine import create_session_factory
from agent_gateway.store.models import ModelRun, RequestExecution

from .conftest import KEY_1
from .test_api import auth, chat_payload
from .test_config import VALID_CONFIG, write_config


async def test_startup_recovers_expired_leases(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path, VALID_CONFIG))

    # Seed a stale trace: leased, lease already expired (gateway died mid-run).
    first = await create_app(config)
    store = first.state.trace_store
    await store.create_trace(
        trace_id="chatcmpl-stale",
        api_key_id="key-1",
        client_id="client",
        workspace_id="ws",
        channel_id="ch-a",
        request_digest="digest",
        deadline_seconds=60,
    )
    queued = await store.transition(
        "chatcmpl-stale", expected_version=0, to_state=RequestState.queued, event_type="queued"
    )
    await store.transition(
        "chatcmpl-stale",
        expected_version=queued.version,
        to_state=RequestState.leased,
        event_type="leased",
        lease_expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    await first.state.engine.dispose()

    # Restart: the sweep abandons the stale trace without any provider call.
    second = await create_app(config)
    trace = await second.state.trace_store.get_trace("chatcmpl-stale")
    assert trace is not None
    assert trace.state == "abandoned"
    assert trace.lease_expires_at is None
    assert trace.completed_at is not None

    events = await second.state.trace_store.list_events("chatcmpl-stale")
    assert events[-1].event_type == "lease_expired_recovery"

    # Recovery never issues provider calls -> no ModelRun rows exist.
    async with create_session_factory(second.state.engine)() as session:
        runs = list((await session.execute(select(ModelRun))).scalars().all())
    assert runs == []
    await second.state.engine.dispose()


async def test_db_file_permissions_are_owner_only(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path, VALID_CONFIG))
    app = await create_app(config)
    mode = (tmp_path / "gw.db").stat().st_mode & 0o777
    assert mode == 0o600
    await app.state.engine.dispose()


@pytest.mark.parametrize("stuck_state", [RequestState.received, RequestState.queued])
async def test_startup_recovers_deadline_exceeded_trace_and_frees_idempotency_key(
    tmp_path: Path, stuck_state: RequestState
) -> None:
    """A crash between create_trace and the leased transition strands a
    received/queued trace forever; its Idempotency-Key then bricks retries.
    The startup sweep must abandon such traces (deadline passed, no lease) and
    free the key so the same key + body re-executes instead of 409ing."""
    config = load_config(write_config(tmp_path, VALID_CONFIG))
    body = chat_payload()

    first = await create_app(config)
    store = first.state.trace_store
    await store.create_trace(
        trace_id="chatcmpl-stuck",
        api_key_id=api_key_id_for(KEY_1),
        client_id="lobsterai",
        workspace_id="ws-a",
        channel_id="ch-a",
        request_digest=request_digest(body),
        deadline_seconds=-1,  # deadline already passed
        idempotency_key="idem-stuck",
    )
    if stuck_state == RequestState.queued:
        await store.transition(
            "chatcmpl-stuck", expected_version=0, to_state=RequestState.queued, event_type="queued"
        )
    await first.state.engine.dispose()

    # Restart: the sweep abandons the stuck trace and frees the key.
    second = await create_app(config)
    trace = await second.state.trace_store.get_trace("chatcmpl-stuck")
    assert trace is not None
    assert trace.state == "abandoned"
    assert trace.idempotency_key is None
    events = await second.state.trace_store.list_events("chatcmpl-stuck")
    assert events[-1].event_type == "lease_expired_recovery"

    # A retry with the same key + same body re-executes (no 409).
    fake = FakeProvider()
    fake.push(
        ModelResult(
            content="重试成功",
            tool_calls=None,
            finish_reason="stop",
            prompt_tokens=2,
            completion_tokens=3,
            total_tokens=5,
        )
    )
    second.state.provider = fake
    transport = httpx.ASGITransport(app=second)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/v1/chat/completions",
            json=body,
            headers={**auth(KEY_1), "Idempotency-Key": "idem-stuck"},
        )
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "重试成功"
    assert len(fake.received) == 1

    async with create_session_factory(second.state.engine)() as session:
        count = await session.execute(select(func.count()).select_from(RequestExecution))
    assert int(count.scalar_one()) == 2  # abandoned original + fresh retry trace
    await second.state.engine.dispose()
