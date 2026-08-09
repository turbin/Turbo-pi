"""issue-002 回归测试：进化管线对中继链路健壮性（r2/r3/r4 三连故障）。

覆盖点（用户 08-06 决定草案、到期补测，2026-08-09 落地）：
1. llm_client._post 对截断 JSON（logprobs 大响应）与 200-无-choices 结构异常
   指数退避重试，3 次内恢复即成功（双副本同一逻辑，各测一份）
2. verifier._score_once 注入 thinking disabled + max_tokens 封顶——这是
   r3 打分调用形态失控（7MB/30-90s 单次）的修复哨兵

运行：cd packages/agent-server && python -m pytest python/tests/test_issue002_pipeline_resilience.py -q
"""

from __future__ import annotations

import json

import pytest

from verification_selection.llm_client import MockLLM
from verification_selection.testing import letter_distribution, score_response
from verification_selection.verifier import Criterion, DEFAULT_CRITERIA, LetterScale, Verifier


class FakeResp:
    """urllib 响应替身：read() 返回脚本化字节（可含截断 JSON）。"""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResp":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def _post_retry_test(monkeypatch: pytest.MonkeyPatch, client, build_payload) -> None:
    """脚本化 urlopen：截断 JSON → 缺 choices → 正常。断言 3 次调用后成功。"""
    calls: list[str] = []

    def fake_urlopen(req: object, timeout: float | None = None) -> FakeResp:
        calls.append(str(req))
        n = len(calls)
        if n == 1:
            # r2 实测：~7MB logprobs 响应被截断，json.loads 抛 JSONDecodeError
            return FakeResp(b'{"choices": [{"message": {"content": "trunc')
        if n == 2:
            # r4 实测：HTTP 200 但响应体无 choices（上游/中继瞬时异常另一形态）
            return FakeResp(json.dumps({"id": "chatcmpl-x"}).encode())
        return FakeResp(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    data = client._post(build_payload(client))
    assert data["choices"][0]["message"]["content"] == "ok"
    assert len(calls) == 3


def test_skill_evolution_client_retries_truncation_and_missing_choices(monkeypatch: pytest.MonkeyPatch) -> None:
    from skill_evolution.llm_client import OpenAICompatClient

    _post_retry_test(
        monkeypatch,
        OpenAICompatClient(base_url="http://t/v1", api_key="k", model="m"),
        lambda c: c._build_body([{"role": "user", "content": "hi"}]),
    )


def test_verification_selection_client_retries_truncation_and_missing_choices(monkeypatch: pytest.MonkeyPatch) -> None:
    from verification_selection.llm_client import OpenAICompatClient

    _post_retry_test(
        monkeypatch,
        OpenAICompatClient(base_url="http://t/v1", api_key="k", model="m"),
        lambda c: c.build_payload([{"role": "user", "content": "hi"}]),
    )


def test_score_once_injects_thinking_disabled_and_max_tokens_cap() -> None:
    """r3 打分形态失控哨兵：_score_once 必须关 thinking + 封顶 max_tokens，
    否则 v4-flash 长 CoT + 逐 token logprobs 使单次响应达数 MB/分钟级。"""
    captured: dict = {}

    def handler(messages: list[dict], **kw: object) -> object:  # noqa: ARG001
        captured["kw"] = kw
        dist = letter_distribution(2, 5)  # 中间分数
        return score_response(dist, dist)

    mock = MockLLM(default_text="MOCK").add_rule(lambda m, **kw: True, handler)
    verifier = Verifier(mock, scale=LetterScale(G=5), K=1)
    verifier._score_once("task", "trajA", "trajB", DEFAULT_CRITERIA[0], "reasoning")

    assert captured["kw"].get("thinking") == {"type": "disabled"}
    assert captured["kw"].get("max_tokens") == 512
