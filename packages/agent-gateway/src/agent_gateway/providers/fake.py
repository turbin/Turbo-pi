"""Scriptable provider for regression tests.

Queued ModelResult/GatewayError entries are consumed in order; every envelope
the provider received is recorded for assertions. Never performs I/O.
"""

from collections import deque
from collections.abc import Iterable

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.providers.base import ModelResult


class FakeProvider:
    def __init__(self, script: Iterable[ModelResult | Exception] = ()) -> None:
        self._queue: deque[ModelResult | Exception] = deque(script)
        self.received: list[ChatCompletionEnvelopeV1] = []

    def push(self, item: ModelResult | Exception) -> None:
        self._queue.append(item)

    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        self.received.append(envelope)
        if not self._queue:
            raise AssertionError("FakeProvider script exhausted")
        item = self._queue.popleft()
        if isinstance(item, Exception):
            raise item
        return item
