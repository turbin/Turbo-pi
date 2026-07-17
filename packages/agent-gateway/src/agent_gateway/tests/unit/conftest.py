from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, AsyncSession

from agent_gateway.config import GatewayConfig, load_config
from agent_gateway.main import create_app
from agent_gateway.providers.fake import FakeProvider
from agent_gateway.store.engine import create_engine, create_session_factory
from agent_gateway.store.migrations_runner import alembic_config_for, upgrade_head
from .test_config import VALID_CONFIG, write_config

KEY_1 = "test-key-1"
KEY_2 = "test-key-2"


@pytest.fixture
def config(tmp_path: Path) -> GatewayConfig:
    return load_config(write_config(tmp_path, VALID_CONFIG))


@pytest.fixture
async def engine(config: GatewayConfig) -> AsyncIterator[AsyncEngine]:
    eng = create_engine(config.database.url)
    await upgrade_head(alembic_config_for(config.database.url))
    yield eng
    await eng.dispose()


@pytest.fixture
def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(engine)


@pytest.fixture
def fake_provider() -> FakeProvider:
    """Scriptable provider injected into the app so tests never hit the network."""
    return FakeProvider()


@pytest.fixture
def fake_cloud() -> FakeProvider:
    """Scriptable cloud provider injected into the escalation seam (Day 5)."""
    return FakeProvider()


@pytest.fixture
async def app(config: GatewayConfig, fake_provider: FakeProvider, fake_cloud: FakeProvider) -> FastAPI:
    application = await create_app(config)
    application.state.provider = fake_provider
    application.state.cloud_provider = fake_cloud
    return application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
