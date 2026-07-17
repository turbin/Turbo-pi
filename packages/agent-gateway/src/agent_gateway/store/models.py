"""ORM entities (review section 5.3).

Rule* tables are intentionally absent: rule learning is deferred (P0-07).
"""

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class RequestExecution(Base):
    __tablename__ = "request_executions"

    trace_id: Mapped[str] = mapped_column(primary_key=True)
    api_key_id: Mapped[str]
    client_id: Mapped[str]
    workspace_id: Mapped[str]
    channel_id: Mapped[str]
    parent_trace_id: Mapped[str | None]
    conversation_id: Mapped[str | None]
    idempotency_key: Mapped[str | None]
    request_digest: Mapped[str]
    state: Mapped[str]
    delivery_status: Mapped[str]
    version: Mapped[int] = mapped_column(default=0)
    lease_expires_at: Mapped[datetime | None]
    deadline_at: Mapped[datetime]
    created_at: Mapped[datetime]
    completed_at: Mapped[datetime | None]
    # Idempotent replay storage (Day 5): populated only when the request
    # carried an Idempotency-Key header; bodies are otherwise never persisted.
    response_status: Mapped[int | None]
    response_body: Mapped[str | None]

    __table_args__ = (
        Index(
            "uq_request_executions_idempotency",
            "api_key_id",
            "idempotency_key",
            unique=True,
        ),
        Index("ix_request_executions_channel", "channel_id", "created_at"),
    )


class ModelRun(Base):
    __tablename__ = "model_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(ForeignKey("request_executions.trace_id"))
    sequence: Mapped[int]
    purpose: Mapped[str]
    provider: Mapped[str]
    provider_attempt: Mapped[int] = mapped_column(default=0)
    state: Mapped[str]
    timeout_ms: Mapped[int | None]
    quality_signals_json: Mapped[str | None]
    usage_source: Mapped[str | None]
    input_tokens: Mapped[int | None]
    output_tokens: Mapped[int | None]
    cost_micro_usd: Mapped[int | None]
    error_code: Mapped[str | None]


class BudgetReservation(Base):
    __tablename__ = "budget_reservations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[str]
    period_yyyymm: Mapped[str]
    reserved_micro_usd: Mapped[int]
    charged_micro_usd: Mapped[int] = mapped_column(default=0)
    state: Mapped[str]
    trace_id: Mapped[str] = mapped_column(ForeignKey("request_executions.trace_id"))


class TraceEvent(Base):
    __tablename__ = "trace_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(ForeignKey("request_executions.trace_id"))
    event_type: Mapped[str]
    from_state: Mapped[str | None]
    to_state: Mapped[str | None]
    payload_json: Mapped[str | None]
    created_at: Mapped[datetime]


class Verification(Base):
    __tablename__ = "verifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(ForeignKey("request_executions.trace_id"))
    kind: Mapped[str]
    status: Mapped[str]
    source: Mapped[str]
    evidence_redacted: Mapped[str | None]
    created_at: Mapped[datetime]


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trace_id: Mapped[str] = mapped_column(ForeignKey("request_executions.trace_id"))
    label: Mapped[str]
    source: Mapped[str]
    confidence: Mapped[float]
    state: Mapped[str]
    supersedes_id: Mapped[int | None]
    idempotency_key: Mapped[str | None]
