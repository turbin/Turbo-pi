"""Day 5: atomic budget reservations (plan 5.4, review P0-04)."""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_gateway.store.budget_ledger import (
    BudgetExceeded,
    BudgetLedger,
    ReservationNotOpen,
)
from agent_gateway.store.models import BudgetReservation
from agent_gateway.store.trace_store import TraceStore

CHANNEL = "ch-b"
PERIOD = "202607"


@pytest.fixture
def ledger(session_factory: async_sessionmaker[AsyncSession]) -> BudgetLedger:
    return BudgetLedger(session_factory)


@pytest.fixture
async def trace_id(session_factory: async_sessionmaker[AsyncSession]) -> str:
    store = TraceStore(session_factory)
    trace = await store.create_trace(
        trace_id="chatcmpl-budget-test",
        api_key_id="key",
        client_id="client",
        workspace_id="ws",
        channel_id=CHANNEL,
        request_digest="digest",
        deadline_seconds=60,
    )
    return trace.trace_id


async def fetch_reservations(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[BudgetReservation]:
    async with session_factory() as session:
        result = await session.execute(select(BudgetReservation))
        return list(result.scalars().all())


async def test_reserve_within_cap(
    ledger: BudgetLedger, trace_id: str, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    reservation = await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=100_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    assert reservation.state == "reserved"
    assert reservation.reserved_micro_usd == 100_000
    assert reservation.charged_micro_usd == 0
    rows = await fetch_reservations(session_factory)
    assert len(rows) == 1


async def test_reserve_over_cap_rejected(ledger: BudgetLedger, trace_id: str) -> None:
    await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=900_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    with pytest.raises(BudgetExceeded):
        await ledger.reserve(
            channel_id=CHANNEL,
            period_yyyymm=PERIOD,
            micro_usd=200_000,
            cap_micro_usd=1_000_000,
            trace_id=trace_id,
        )


async def test_concurrent_reserves_cannot_oversell(
    ledger: BudgetLedger, trace_id: str, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    cap = 1_000_000
    attempts = 5
    amount = 300_000  # 3 fit, 2 must fail

    async def attempt() -> str:
        try:
            await ledger.reserve(
                channel_id=CHANNEL,
                period_yyyymm=PERIOD,
                micro_usd=amount,
                cap_micro_usd=cap,
                trace_id=trace_id,
            )
        except BudgetExceeded:
            return "rejected"
        return "reserved"

    outcomes = await asyncio.gather(*(attempt() for _ in range(attempts)))
    assert outcomes.count("reserved") == 3
    assert outcomes.count("rejected") == 2
    rows = await fetch_reservations(session_factory)
    assert sum(row.reserved_micro_usd for row in rows) <= cap


async def test_reconcile_charges_actual_and_releases_remainder(
    ledger: BudgetLedger, trace_id: str
) -> None:
    reservation = await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=100_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    await ledger.reconcile(reservation.id, used_micro_usd=40_000)

    # Only the charged 40_000 counts against the cap now; 960_000 fits again.
    await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=960_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    with pytest.raises(BudgetExceeded):
        await ledger.reserve(
            channel_id=CHANNEL,
            period_yyyymm=PERIOD,
            micro_usd=1,
            cap_micro_usd=1_000_000,
            trace_id=trace_id,
        )


async def test_release_frees_reservation(ledger: BudgetLedger, trace_id: str) -> None:
    reservation = await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=900_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    await ledger.release(reservation.id)
    # The released amount is fully available again.
    await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=1_000_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )


async def test_uncapped_channel_never_rejected(ledger: BudgetLedger, trace_id: str) -> None:
    for _ in range(3):
        await ledger.reserve(
            channel_id=CHANNEL,
            period_yyyymm=PERIOD,
            micro_usd=10**12,
            cap_micro_usd=None,
            trace_id=trace_id,
        )


async def test_cap_is_per_channel_and_period(ledger: BudgetLedger, trace_id: str) -> None:
    await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=1_000_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    # Different channel and different period each have their own budget.
    await ledger.reserve(
        channel_id="ch-a",
        period_yyyymm=PERIOD,
        micro_usd=1_000_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )
    await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm="202608",
        micro_usd=1_000_000,
        cap_micro_usd=1_000_000,
        trace_id=trace_id,
    )


async def test_reconcile_twice_rejected(ledger: BudgetLedger, trace_id: str) -> None:
    reservation = await ledger.reserve(
        channel_id=CHANNEL,
        period_yyyymm=PERIOD,
        micro_usd=100,
        cap_micro_usd=None,
        trace_id=trace_id,
    )
    await ledger.reconcile(reservation.id, used_micro_usd=50)
    with pytest.raises(ReservationNotOpen):
        await ledger.reconcile(reservation.id, used_micro_usd=50)
