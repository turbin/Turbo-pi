"""campaign 轨迹合成器测试（pytest，eval/.venv 运行）。"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

EVAL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL))

from campaign_plan import held_out_tasks, load_tasks  # noqa: E402
from synthesize_campaign_sessions import filter_inputs, synthesize_task  # noqa: E402


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


def test_output_ends_with_closing_marker(tmp_path):
    """issue-018（T6 契约）：合成 session 末尾必须追加与 session-writer v3 线上
    一致形态的 response_completed 闭合条目——ETL 完整性判据（etl.ts）认
    custom 条目 + customType=response_completed/error/aborted；有头无闭合 =
    半截整体隔离（D1 实战 etlIsolated=32/32, etlInserted=0）。"""
    out = tmp_path / "s.jsonl"
    synthesize_task(_record(), out, "campaign-d1")
    lines = [json.loads(l) for l in out.read_text().splitlines()]
    last = lines[-1]
    assert last["type"] == "custom"
    assert last["customType"] == "response_completed"
    # 结构字段与线上 session-writer appendTreeEntry 形态一致
    # （id/parentId/timestamp 三字段齐全；parentId 为 null 或上一条 id）。
    assert {"id", "parentId", "timestamp"} <= set(last)


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


# ── T2：写入隔离（preview §10）与 held-out 排除（preview §7.2）───────────

def _write_transcript(dirpath: Path, arm: str, task_id: str) -> None:
    (dirpath / f"{arm}-{task_id}.json").write_text(json.dumps(_record(arm=arm, task_id=task_id)))


def test_filter_inputs_arms_and_held_out(tmp_path):
    """写入隔离纯函数：臂不在 eligible（默认 experiment,x2）或任务在 held-out 均
    排除并计数（§10：X1/X3/X4 默认只读不写入；§7.2：held-out 不进 evolution）。"""
    held = {"task_hold_x"}
    files = []
    for stem in ("experiment-task_00001_x", "x1-task_00002_x", "x2-task_hold_x",
                 "x3-task_00004_x", "x4-task_hold_x"):
        p = tmp_path / f"{stem}.json"
        p.write_text("{}")
        files.append(p)
    kept, skipped_arm, skipped_held = filter_inputs(files, {"experiment", "x2"}, held)
    assert [p.name for p in kept] == ["experiment-task_00001_x.json"]
    assert skipped_arm == 3  # x1/x3/x4
    assert skipped_held == 1  # x2 上的 held-out


def test_cli_eligible_arms_default_and_override(tmp_path):
    """--eligible-arms 缺省 experiment,x2：X1/X3/X4 只读不写入；覆盖参数放行。"""
    in_dir = tmp_path / "in"
    in_dir.mkdir()
    for i, arm in enumerate(("experiment", "x1", "x2", "x3", "x4")):
        _write_transcript(in_dir, arm, f"task_{i:05d}_cli_x")

    out1 = tmp_path / "out1"
    r = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(in_dir), "--output-dir", str(out1)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "excluded 3" in r.stdout  # x1/x3/x4 排除计数打印
    assert sorted(f.name for f in out1.glob("*.jsonl")) == [
        "experiment-task_00000_cli_x.jsonl", "x2-task_00002_cli_x.jsonl",
    ]

    out2 = tmp_path / "out2"
    r2 = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(in_dir), "--output-dir", str(out2),
         "--eligible-arms", "experiment,x1,x2,x3,x4"],
        capture_output=True, text=True,
    )
    assert r2.returncode == 0
    assert len(list(out2.glob("*.jsonl"))) == 5


def test_cli_excludes_held_out_transcripts(tmp_path):
    """preview §7.2：held-out 任务的 transcript 不得合成（memory 中不得有其
    exact trajectory）——用真实 corpus 的 held-out 任务 id 构造 fixture。"""
    held = held_out_tasks(load_tasks())
    assert held, "corpus held-out 应非空"
    tid = held[0]
    in_dir = tmp_path / "in"
    in_dir.mkdir()
    _write_transcript(in_dir, "experiment", tid)  # held-out：排除
    _write_transcript(in_dir, "experiment", "task_00001_x")  # 常规：合成
    out_dir = tmp_path / "out"
    r = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(in_dir), "--output-dir", str(out_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "1 held-out" in r.stdout  # held-out 排除计数
    assert sorted(f.name for f in out_dir.glob("*.jsonl")) == ["experiment-task_00001_x.jsonl"]


def test_cli_eligible_arms_empty_string_fails_loud(tmp_path):
    """--eligible-arms 传空字符串：无任何臂可匹配 → fail loud（SystemExit），
    不得静默合成全部或空跑成功。"""
    in_dir = tmp_path / "in"
    in_dir.mkdir()
    _write_transcript(in_dir, "experiment", "task_00001_x")
    r = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(in_dir), "--output-dir", str(tmp_path / "out"),
         "--eligible-arms", ""],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    assert "no eligible transcript files" in r.stderr
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


def test_cli_eligible_arms_unknown_arm_fails_loud(tmp_path):
    """--eligible-arms 传未知臂名：全部文件被排除 → fail loud（不静默放行
    x1/x3/x4 等未列入白名单的臂）。"""
    in_dir = tmp_path / "in"
    in_dir.mkdir()
    _write_transcript(in_dir, "experiment", "task_00001_x")
    _write_transcript(in_dir, "x2", "task_00002_x")
    r = subprocess.run(
        [str(EVAL / ".venv" / "bin" / "python"), str(EVAL / "synthesize_campaign_sessions.py"),
         "--input-dir", str(in_dir), "--output-dir", str(tmp_path / "out"),
         "--eligible-arms", "bogus-arm"],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    assert "no eligible transcript files" in r.stderr
