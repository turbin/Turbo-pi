"""FastAPI app factory: wires config, engine, migrations, and routers."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from agent_gateway.api import admin, chat
from agent_gateway.channel import ChannelRegistry
from agent_gateway.config import GatewayConfig
from agent_gateway.errors import GatewayError
from agent_gateway.providers.kimi import KimiProvider
from agent_gateway.providers.omlx import OmlxProvider
from agent_gateway.store.budget_ledger import BudgetLedger
from agent_gateway.store.engine import create_engine, create_session_factory
from agent_gateway.store.migrations_runner import alembic_config_for, upgrade_head
from agent_gateway.store.trace_store import TraceStore


def _db_file_path(database_url: str) -> Path | None:
    prefix = "sqlite+aiosqlite:///"
    if not database_url.startswith(prefix):
        return None
    path = database_url[len(prefix) :]
    if path in ("", ":memory:"):
        return None
    return Path(path)


def _build_cloud_provider(config: GatewayConfig) -> KimiProvider | None:
    """The single configured cloud provider (V1), or None when disabled or
    its env vars are missing. Escalation treats None as not permitted."""
    cloud_config = getattr(config.cloud, config.routing.selected_cloud_provider)
    if not cloud_config.enabled:
        return None
    return KimiProvider.from_config(
        cloud_config, timeout_seconds=config.local_omlx.timeout_seconds
    )


async def create_app(config: GatewayConfig) -> FastAPI:
    engine = create_engine(config.database.url)
    await upgrade_head(alembic_config_for(config.database.url))
    db_file = _db_file_path(config.database.url)
    if db_file is not None and db_file.exists():
        os.chmod(db_file, 0o600)
    provider = OmlxProvider(
        base_url=config.local_omlx.base_url,
        model=config.local_omlx.model,
        timeout_seconds=config.local_omlx.timeout_seconds,
        concurrency=config.local_omlx.concurrency,
    )
    cloud_provider = _build_cloud_provider(config)
    session_factory = create_session_factory(engine)
    trace_store = TraceStore(session_factory)
    # Lease recovery (review P0-05): traces whose lease expired while the
    # gateway was down become abandoned; providers are never called here.
    await trace_store.recover_expired_leases(datetime.now(UTC))

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        yield
        await provider.aclose()
        if cloud_provider is not None:
            await cloud_provider.aclose()
        await engine.dispose()

    app = FastAPI(title="agent-gateway", lifespan=lifespan)
    app.state.config = config
    app.state.engine = engine
    app.state.registry = ChannelRegistry(config.channels)
    app.state.trace_store = trace_store
    app.state.budget_ledger = BudgetLedger(session_factory)
    # Provider seams: tests replace these with FakeProviders before serving.
    app.state.provider = provider
    app.state.cloud_provider = cloud_provider

    @app.exception_handler(GatewayError)
    async def gateway_error_handler(_request: Request, exc: GatewayError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content=exc.body())

    app.include_router(admin.router)
    app.include_router(chat.router)

    return app
