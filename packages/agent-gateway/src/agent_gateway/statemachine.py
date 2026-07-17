"""Request trace state machine (plan section 5.1, review P0-05).

State changes happen through TraceStore.transition using a version CAS;
no DB transaction is ever held across a network call.
"""

from enum import Enum


class RequestState(str, Enum):
    received = "received"
    queued = "queued"
    leased = "leased"
    run_started = "run_started"
    run_succeeded = "run_succeeded"
    response_started = "response_started"
    response_closed = "response_closed"
    cancelled = "cancelled"
    failed = "failed"
    abandoned = "abandoned"


TERMINAL_STATES: frozenset[RequestState] = frozenset(
    {
        RequestState.response_closed,
        RequestState.cancelled,
        RequestState.failed,
        RequestState.abandoned,
    }
)

ALLOWED_TRANSITIONS: dict[RequestState, frozenset[RequestState]] = {
    RequestState.received: frozenset({RequestState.queued, RequestState.cancelled, RequestState.failed, RequestState.abandoned}),
    RequestState.queued: frozenset({RequestState.leased, RequestState.cancelled, RequestState.failed, RequestState.abandoned}),
    RequestState.leased: frozenset({RequestState.run_started, RequestState.cancelled, RequestState.failed, RequestState.abandoned}),
    RequestState.run_started: frozenset({RequestState.run_succeeded, RequestState.cancelled, RequestState.failed, RequestState.abandoned}),
    RequestState.run_succeeded: frozenset({RequestState.response_started, RequestState.failed, RequestState.abandoned}),
    RequestState.response_started: frozenset({RequestState.response_closed, RequestState.cancelled, RequestState.failed, RequestState.abandoned}),
    RequestState.response_closed: frozenset(),
    RequestState.cancelled: frozenset(),
    RequestState.failed: frozenset(),
    RequestState.abandoned: frozenset(),
}
