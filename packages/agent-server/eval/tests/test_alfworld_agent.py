"""ALFWorld harness 修复回归测试（issue-003 C3/M14/M15/M16/M18，pytest，eval/.venv 运行）。"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from alfworld_agent import (  # noqa: E402
    COMMAND_VERB_RE,
    existing_game_idxs,
    extract_command,
    parse_x_gateway,
    pool_signature,
)


# ── M16: extract_command 行锚定 + 词边界 + 非 think 优先 ─────────────────────


def test_extract_command_rejects_use_inside_because():
    """M16 回归：无词边界时 'because' 内含 'use ' 会误提取。"""
    command, matched = extract_command("because the counter is clean")
    assert matched is False
    assert not command.startswith("use")
    assert not command.startswith("take")


def test_extract_command_rejects_take_inside_mistake():
    command, matched = extract_command("That was a mistake, let me retry")
    assert matched is False


def test_extract_command_takes_last_non_think_command_from_narration():
    text = "Let me think about the task.\nI should go to the cabinet first.\ntake mug 1 from countertop 1"
    command, matched = extract_command(text)
    assert matched is True
    assert command == "take mug 1 from countertop 1"


def test_extract_command_prefers_last_non_think_over_later_think():
    text = "go to cabinet 1\nthink: hmm, what next"
    command, matched = extract_command(text)
    assert command == "go to cabinet 1"


def test_extract_command_lone_think_still_extracts():
    command, matched = extract_command("think: check the inventory first")
    assert matched is True
    assert command == "think: check the inventory first"


def test_extract_command_handles_prompt_arrow_prefix():
    text = "Let me act.\n> take mug 1"
    command, matched = extract_command(text)
    assert matched is True
    assert command == "take mug 1"


def test_extract_command_strips_backticks_and_trailing_dot():
    command, matched = extract_command("```\ngo to cabinet 1.\n```")
    assert matched is True
    assert command == "go to cabinet 1"


def test_extract_command_verb_re_is_line_anchored():
    # 行内（非行首）动词不匹配；"looks" 不匹配 "look"。
    assert COMMAND_VERB_RE.match("take mug 1") is not None
    assert COMMAND_VERB_RE.match("I take mug 1") is None
    assert COMMAND_VERB_RE.match("look at the shelf") is not None
    assert COMMAND_VERB_RE.match("looks around") is None


# ── M15: append 去重 ────────────────────────────────────────────────────────


def test_existing_game_idxs_reads_recorded_games(tmp_path):
    f = tmp_path / "out.jsonl"
    f.write_text(json.dumps({"game_idx": 3}) + "\n" + json.dumps({"game_idx": 7}) + "\n")
    assert existing_game_idxs(f) == {3, 7}


def test_existing_game_idxs_tolerates_malformed_trailing_line(tmp_path):
    f = tmp_path / "out.jsonl"
    f.write_text(json.dumps({"game_idx": 1}) + "\n{broken\n")
    assert existing_game_idxs(f) == {1}


def test_existing_game_idxs_missing_file_is_empty(tmp_path):
    assert existing_game_idxs(tmp_path / "nope.jsonl") == set()


# ── C3: 池签名 ──────────────────────────────────────────────────────────────


def test_pool_signature_is_size_and_stable_hash():
    size, digest = pool_signature(["a.ulx", "b.ulx"])
    assert size == 2
    assert len(digest) == 16
    # 确定性：同一（已排序）池两次计算同摘要；乱序输入产生不同摘要（调用方负责 sorted）。
    assert pool_signature(["a.ulx", "b.ulx"])[1] == digest
    assert pool_signature(["b.ulx", "a.ulx"])[1] != digest


# ── M1: x-gateway 解析 ──────────────────────────────────────────────────────


def test_parse_x_gateway_marker():
    class FakeResp:
        headers = {"x-gateway": '{"escalated": true, "reason": "finish_reason_length", "provider": "kimi"}'}

    marker = parse_x_gateway(FakeResp())
    assert marker["escalated"] is True
    assert marker["provider"] == "kimi"


def test_parse_x_gateway_missing_header():
    class FakeResp:
        headers = {}

    assert parse_x_gateway(FakeResp()) == {}


# ── M18: 轨迹合成——init_prompt 必须真实，id 前缀参数化 ─────────────────────


def test_synthesize_game_requires_init_prompt(tmp_path):
    from synthesize_alfworld_sessions import synthesize_game

    with pytest.raises(ValueError, match="init_prompt"):
        synthesize_game({"game_idx": 1, "task_type": "put", "won": False, "gamefile": "g.ulx"}, tmp_path / "g.jsonl")


def test_synthesize_game_uses_prefix(tmp_path):
    from synthesize_alfworld_sessions import synthesize_game

    game = {
        "game_idx": 5,
        "task_type": "put",
        "won": True,
        "gamefile": "g.ulx",
        "init_prompt": "Interact...\n>",
        "trajectory": [{"action": "go to cabinet 1", "obs": "On the cabinet"}],
    }
    out = tmp_path / "game-005.jsonl"
    synthesize_game(game, out, prefix="alfworld-cold")
    header = json.loads(out.read_text().splitlines()[0])
    assert header["id"] == "alfworld-cold-5"
    assert header["metadata"]["won"] is True
