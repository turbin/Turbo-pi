"""Regression tests for issue-023 judge retry policies."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from judge_adapter import (
    JUDGE_FAILURE_SENTINEL,
    JUDGE_MAX_CONSECUTIVE_FAILURES,
    JudgeAccountError,
    JudgeAdapter,
    JudgeConsecutiveFailureError,
    _capped_backoff,
    _extract_http_code,
    _is_account_error,
    patch_lib_grading,
    reset_consecutive_failures,
)


class _FakeJudgeHandler(BaseHTTPRequestHandler):
    """HTTP handler that returns configured statuses/bodies."""

    responses: list[tuple[int, bytes]] = []
    request_count = 0
    _lock = threading.Lock()

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:
        with _FakeJudgeHandler._lock:
            _FakeJudgeHandler.request_count += 1
            status, body = _FakeJudgeHandler.responses.pop(0) if _FakeJudgeHandler.responses else (200, b'{"choices":[{"message":{"content":"ok"}}]}')
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()


@pytest.fixture
def fake_judge():
    """Yield the base URL of a temporary fake judge server."""
    _FakeJudgeHandler.responses = []
    _FakeJudgeHandler.request_count = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeJudgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()


def test_extract_http_code_from_urllib_error() -> None:
    exc = urllib.error.HTTPError("http://x", 402, "Payment Required", {}, None)  # type: ignore[arg-type]
    assert _extract_http_code(exc) == 402


def test_is_account_error_true_for_401_402_403() -> None:
    for code in (401, 402, 403):
        exc = urllib.error.HTTPError("http://x", code, "", {}, None)  # type: ignore[arg-type]
        assert _is_account_error(exc) is True


def test_is_account_error_false_for_500() -> None:
    exc = urllib.error.HTTPError("http://x", 500, "", {}, None)  # type: ignore[arg-type]
    assert _is_account_error(exc) is False


def test_capped_backoff_reaches_cap() -> None:
    assert _capped_backoff(0) == 5.0
    assert _capped_backoff(1) == 10.0
    # 2^10 * 5 = 5120; cap is 600 by default
    assert _capped_backoff(20) == 600.0


def test_402_fails_fast_without_retry(fake_judge: str) -> None:
    _FakeJudgeHandler.responses = [(402, b'{"error":"insufficient balance"}')]
    adapter = JudgeAdapter(lambda *_a, **_k: "")  # original not used
    with pytest.raises(JudgeAccountError):
        adapter(
            prompt="hi",
            model="m",
            base_url=fake_judge,
            api_key="k",
            timeout_seconds=5,
        )
    assert _FakeJudgeHandler.request_count == 1


def test_transient_error_retries_with_capped_backoff(fake_judge: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("judge_adapter.JUDGE_RETRY_BASE_SECONDS", 0.01)
    monkeypatch.setattr("judge_adapter.JUDGE_RETRY_MAX_SECONDS", 0.05)
    _FakeJudgeHandler.responses = [
        (500, b'{"error":"boom"}'),
        (503, b'{"error":"again"}'),
        (200, b'{"choices":[{"message":{"content":"ok"}}]}'),
    ]
    adapter = JudgeAdapter(lambda *_a, **_k: "")
    text = adapter(prompt="hi", model="m", base_url=fake_judge, api_key="k", timeout_seconds=5)
    assert text == "ok"
    assert _FakeJudgeHandler.request_count == 3


def test_consecutive_failure_writes_sentinel(fake_judge: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    sentinel = tmp_path / "judge-sentinel"
    monkeypatch.setattr("judge_adapter.JUDGE_FAILURE_SENTINEL", sentinel)
    monkeypatch.setattr("judge_adapter.JUDGE_RETRY_BASE_SECONDS", 0.01)
    monkeypatch.setattr("judge_adapter.JUDGE_RETRY_MAX_SECONDS", 0.01)
    monkeypatch.setattr("judge_adapter.JUDGE_MAX_RETRIES", 2)
    monkeypatch.setattr("judge_adapter.JUDGE_MAX_CONSECUTIVE_FAILURES", 1)
    _FakeJudgeHandler.responses = [(500, b'{"error":"boom"}'), (500, b'{"error":"boom"}')]
    adapter = JudgeAdapter(lambda *_a, **_k: "")
    with pytest.raises(JudgeConsecutiveFailureError):
        adapter(prompt="hi", model="m", base_url=fake_judge, api_key="k", timeout_seconds=5)
    assert sentinel.exists()


def test_patch_lib_grading_idempotent() -> None:
    patch_lib_grading()
    patch_lib_grading()  # should not raise
    reset_consecutive_failures()
