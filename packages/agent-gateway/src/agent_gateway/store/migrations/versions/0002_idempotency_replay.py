"""idempotent replay storage + unique idempotency key

Revision ID: 0002_idempotency_replay
Revises: 0001_initial
Create Date: 2026-07-17

- request_executions gains response_status/response_body, populated only for
  requests that carried an Idempotency-Key header.
- (api_key_id, idempotency_key) becomes unique; SQLite treats NULLs as
  distinct, so requests without a key are unaffected.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_idempotency_replay"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("request_executions", sa.Column("response_status", sa.Integer(), nullable=True))
    op.add_column("request_executions", sa.Column("response_body", sa.String(), nullable=True))
    op.drop_index("ix_request_executions_idempotency", table_name="request_executions")
    op.create_index(
        "uq_request_executions_idempotency",
        "request_executions",
        ["api_key_id", "idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_request_executions_idempotency", table_name="request_executions")
    op.create_index(
        "ix_request_executions_idempotency",
        "request_executions",
        ["api_key_id", "idempotency_key"],
    )
    op.drop_column("request_executions", "response_body")
    op.drop_column("request_executions", "response_status")
