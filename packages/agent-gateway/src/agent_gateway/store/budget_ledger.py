"""Atomic budget reservations (plan 5.4, review P0-04).

`reserve` runs inside a SQLite BEGIN IMMEDIATE transaction: the write lock is
held while the current period usage is summed and the new reservation is
inserted, so concurrent reserves cannot oversell the per-(channel, period)
cap. Usage counts open reservations at their reserved amount and reconciled
reservations at their charged amount; released reservations count nothing.

`reconcile` charges actual usage after the cloud run (releasing the
remainder implicitly); `release` frees the whole reservation on provider
failure.
"""

from sqlalchemy import case, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_gateway.store.models import BudgetReservation

STATE_RESERVED = "reserved"
STATE_RECONCILED = "reconciled"
STATE_RELEASED = "released"


class BudgetLedgerError(Exception):
    """Budget persistence failed; callers must fail closed."""


class BudgetExceeded(Exception):
    """The reservation would exceed the (channel, period) cap."""


class ReservationNotOpen(Exception):
    """The reservation was already reconciled or released."""


class BudgetLedger:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def reserve(
        self,
        *,
        channel_id: str,
        period_yyyymm: str,
        micro_usd: int,
        cap_micro_usd: int | None,
        trace_id: str,
    ) -> BudgetReservation:
        """Insert a reservation iff it fits under the cap; atomic via BEGIN IMMEDIATE."""
        reservation = BudgetReservation(
            channel_id=channel_id,
            period_yyyymm=period_yyyymm,
            reserved_micro_usd=micro_usd,
            charged_micro_usd=0,
            state=STATE_RESERVED,
            trace_id=trace_id,
        )
        try:
            async with self._session_factory() as session:
                await session.execute(text("BEGIN IMMEDIATE"))
                in_use = await self._usage_in_period(session, channel_id, period_yyyymm)
                if cap_micro_usd is not None and in_use + micro_usd > cap_micro_usd:
                    await session.rollback()
                    raise BudgetExceeded(
                        f"budget exceeded for channel {channel_id} in {period_yyyymm}: "
                        f"{in_use} + {micro_usd} > {cap_micro_usd} micro_usd"
                    )
                session.add(reservation)
                await session.commit()
        except SQLAlchemyError as exc:
            raise BudgetLedgerError(f"failed to reserve budget: {exc}") from exc
        return reservation

    async def reconcile(self, reservation_id: int, used_micro_usd: int) -> None:
        """Charge actual usage; the unspent remainder of the reservation is freed."""
        await self._close_reservation(
            reservation_id,
            values={"charged_micro_usd": used_micro_usd, "state": STATE_RECONCILED},
        )

    async def release(self, reservation_id: int) -> None:
        """Free the whole reservation (cloud call failed before completion)."""
        await self._close_reservation(
            reservation_id,
            values={"charged_micro_usd": 0, "state": STATE_RELEASED},
        )

    async def _usage_in_period(
        self, session: AsyncSession, channel_id: str, period_yyyymm: str
    ) -> int:
        effective = case(
            (BudgetReservation.state == STATE_RESERVED, BudgetReservation.reserved_micro_usd),
            (BudgetReservation.state == STATE_RECONCILED, BudgetReservation.charged_micro_usd),
            else_=0,
        )
        result = await session.execute(
            select(func.coalesce(func.sum(effective), 0)).where(
                BudgetReservation.channel_id == channel_id,
                BudgetReservation.period_yyyymm == period_yyyymm,
            )
        )
        return int(result.scalar_one())

    async def _close_reservation(self, reservation_id: int, values: dict[str, object]) -> None:
        try:
            async with self._session_factory() as session:
                reservation = await session.get(BudgetReservation, reservation_id)
                if reservation is None:
                    raise BudgetLedgerError(f"reservation not found: {reservation_id}")
                if reservation.state != STATE_RESERVED:
                    raise ReservationNotOpen(
                        f"reservation {reservation_id} is {reservation.state}"
                    )
                for key, value in values.items():
                    setattr(reservation, key, value)
                await session.commit()
        except SQLAlchemyError as exc:
            raise BudgetLedgerError(f"failed to close reservation {reservation_id}: {exc}") from exc
