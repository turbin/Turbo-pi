"""add version column to budget_reservations for CAS reconcile/release

Revision ID: 0003_budget_version
Revises: 0002_idempotency_replay
Create Date: 2026-07-18

- budget_reservations gains a version column used for optimistic locking
  during reconcile and release.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_budget_version"
down_revision: str | None = "0002_idempotency_replay"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("budget_reservations", sa.Column("version", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("budget_reservations", "version")
