"""Deterministic stub provider, kept for smoke wiring checks.

Superseded by OmlxProvider (real path) and FakeProvider (tests) since Day 3.
"""

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.providers.base import ModelResult


class StubProvider:
    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        del envelope
        return ModelResult(
            content="stub: provider wiring lands on Day 3",
            tool_calls=None,
            finish_reason="stop",
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
        )
