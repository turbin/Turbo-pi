"""Kimi cloud provider: OpenAI-compatible chat completions over HTTPS.

V1 has exactly one configured cloud provider (routing.selected_cloud_provider)
and zero automatic transport retries. DeepSeek speaks the same OpenAI-compatible
shape, so this adapter is config-driven; a separate deepseek module was not
needed. Connection details come from the environment variables named in the
config file — the api key never enters the config or the trace store.

Error mapping matches the local adapter (review section 5.4):
- unreachable/timeout/HTTP error status -> 502 upstream_unavailable
- malformed JSON or missing required fields -> 502 provider_invalid_response
"""

import json
import os
from collections.abc import Mapping

import httpx

from agent_gateway.config import CloudProviderConfig
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult, build_chat_request, parse_chat_response


class KimiProvider:
    """Non-streaming chat completions against an OpenAI-compatible cloud API."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: int = 120,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout_seconds),
            transport=transport,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    @classmethod
    def from_config(
        cls,
        config: CloudProviderConfig,
        *,
        timeout_seconds: int = 120,
        environ: Mapping[str, str] = os.environ,
    ) -> "KimiProvider | None":
        """Build from the env vars named in config; None when not fully configured."""
        if not (config.base_url_env and config.api_key_env and config.model_env):
            return None
        base_url = environ.get(config.base_url_env)
        api_key = environ.get(config.api_key_env)
        model = environ.get(config.model_env)
        if not (base_url and api_key and model):
            return None
        return cls(
            base_url=base_url, api_key=api_key, model=model, timeout_seconds=timeout_seconds
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        payload = build_chat_request(envelope, model=self.model)
        try:
            response = await self._client.post("/chat/completions", json=payload)
        except httpx.HTTPError as exc:
            raise GatewayError(
                "upstream_unavailable", f"cloud upstream unavailable: {exc}"
            ) from exc

        if response.status_code != 200:
            raise GatewayError(
                "upstream_unavailable",
                f"cloud upstream returned HTTP {response.status_code}",
            )
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise GatewayError(
                "provider_invalid_response", "cloud upstream returned malformed JSON"
            ) from exc
        return parse_chat_response(body)
