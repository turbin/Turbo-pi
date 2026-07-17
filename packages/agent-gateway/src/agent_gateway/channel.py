"""API key -> ChannelContext mapping.

Channel identity is the (client_id, workspace_id, channel_id) triple from
config. The raw API key never enters the store; only its digest-derived id.
"""

import hashlib
from dataclasses import dataclass

from agent_gateway.config import ChannelConfig


def api_key_id_for(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class ChannelContext:
    api_key_id: str
    client_id: str
    workspace_id: str
    channel_id: str
    allowed_models: tuple[str, ...]
    cloud_egress_allowed: bool
    monthly_budget_micro_usd: int | None


class ChannelRegistry:
    """In-memory registry built from [[channels]] TOML entries."""

    def __init__(self, channels: list[ChannelConfig]) -> None:
        self._by_key: dict[str, ChannelContext] = {}
        for channel in channels:
            self._by_key[channel.key] = ChannelContext(
                api_key_id=api_key_id_for(channel.key),
                client_id=channel.client_id,
                workspace_id=channel.workspace_id,
                channel_id=channel.channel_id,
                allowed_models=tuple(channel.allowed_models),
                cloud_egress_allowed=channel.cloud_egress_allowed,
                monthly_budget_micro_usd=channel.monthly_budget_micro_usd,
            )

    def resolve(self, api_key: str | None) -> ChannelContext | None:
        if api_key is None:
            return None
        return self._by_key.get(api_key)
