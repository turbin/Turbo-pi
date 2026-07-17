"""Delayed SSE replay (plan section 4 Day 4 / review P0-03).

The gateway always calls the upstream provider non-streaming and waits for
the complete ModelResult; only then does it replay the result as OpenAI
chat.completion.chunk deltas: a role chunk, content chunks, tool_call deltas,
a finish chunk, an optional usage chunk, and [DONE]. While waiting, SSE
comment heartbeats (": heartbeat") keep clients and proxies from timing out
(see cancellation.heartbeats_until_done, which also aborts the wait when the
client disconnects).

If the provider fails before the first event is ready, the client has not
received any SSE bytes yet, so DelayedEventStreamResponse answers with the
stable JSON error body instead of starting a partial stream. This is
deliberate: a committed 200 + text/event-stream response followed by an
error event would force clients to handle two error channels.
"""

import json
import time
from collections.abc import AsyncIterator

from fastapi import Response
from fastapi.responses import JSONResponse

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.providers.base import ModelResult

HEARTBEAT = b": heartbeat\n\n"
DONE = b"data: [DONE]\n\n"


def usage_payload(result: ModelResult) -> dict:
    prompt_tokens = result.prompt_tokens or 0
    completion_tokens = result.completion_tokens or 0
    total_tokens = (
        result.total_tokens
        if result.total_tokens is not None
        else prompt_tokens + completion_tokens
    )
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def _chunk(trace_id: str, model: str, delta: dict, finish_reason: str | None = None) -> dict:
    return {
        "id": trace_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def build_replay_events(
    trace_id: str,
    envelope: ChatCompletionEnvelopeV1,
    result: ModelResult,
    *,
    include_usage: bool,
) -> list[bytes]:
    """OpenAI chat.completion.chunk deltas for a complete ModelResult."""
    model = envelope.model
    events = [_sse(_chunk(trace_id, model, {"role": "assistant"}))]
    if result.content:
        events.append(_sse(_chunk(trace_id, model, {"content": result.content})))
    for index, call in enumerate(result.tool_calls or ()):
        events.append(
            _sse(
                _chunk(
                    trace_id,
                    model,
                    {
                        "tool_calls": [
                            {
                                "index": index,
                                "id": call.id,
                                "type": "function",
                                "function": {"name": call.name, "arguments": call.arguments},
                            }
                        ]
                    },
                )
            )
        )
    events.append(_sse(_chunk(trace_id, model, {}, finish_reason=result.finish_reason)))
    if include_usage:
        events.append(
            _sse(
                {
                    "id": trace_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [],
                    "usage": usage_payload(result),
                }
            )
        )
    events.append(DONE)
    return events


class DelayedEventStreamResponse(Response):
    """SSE response that commits headers only when the first event is ready.

    If the iterator raises GatewayError before its first yield, the client has
    not received any SSE bytes yet and gets the stable JSON error body instead
    of a partial stream (see module docstring).
    """

    def __init__(self, content: AsyncIterator[bytes]) -> None:
        super().__init__(content=b"", status_code=200)
        self.body_iterator = content
        self.raw_headers = [
            (b"content-type", b"text/event-stream"),
            (b"cache-control", b"no-cache"),
            (b"connection", b"keep-alive"),
        ]

    async def __call__(self, scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        first: bytes | None = None
        try:
            first = await self.body_iterator.__anext__()
        except StopAsyncIteration:
            pass
        except GatewayError as exc:
            error = JSONResponse(status_code=exc.http_status, content=exc.body())
            await error(scope, receive, send)
            return
        await send(
            {"type": "http.response.start", "status": 200, "headers": self.raw_headers}
        )
        if first is not None:
            await send({"type": "http.response.body", "body": first, "more_body": True})
        async for chunk in self.body_iterator:
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
