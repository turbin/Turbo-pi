"""T10 teacher usage 台账写入侧测试（pytest，eval/.venv 运行）。

预注册口径（doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md §1.5；
评审 §十六）：离线进化管线 LLM 客户端（python/skill_evolution/llm_client.py 与
python/verification_selection/llm_client.py 的 OpenAICompatClient，sop_lifecycle
复用 skill_evolution 客户端）每次成功调用追写一行 JSONL 台账
var/eval/evolution-usage.jsonl（env EVOLUTION_USAGE_LEDGER 覆盖路径）：
{ts, model, prompt_tokens, completion_tokens, caller}。写失败只告警不抛——
台账是观测设施，不得阻断进化管线；MockLLM 零网络不产生台账。
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent.parent / "python"


def _load_client(pkg: str):
    """以独立模块加载 llm_client.py（绕开包 __init__ 的重依赖）。"""
    path = PYTHON_DIR / pkg / "llm_client.py"
    spec = importlib.util.spec_from_file_location(f"{pkg}.llm_client", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class _FakeResp:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def _install_fake_urlopen(monkeypatch, mod, payload: dict):
    import urllib.request

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        return _FakeResp(payload)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)


def _ledger_lines(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# ── 写入路径 ───────────────────────────────────────────────────────────


def test_skill_evolution_client_appends_usage_ledger(tmp_path, monkeypatch):
    mod = _load_client("skill_evolution")
    ledger = tmp_path / "evolution-usage.jsonl"
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(ledger))
    _install_fake_urlopen(monkeypatch, mod, {
        "choices": [{"message": {"content": "ok"}}],
        "usage": {"prompt_tokens": 123, "completion_tokens": 45},
    })
    client = mod.OpenAICompatClient(base_url="http://x/v1", model="deepseek-v4-pro", caller="skill_evolution")
    client.chat([{"role": "user", "content": "hi"}])
    lines = _ledger_lines(ledger)
    assert len(lines) == 1
    assert lines[0]["model"] == "deepseek-v4-pro"
    assert lines[0]["prompt_tokens"] == 123
    assert lines[0]["completion_tokens"] == 45
    assert lines[0]["caller"] == "skill_evolution"
    assert lines[0]["ts"]


def test_verification_selection_client_appends_usage_ledger(tmp_path, monkeypatch):
    mod = _load_client("verification_selection")
    ledger = tmp_path / "evolution-usage.jsonl"
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(ledger))
    _install_fake_urlopen(monkeypatch, mod, {
        "choices": [{"message": {"content": "ok"}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    })
    client = mod.OpenAICompatClient.teacher_from_env(base_url="http://x/v1", model="deepseek-v4-pro")
    client.chat([{"role": "user", "content": "hi"}])
    lines = _ledger_lines(ledger)
    assert len(lines) == 1
    assert lines[0]["prompt_tokens"] == 10
    assert lines[0]["completion_tokens"] == 20
    assert lines[0]["caller"] == "verification_selection"  # 默认 caller = 包名


def test_ledger_appends_per_call_and_default_path(tmp_path, monkeypatch, capsys):
    mod = _load_client("skill_evolution")
    ledger = tmp_path / "var" / "eval" / "evolution-usage.jsonl"
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(ledger))
    _install_fake_urlopen(monkeypatch, mod, {
        "choices": [{"message": {"content": "ok"}}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3},
    })
    client = mod.OpenAICompatClient(base_url="http://x/v1", model="m1")
    client.chat([{"role": "user", "content": "a"}])
    client.chat([{"role": "user", "content": "b"}])
    lines = _ledger_lines(ledger)
    assert len(lines) == 2
    assert all(l["caller"] == "skill_evolution" for l in lines)
    assert "usage ledger append failed" not in capsys.readouterr().err


def test_ledger_append_failure_only_warns(tmp_path, monkeypatch, capsys):
    mod = _load_client("skill_evolution")
    # 台账路径的父级是一个文件 → makedirs 抛 OSError → 仅告警不抛。
    blocker = tmp_path / "blocker"
    blocker.write_text("x")
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(blocker / "nested" / "usage.jsonl"))
    mod.append_usage_ledger("deepseek-v4-pro", 1, 2, "skill_evolution")  # 不得抛异常
    assert "usage ledger append failed" in capsys.readouterr().err


def test_ledger_usage_missing_from_response_defaults_zero(tmp_path, monkeypatch):
    mod = _load_client("verification_selection")
    ledger = tmp_path / "usage.jsonl"
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(ledger))
    _install_fake_urlopen(monkeypatch, mod, {"choices": [{"message": {"content": "ok"}}]})  # 无 usage
    client = mod.OpenAICompatClient(base_url="http://x/v1", model="m")
    client.chat_with_logprobs([{"role": "user", "content": "hi"}], top_logprobs=1)
    lines = _ledger_lines(ledger)
    assert len(lines) == 1
    assert lines[0]["prompt_tokens"] == 0
    assert lines[0]["completion_tokens"] == 0


# ── MockLLM 零网络不写台账 ─────────────────────────────────────────────


def test_mock_llm_writes_no_ledger(tmp_path, monkeypatch):
    mod = _load_client("skill_evolution")
    ledger = tmp_path / "usage.jsonl"
    monkeypatch.setenv("EVOLUTION_USAGE_LEDGER", str(ledger))
    llm = mod.MockLLM()
    llm.chat([{"role": "user", "content": "hi"}])
    assert not ledger.exists()
