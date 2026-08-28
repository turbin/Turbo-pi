#!/usr/bin/env python3
"""Local judge adapter that patches vendored lib_grading retry behavior.

issue-023: 401/402/403 account-class errors fail fast; other transient errors
retry with capped exponential backoff; consecutive failures write a sentinel
file so external monitors can detect "alive but stuck" batches.

The patch is applied by calling patch_lib_grading() from the runner
(campaign.py / rerun_audit.py / etc.). This keeps the fix in version-controlled
local code instead of editing the gitignored QCB reference copy.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Sentinel written when judge fails too many times consecutively.
JUDGE_FAILURE_SENTINEL = Path("/tmp/pi-judge-failure-sentinel")
JUDGE_MAX_CONSECUTIVE_FAILURES = int(os.environ.get("JUDGE_MAX_CONSECUTIVE_FAILURES", "3"))

# Retry policy for *transient* judge errors only.
JUDGE_MAX_RETRIES = int(os.environ.get("JUDGE_API_MAX_RETRIES", "6"))
JUDGE_RETRY_BASE_SECONDS = float(os.environ.get("JUDGE_API_RETRY_BASE_SECONDS", "5"))
JUDGE_RETRY_MAX_SECONDS = float(os.environ.get("JUDGE_API_RETRY_MAX_SECONDS", "600"))  # 10 min cap


def _extract_http_code(exc: Exception) -> int | None:
    """Best-effort HTTP status code from a lib_grading judge exception."""
    if isinstance(exc, urllib.error.HTTPError):
        return int(exc.code)
    msg = str(exc)
    for prefix in ("LLM judge API returned ", "HTTP Error "):
        if prefix in msg:
            rest = msg.split(prefix, 1)[1]
            code = rest.split(":", 1)[0].split(" ", 1)[0]
            try:
                return int(code)
            except ValueError:
                return None
    return None


def _is_account_error(exc: Exception) -> bool:
    code = _extract_http_code(exc)
    return code is not None and code in (401, 402, 403)


def _capped_backoff(attempt: int) -> float:
    """Exponential backoff capped at JUDGE_RETRY_MAX_SECONDS (attempt 0-based)."""
    return min(JUDGE_RETRY_BASE_SECONDS * (2**attempt), JUDGE_RETRY_MAX_SECONDS)


class JudgeAccountError(RuntimeError):
    """Raised for 401/402/403 account-class judge errors; must fail fast."""


class JudgeConsecutiveFailureError(RuntimeError):
    """Raised when the judge has failed too many times consecutively."""


class JudgeAdapter:
    """Wraps the direct API judge call with issue-023 policies.

    Maintains an in-process consecutive-failure counter. When it reaches
    JUDGE_MAX_CONSECUTIVE_FAILURES, writes JUDGE_FAILURE_SENTINEL and raises
    JudgeConsecutiveFailureError to fail the batch loudly.
    """

    def __init__(self, original_call: Any) -> None:
        self._original_call = original_call
        self._consecutive_failures = 0

    def __call__(
        self,
        prompt: str,
        model: str,
        base_url: str,
        api_key: str,
        timeout_seconds: float = 1800,
    ) -> str:
        last_exc: Exception | None = None
        url = base_url.rstrip("/") + "/chat/completions"
        payload = json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.0,
                "max_tokens": 20480,
            }
        ).encode("utf-8")

        for attempt in range(JUDGE_MAX_RETRIES):
            try:
                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                choices = body.get("choices", [])
                if not choices:
                    raise RuntimeError(f"LLM judge API returned no choices: {body}")
                content = choices[0].get("message", {}).get("content", "")
                self._consecutive_failures = 0
                return content
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if _is_account_error(exc):
                    raise JudgeAccountError(
                        f"Judge account error ({_extract_http_code(exc)}); failing fast: {exc}"
                    ) from exc
                if attempt == JUDGE_MAX_RETRIES - 1:
                    break
                wait = _capped_backoff(attempt)
                print(
                    f"  judge transient error ({type(exc).__name__}); retry {attempt + 2}/{JUDGE_MAX_RETRIES} in {wait:.0f}s",
                    file=os.sys.stderr,
                )
                time.sleep(wait)

        self._consecutive_failures += 1
        if self._consecutive_failures >= JUDGE_MAX_CONSECUTIVE_FAILURES:
            JUDGE_FAILURE_SENTINEL.write_text(
                f"{self._consecutive_failures} consecutive judge failures\nlast: {last_exc}\n",
            )
            raise JudgeConsecutiveFailureError(
                f"Judge failed {self._consecutive_failures} times consecutively (last: {last_exc}); sentinel: {JUDGE_FAILURE_SENTINEL}"
            ) from last_exc
        raise RuntimeError(f"LLM judge failed after {JUDGE_MAX_RETRIES} attempts: {last_exc}") from last_exc


class GradeLLMJudgeAdapter:
    """Re-implementation of lib_grading._grade_llm_judge with issue-023 policies.

    Reuses all vendored helpers (prompt, parsing, normalization) and only
    replaces the retry/escalation loop.
    """

    def __init__(self, lib_grading_mod: Any, judge_adapter: JudgeAdapter) -> None:
        self._lib = lib_grading_mod
        self._judge = judge_adapter

    def __call__(
        self,
        *,
        task: Any,
        execution_result: dict[str, Any],
        judge_model: str,
        judge_agent_prefix: str,
        judge_timeout_seconds: float,
        skill_dir: Path,
        verbose: bool = False,
    ) -> Any:
        transcript_summary = self._lib._summarize_transcript(execution_result.get("transcript", []))
        rubric = task.llm_judge_rubric or self._lib._format_grading_criteria(task)
        prompt = self._lib._build_judge_prompt(task, transcript_summary, rubric)

        host_env = self._lib._load_openclaw_env()
        base_url = os.environ.get("JUDGE_BASE_URL") or host_env.get("JUDGE_BASE_URL")
        api_key = os.environ.get("JUDGE_API_KEY") or host_env.get("JUDGE_API_KEY")

        if not base_url or not api_key:
            raise RuntimeError(
                "LLM judge requires JUDGE_BASE_URL and JUDGE_API_KEY. "
                "Set them as environment variables or add them to ~/.openclaw/.env."
            )

        api_model = judge_model.split("/", 1)[-1] if "/" in judge_model else judge_model
        response_text = self._judge(
            prompt=prompt,
            model=api_model,
            base_url=base_url,
            api_key=api_key,
            timeout_seconds=judge_timeout_seconds,
        )

        raw_parsed = self._lib._parse_judge_text_response(response_text)
        parsed = self._lib._normalize_judge_response(raw_parsed)
        breakdown = parsed.get("scores", {})
        total = parsed.get("total")
        notes = parsed.get("notes", "")
        return self._lib.GradeResult(
            task_id=task.task_id,
            score=float(total) if total is not None else 0.0,
            max_score=1.0,
            grading_type="llm_judge",
            breakdown=self._lib._normalize_score_dict(breakdown),
            notes=str(notes) if notes is not None else "",
        )


_judge_adapter: JudgeAdapter | None = None


def patch_lib_grading() -> None:
    """Monkey-patch vendored lib_grading with local issue-023 policies."""
    global _judge_adapter
    if _judge_adapter is not None:
        return  # already patched

    # Import vendored module lazily so tests can import this file without QCB present.
    try:
        import lib_grading  # type: ignore[import-not-found]
    except ImportError:
        return

    _judge_adapter = JudgeAdapter(lib_grading._call_llm_judge_api)
    lib_grading._call_llm_judge_api = _judge_adapter
    lib_grading._grade_llm_judge = GradeLLMJudgeAdapter(lib_grading, _judge_adapter)


def reset_consecutive_failures() -> None:
    """Reset the consecutive-failure counter (useful for tests / dry-runs)."""
    global _judge_adapter
    if _judge_adapter is not None:
        _judge_adapter._consecutive_failures = 0
    JUDGE_FAILURE_SENTINEL.unlink(missing_ok=True)
