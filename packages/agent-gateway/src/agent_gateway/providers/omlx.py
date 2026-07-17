"""Local omlx provider: OpenAI-compatible chat completions over HTTP.

Translation and parsing live in providers/base.py (shared with the cloud
adapters); they are re-exported here for existing callers. OmlxProvider owns
an httpx async client and a concurrency semaphore (omlx serves one request
at a time by default); the semaphore wraps only the HTTP call, never a DB
transaction.

Error mapping (review section 5.4):
- unreachable/timeout/HTTP error status -> 502 upstream_unavailable
- malformed JSON or missing required fields -> 502 provider_invalid_response
"""

import asyncio
import json

import httpx

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import (
    ModelResult,
    build_chat_request,
    parse_chat_response,
)

__all__ = ["OmlxProvider", "build_chat_request", "parse_chat_response"]

DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1"


class OmlxProvider:
    """Non-streaming chat completions against a local omlx server."""

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        model: str,
        timeout_seconds: int = 120,
        concurrency: int = 1,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._model = model
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout_seconds),
            transport=transport,
        )
        self._semaphore = asyncio.Semaphore(concurrency)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def complete(self, envelope: ChatCompletionEnvelopeV1) -> ModelResult:
        payload = build_chat_request(envelope, model=self._model)
        async with self._semaphore:
            try:
                response = await self._client.post("/chat/completions", json=payload)
            except httpx.HTTPError as exc:
                raise GatewayError(
                    "upstream_unavailable", f"omlx upstream unavailable: {exc}"
                ) from exc

        if response.status_code != 200:
            raise GatewayError(
                "upstream_unavailable",
                f"omlx upstream returned HTTP {response.status_code}",
            )
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            raise GatewayError(
                "provider_invalid_response", "omlx upstream returned malformed JSON"
            ) from exc
        return parse_chat_response(body)
