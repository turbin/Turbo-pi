"""Provider routing decision.

V1 selects exactly one provider per request: every allowed logical model
routes to the local omlx provider, with quality-gated escalation to the
single configured cloud provider (routing.selected_cloud_provider, zero
automatic transport retries). The decision stays in this module so the chat
endpoint never grows routing logic.
"""

from dataclasses import dataclass

from agent_gateway.channel import ChannelContext
from agent_gateway.config import GatewayConfig
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.providers.base import Provider

LOCAL_PROVIDER_NAME = "omlx"


@dataclass(frozen=True)
class RouteDecision:
    provider_name: str
    provider: Provider


def select_provider(
    envelope: ChatCompletionEnvelopeV1,
    context: ChannelContext,
    local_provider: Provider,
) -> RouteDecision:
    del envelope, context  # V1: no per-request routing inputs yet
    return RouteDecision(provider_name=LOCAL_PROVIDER_NAME, provider=local_provider)


def select_escalation_provider(
    config: GatewayConfig, cloud_provider: Provider | None
) -> RouteDecision | None:
    """The single configured cloud provider, or None when not configured."""
    if cloud_provider is None:
        return None
    return RouteDecision(
        provider_name=config.routing.selected_cloud_provider, provider=cloud_provider
    )
