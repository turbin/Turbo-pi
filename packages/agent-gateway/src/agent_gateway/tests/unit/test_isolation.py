"""Day 5: dual-key trace isolation — another key's traces are 404, never 403."""

import httpx

from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider

from .conftest import KEY_1, KEY_2
from .test_api import auth, chat_payload


def make_result(content: str) -> ModelResult:
    return ModelResult(
        content=content,
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=1,
        completion_tokens=1,
        total_tokens=2,
    )


async def test_interleaved_keys_cannot_read_each_others_traces(
    client: httpx.AsyncClient, fake_provider: FakeProvider
) -> None:
    fake_provider.push(make_result("甲"))
    fake_provider.push(make_result("乙"))
    fake_provider.push(make_result("丙"))

    r1 = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    r2 = await client.post(
        "/v1/chat/completions", json=chat_payload(model="agent-cloud"), headers=auth(KEY_2)
    )
    r3 = await client.post("/v1/chat/completions", json=chat_payload(), headers=auth(KEY_1))
    assert r1.status_code == r2.status_code == r3.status_code == 200
    trace_a, trace_b = r1.json()["id"], r2.json()["id"]

    # Each key reads its own traces.
    assert (await client.get(f"/internal/traces/{trace_a}", headers=auth(KEY_1))).status_code == 200
    assert (await client.get(f"/internal/traces/{trace_b}", headers=auth(KEY_2))).status_code == 200

    # Cross-key reads are 404 (no existence leak), in both directions.
    resp = await client.get(f"/internal/traces/{trace_a}", headers=auth(KEY_2))
    assert resp.status_code == 404
    resp = await client.get(f"/internal/traces/{trace_b}", headers=auth(KEY_1))
    assert resp.status_code == 404
