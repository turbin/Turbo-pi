"""campaign 轨迹合成器测试（pytest，eval/.venv 运行）。"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

EVAL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL))

from synthesize_campaign_sessions import synthesize_task  # noqa: E402


def _record(**kw):
    base = {
        "task_id": "task_00001_x",
        "arm": "experiment",
        "day": 1,
        "prompt": "do the thing",
        "score": 0.8,
        # OpenClaw 事件形态（lib_grading 兼容，campaign.run_agent 产出）
        "transcript": [
            {"type": "message", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "我先看一下目录"},
                {"type": "toolCall", "name": "bash", "arguments": {"command": "ls -la"}},
            ]}},
            {"type": "message", "message": {"role": "toolResult", "content": ["file.txt"]}},
            {"type": "message", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "done"},
            ]}},
        ],
    }
    base.update(kw)
    return base


def test_happy_path(tmp_path):
    out = tmp_path / "s.jsonl"
    synthesize_task(_record(), out, "campaign-d1")
    lines = [json.loads(l) for l in out.read_text().splitlines()]
    assert lines[0]["type"] == "session"
    assert lines[0]["id"] == "campaign-d1-experiment-task_00001_x"
    msgs = [(l["message"]["role"], l["message"]["content"]) for l in lines if l["type"] == "message"]
    assert msgs[0] == ("system", msgs[0][1])
    assert msgs[1] == ("user", "do the thing")
    assert ("assistant", "我先看一下目录") in msgs
    assert ("assistant", "bash: ls -la") in msgs  # toolCall 展平为可读动作文本
    assert ("toolResult", "file.txt") in msgs
    assert msgs[-1] == ("assistant", "done")


def test_missing_transcript_hard_fails(tmp_path):
    with pytest.raises(ValueError, match="不完整"):
        synthesize_task(_record(transcript=[]), tmp_path / "x.jsonl", "p")
    with pytest.raises(ValueError, match="不完整"):
        synthesize_task(_record(prompt=""), tmp_path / "x.jsonl", "p")


def test_empty_text_parts_skipped(tmp_path):
    out = tmp_path / "s.jsonl"
    rec = _record(transcript=[
        {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "  "}]}},
        {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "real"}]}},
    ])
    synthesize_task(rec, out, "p")
    texts = [json.loads(l)["message"]["content"] for l in out.read_text().splitlines() if '"assistant"' in l]
    assert texts == ["real"]


def test_cli_empty_dir_fails_loud(tmp_path):
    r = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(tmp_path), "--output-dir", str(tmp_path / "out")],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    assert "no transcript files" in r.stderr
