"""Provider seam. Day 3 wires real omlx/cloud providers behind this protocol."""

from agent_gateway.providers.base import ModelResult, Provider
from agent_gateway.providers.stub import StubProvider

__all__ = ["ModelResult", "Provider", "StubProvider"]
