"""Programmatic access to the Alembic migrations.

The app and tests run migrations through this module instead of shelling out
to the alembic CLI. `upgrade_head` runs in a worker thread because env.py
uses an async engine via asyncio.run (the documented Alembic async pattern),
which cannot run inside an already-running event loop.
"""

import asyncio
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def alembic_config_for(database_url: str) -> AlembicConfig:
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", database_url)
    return cfg


async def upgrade_head(cfg: AlembicConfig) -> None:
    await asyncio.to_thread(command.upgrade, cfg, "head")
