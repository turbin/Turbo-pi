"""initial schema: request trace entities (no Rule* tables, P0-07)

Revision ID: 0001_initial
Revises:
Create Date: 2026-07-17

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "request_executions",
        sa.Column("trace_id", sa.String(), primary_key=True),
        sa.Column("api_key_id", sa.String(), nullable=False),
        sa.Column("client_id", sa.String(), nullable=False),
        sa.Column("workspace_id", sa.String(), nullable=False),
        sa.Column("channel_id", sa.String(), nullable=False),
        sa.Column("parent_trace_id", sa.String(), nullable=True),
        sa.Column("conversation_id", sa.String(), nullable=True),
        sa.Column("idempotency_key", sa.String(), nullable=True),
        sa.Column("request_digest", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("delivery_status", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("deadline_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_request_executions_idempotency",
        "request_executions",
        ["api_key_id", "idempotency_key"],
    )
    op.create_index(
        "ix_request_executions_channel",
        "request_executions",
        ["channel_id", "created_at"],
    )

    op.create_table(
        "model_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("trace_id", sa.String(), sa.ForeignKey("request_executions.trace_id"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("provider_attempt", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("timeout_ms", sa.Integer(), nullable=True),
        sa.Column("quality_signals_json", sa.String(), nullable=True),
        sa.Column("usage_source", sa.String(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost_micro_usd", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(), nullable=True),
    )

    op.create_table(
        "budget_reservations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("channel_id", sa.String(), nullable=False),
        sa.Column("period_yyyymm", sa.String(), nullable=False),
        sa.Column("reserved_micro_usd", sa.Integer(), nullable=False),
        sa.Column("charged_micro_usd", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("trace_id", sa.String(), sa.ForeignKey("request_executions.trace_id"), nullable=False),
    )

    op.create_table(
        "trace_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("trace_id", sa.String(), sa.ForeignKey("request_executions.trace_id"), nullable=False),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("from_state", sa.String(), nullable=True),
        sa.Column("to_state", sa.String(), nullable=True),
        sa.Column("payload_json", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "verifications",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("trace_id", sa.String(), sa.ForeignKey("request_executions.trace_id"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("evidence_redacted", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("trace_id", sa.String(), sa.ForeignKey("request_executions.trace_id"), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("supersedes_id", sa.Integer(), nullable=True),
        sa.Column("idempotency_key", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("feedback")
    op.drop_table("verifications")
    op.drop_table("trace_events")
    op.drop_table("budget_reservations")
    op.drop_table("model_runs")
    op.drop_index("ix_request_executions_channel", table_name="request_executions")
    op.drop_index("ix_request_executions_idempotency", table_name="request_executions")
    op.drop_table("request_executions")
