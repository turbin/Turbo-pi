"""Client-disconnect cancellation (review 5.2).

While the upstream call is in flight the gateway polls the ASGI receive
channel: when the connection closes, the provider task is cancelled (which
also releases the omlx semaphore slot), the trace moves to cancelled with the
internal code client_cancelled recorded, and no response is ever written to
the gone client. Used by both the non-streaming and the delayed-SSE paths.

The watcher task only observes the disconnect; the provider task is cancelled
afterwards by the waiter. Cancelling inside the watcher would race
asyncio.wait: the cancelled provider task can finish first, and its raw
CancelledError would mask the ClientDisconnected.
"""

import asyncio
from collections.abc import AsyncIterator

from fastapi import Request

from agent_gateway.providers.base import ModelResult
from agent_gateway.sse import HEARTBEAT


class ClientDisconnected(Exception):
    """The ASGI connection closed while the upstream call was in flight."""


async def _watch_disconnect(request: Request) -> None:
    """Raise ClientDisconnected when the ASGI connection closes."""
    message = await request.receive()
    if message.get("type") == "http.disconnect":
        raise ClientDisconnected


async def _cancel_task(task: "asyncio.Task[ModelResult]") -> None:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def await_provider(request: Request, task: "asyncio.Task[ModelResult]") -> ModelResult:
    """Wait for the provider task, cancelling it if the client disconnects."""
    while True:
        watcher = asyncio.ensure_future(_watch_disconnect(request))
        try:
            done, _ = await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return task.result()
            try:
                watcher.result()
            except ClientDisconnected:
                await _cancel_task(task)
                raise
            # A non-disconnect message after the body: keep waiting.
        finally:
            watcher.cancel()


async def heartbeats_until_done(
    request: Request, task: "asyncio.Task[ModelResult]", heartbeat_seconds: float
) -> AsyncIterator[bytes]:
    """Yield SSE comment heartbeats until the provider task completes.

    Raises ClientDisconnected (cancelling the task) if the client goes away
    while waiting.
    """
    watcher = asyncio.ensure_future(_watch_disconnect(request))
    try:
        while not task.done():
            done, _ = await asyncio.wait(
                {task, watcher}, timeout=heartbeat_seconds, return_when=asyncio.FIRST_COMPLETED
            )
            if watcher in done:
                try:
                    watcher.result()
                except ClientDisconnected:
                    await _cancel_task(task)
                    raise
                watcher = asyncio.ensure_future(_watch_disconnect(request))
            elif task not in done:
                yield HEARTBEAT
    finally:
        watcher.cancel()
