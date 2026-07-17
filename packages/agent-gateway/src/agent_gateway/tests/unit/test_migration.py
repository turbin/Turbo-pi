import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig

from agent_gateway.store.migrations_runner import alembic_config_for

EXPECTED_TABLES = {
    "request_executions",
    "model_runs",
    "budget_reservations",
    "trace_events",
    "verifications",
    "feedback",
}


def table_names(db_path: Path) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {row[0] for row in rows}


def test_migration_upgrade_creates_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "mig.db"
    cfg: AlembicConfig = alembic_config_for(f"sqlite+aiosqlite:///{db_path}")
    command.upgrade(cfg, "head")
    assert EXPECTED_TABLES <= table_names(db_path)


def test_migration_downgrade_drops_tables(tmp_path: Path) -> None:
    db_path = tmp_path / "mig.db"
    cfg = alembic_config_for(f"sqlite+aiosqlite:///{db_path}")
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    assert not (EXPECTED_TABLES & table_names(db_path))
