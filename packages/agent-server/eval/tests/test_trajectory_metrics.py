"""D 阶段增强 trajectory 指标族测试（pytest，eval/.venv 运行）。

预注册启发式口径（preview.html §8.2 / §17.3，见 trajectory_metrics.py docstring）：
  RoundCount = assistant 决策回合数（每个 assistant message 事件一回合）
  CapRate（2026-08-19 用户裁决：按最终成败拆三档，红线 4 同口径）——
    cap_rate          = 触顶任务数 / 总任务数（总体，兼容旧口径）
    cap_success_rate  = 触顶且成功（score>=0.5）任务数 / 总任务数
    cap_failure_rate  = 触顶且失败任务数 / 总任务数
    cap_unknown_n     = 无分数任务数（run.jsonl 缺失 / 任务行缺失 / 行无 score）
    旧行无 termination_reason 时 fallback requests>=30 判定触顶，与成败拆分联用；
    学习有效判读 = cap_failure_rate ↓（cap_success_rate 允许非零）
  RepeatToolRate = 相邻两回合（连续两个含 toolCall 的回合，按位置对齐 zip）
               中 (name, canonical args) 完全相同的位置数 / 全部 toolCall 数
  RetryRate  = 错误 toolResult 后下一含 toolCall 回合仍调用同名工具次数 / 错误数
  StateRevisitRate = 非相邻重复（同一 (name,args) 间隔 ≥1 完整回合后再现）/ 全部 toolCall
  ProductiveRoundRatio = 回合内任一 toolResult 文本为全新（此前未出现过）的
               含 toolCall 回合数 / 含 toolCall 回合数
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import trajectory_metrics as tm  # noqa: E402


# ── transcript 构造 helpers（QCB OpenClaw 事件形态，同 campaign.py 落盘） ──


def _transcript(events, task_id="t1", arm="experiment", day=1):
    return {
        "task_id": task_id,
        "arm": arm,
        "day": day,
        "prompt": "p",
        "transcript": list(events),
        "score": 0.8,
    }


def _assistant(*parts):
    return {"type": "message", "message": {"role": "assistant", "content": list(parts)}}


def _tool_call(name="bash", args=None):
    return {"type": "toolCall", "name": name, "arguments": args if args is not None else {}}


def _text_part(text):
    return {"type": "text", "text": text}


def _result(*texts):
    return {"type": "message", "message": {"role": "toolResult", "content": list(texts)}}


def _write(run_dir: Path, transcript_files: list[tuple[int, str, dict]], run_rows: list[dict]) -> None:
    for day, fname, doc in transcript_files:
        p = run_dir / "transcripts" / f"day{day}" / fname
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc))
    (run_dir / "run.jsonl").write_text("\n".join(json.dumps(r) for r in run_rows))


# ── 回合解析 ────────────────────────────────────────────────────────────


def test_parse_rounds_groups_assistant_events_and_tool_results():
    events = [
        _assistant(_text_part("think"), _tool_call("bash", {"command": "ls"})),
        _result("file list output"),
        _assistant(_text_part("done")),
    ]
    rounds = tm.parse_rounds(events)
    assert len(rounds) == 2
    assert [c[0] for c in rounds[0]["calls"]] == ["bash"]
    assert rounds[0]["results"] == ["file list output"]
    assert rounds[1]["calls"] == []


# ── RepeatToolRate ──────────────────────────────────────────────────────


def test_repeat_tool_rate_counts_only_adjacent_identical_calls():
    rounds = [
        {"calls": [("bash", {"command": "a"})], "results": ["ok"]},
        {"calls": [("bash", {"command": "a"})], "results": ["ok"]},  # 相邻重复
        {"calls": [("bash", {"command": "b"})], "results": ["ok"]},
    ]
    assert tm.count_repeat_tool_calls(rounds) == 1
    assert tm.count_tool_calls(rounds) == 3
    assert tm.repeat_tool_rate(rounds) == pytest.approx(1 / 3)


def test_repeat_tool_rate_canonicalizes_arguments_key_order():
    rounds = [
        {"calls": [("bash", {"command": "x", "dir": "d"})], "results": []},
        {"calls": [("bash", {"dir": "d", "command": "x"})], "results": []},  # key 序不同仍相同
        {"calls": [("bash", {"command": "x", "dir": "e"})], "results": []},  # 值不同不算
    ]
    assert tm.count_repeat_tool_calls(rounds) == 1
    assert tm.repeat_tool_rate(rounds) == pytest.approx(1 / 3)


def test_repeat_tool_rate_aligns_multiple_calls_positionally():
    rounds = [
        {"calls": [("bash", {"command": "a"}), ("bash", {"command": "b"})], "results": []},
        {"calls": [("bash", {"command": "a"}), ("bash", {"command": "b"})], "results": []},
    ]
    assert tm.count_repeat_tool_calls(rounds) == 2
    assert tm.repeat_tool_rate(rounds) == pytest.approx(2 / 4)


# ── RetryRate ───────────────────────────────────────────────────────────


def test_retry_rate_counts_same_name_call_after_error_marker():
    rounds = [
        {
            "calls": [("bash", {"command": "find /"})],
            "results": ["[command timed out after 120s — narrow the command scope]"],
        },
        {"calls": [("bash", {"command": "find /tmp"})], "results": ["ok"]},
    ]
    errors, retries = tm.count_retries(rounds)
    assert errors == 1
    assert retries == 1
    assert tm.retry_rate(rounds) == pytest.approx(1.0)


def test_retry_rate_distinguishes_error_markers_and_tool_switch():
    # 不同错误标记都算错误；换工具名不算重试。
    rounds = [
        {"calls": [("bash", {"command": "c1"})], "results": ["Error: permission denied"]},
        {"calls": [("python", {"script": "x"})], "results": ["ok"]},
        {"calls": [("bash", {"command": "c2"})], "results": ["Traceback (most recent call last)"]},
        {"calls": [("bash", {"command": "c3"})], "results": ["ok"]},
    ]
    errors, retries = tm.count_retries(rounds)
    assert errors == 2
    assert retries == 1  # 只有第 2 个错误后继续用 bash 算重试
    assert tm.retry_rate(rounds) == pytest.approx(0.5)


def test_retry_rate_counts_command_failed_marker():
    rounds = [
        {"calls": [("bash", {"command": "c1"})], "results": ["[command failed to start: No such file]"]},
        {"calls": [("bash", {"command": "c2"})], "results": ["ok"]},
    ]
    errors, retries = tm.count_retries(rounds)
    assert errors == 1
    assert retries == 1


def test_retry_rate_next_tool_round_after_text_only_round():
    # 错误之后隔一个纯文本回合仍算"下一含 toolCall 回合"。
    rounds = [
        {"calls": [("bash", {"command": "c1"})], "results": ["Error: boom"]},
        {"calls": [], "results": []},
        {"calls": [("bash", {"command": "c2"})], "results": ["ok"]},
    ]
    errors, retries = tm.count_retries(rounds)
    assert errors == 1
    assert retries == 1


# ── StateRevisitRate ────────────────────────────────────────────────────


def test_state_revisit_rate_counts_non_adjacent_only():
    rounds = [
        {"calls": [("bash", {"command": "a"})], "results": []},
        {"calls": [("bash", {"command": "b"})], "results": []},
        {"calls": [("bash", {"command": "a"})], "results": []},  # 间隔 1 回合 → revisit
    ]
    assert tm.count_state_revisits(rounds) == 1
    assert tm.state_revisit_rate(rounds) == pytest.approx(1 / 3)

    # 相邻重复（[a],[a]）不算 revisit（那是 RepeatToolRate 的口径）。
    adjacent = [
        {"calls": [("bash", {"command": "a"})], "results": []},
        {"calls": [("bash", {"command": "a"})], "results": []},
    ]
    assert tm.count_state_revisits(adjacent) == 0
    assert tm.state_revisit_rate(adjacent) == 0.0


# ── ProductiveRoundRatio ────────────────────────────────────────────────


def test_productive_round_ratio_novel_result_text():
    rounds = [
        {"calls": [("bash", {"command": "a"})], "results": ["output A"]},  # 全新 → productive
        {"calls": [("bash", {"command": "b"})], "results": ["output A"]},  # 重复 → 不 productive
        {"calls": [("bash", {"command": "c"})], "results": ["output A", "output B"]},  # 任一全新 → productive
    ]
    productive, tool_rounds = tm.count_productive_rounds(rounds)
    assert productive == 2
    assert tool_rounds == 3
    assert tm.productive_round_ratio(rounds) == pytest.approx(2 / 3)


def test_productive_round_ratio_empty_and_no_tool_rounds():
    assert tm.productive_round_ratio([]) == 0.0
    assert tm.productive_round_ratio([{"calls": [], "results": []}]) == 0.0


# ── RoundCount 分布与 CapRate 双口径 ────────────────────────────────────


def test_percentile_linear_interpolation():
    assert tm._percentile([5, 10, 20], 50) == 10.0
    assert tm._percentile([5, 10, 20], 75) == 15.0
    assert tm._percentile([5, 10, 20], 90) == 18.0
    assert tm._percentile([5, 10, 20], 95) == 19.0
    assert tm._percentile([7], 50) == 7.0


def test_cap_rate_split_by_outcome(tmp_path):
    """触顶 × 成败四象限 + fallback 旧行联用 + 无分数 unknown。"""
    run_dir = tmp_path / "run"
    _write(
        run_dir,
        [
            (1, "experiment-t1.json", _transcript([], task_id="t1")),
            (1, "experiment-t2.json", _transcript([], task_id="t2")),
            (1, "experiment-t3.json", _transcript([], task_id="t3")),
            (1, "experiment-t4.json", _transcript([], task_id="t4")),
            (1, "experiment-t5.json", _transcript([], task_id="t5")),
            (1, "experiment-t6.json", _transcript([], task_id="t6")),
        ],
        [
            # 触顶且失败（"无效绕圈"）
            {"day": 1, "arm": "experiment", "task_id": "t1", "score": 0.2, "termination_reason": "max_turns",
             "requests": 30},
            # 未触顶且成功（现代行有 termination_reason：requests=30 不误判）
            {"day": 1, "arm": "experiment", "task_id": "t2", "score": 0.8, "termination_reason": "completed",
             "requests": 30},
            # 旧行（无 termination_reason）requests>=30 触顶 + score 0.9 → 触顶且成功（"预算用满但交付"）
            {"day": 1, "arm": "experiment", "task_id": "t3", "score": 0.9, "requests": 30},
            # 旧行 requests=29 → 未触顶（fallback 判定与成败拆分联用）
            {"day": 1, "arm": "experiment", "task_id": "t4", "score": 0.4, "requests": 29},
            # t5：transcript 存在但 run.jsonl 无对应任务行 → unknown
            # t6：任务行存在但无 score 键 → 触顶但 unknown
            {"day": 1, "arm": "experiment", "task_id": "t6", "termination_reason": "max_turns", "requests": 30},
        ],
    )
    total = tm.analyze(run_dir)["total"]
    assert total["tasks"] == 6
    assert total["cap_rate"] == pytest.approx(3 / 6)  # t1 + t3 + t6
    assert total["cap_success_rate"] == pytest.approx(1 / 6)  # t3
    assert total["cap_failure_rate"] == pytest.approx(1 / 6)  # t1
    assert total["cap_unknown_n"] == 2  # t5（缺行）+ t6（缺 score）
    assert total["caprate_fallback_n"] == 2  # t3 + t4
    # cap_success + cap_failure <= cap_rate（unknown 触顶不落入任何一档）。
    assert total["cap_success_rate"] + total["cap_failure_rate"] <= total["cap_rate"]


def test_cap_split_score_threshold_boundary(tmp_path):
    """成功边界与 campaign PASS_THRESHOLD 同口径：score >= 0.5。"""
    run_dir = tmp_path / "run"
    _write(
        run_dir,
        [
            (1, "experiment-t1.json", _transcript([], task_id="t1")),
            (1, "experiment-t2.json", _transcript([], task_id="t2")),
        ],
        [
            {"day": 1, "arm": "experiment", "task_id": "t1", "score": 0.5, "termination_reason": "max_turns",
             "requests": 30},
            {"day": 1, "arm": "experiment", "task_id": "t2", "score": 0.49, "termination_reason": "max_turns",
             "requests": 30},
        ],
    )
    total = tm.analyze(run_dir)["total"]
    assert total["cap_success_rate"] == pytest.approx(1 / 2)
    assert total["cap_failure_rate"] == pytest.approx(1 / 2)
    assert total["cap_unknown_n"] == 0


def test_missing_run_jsonl_counts_all_tasks_unknown(tmp_path):
    """run.jsonl 整体缺失：不炸，全部任务计入 unknown 组（用户 08-19 裁决）。"""
    run_dir = tmp_path / "run"
    (run_dir / "transcripts" / "day1").mkdir(parents=True)
    (run_dir / "transcripts" / "day1" / "experiment-a.json").write_text(json.dumps(_transcript([])))
    (run_dir / "transcripts" / "day1" / "experiment-b.json").write_text(json.dumps(_transcript([])))
    total = tm.analyze(run_dir)["total"]
    assert total["tasks"] == 2
    assert total["cap_rate"] == 0.0
    assert total["cap_success_rate"] == 0.0
    assert total["cap_failure_rate"] == 0.0
    assert total["cap_unknown_n"] == 2


def test_round_count_distribution_across_tasks(tmp_path):
    run_dir = tmp_path / "run"
    docs = []
    rows = []
    for i, n_rounds in enumerate([5, 10, 20]):
        events = []
        for _ in range(n_rounds):
            events.append(_assistant(_text_part(f"r{i}")))
        docs.append((1, f"experiment-t{i}.json", _transcript(events, task_id=f"t{i}")))
        rows.append(
            {
                "day": 1,
                "arm": "experiment",
                "task_id": f"t{i}",
                "termination_reason": "completed",
                "requests": n_rounds,
            }
        )
    _write(run_dir, docs, rows)
    rc = tm.analyze(run_dir)["total"]["round_count"]
    assert rc == {"p50": 10.0, "p75": 15.0, "p90": 18.0, "p95": 19.0}


# ── analyze 分组与 CLI ──────────────────────────────────────────────────


def test_analyze_groups_by_day_and_arm(tmp_path):
    run_dir = tmp_path / "run"
    _write(
        run_dir,
        [
            (1, "experiment-a.json", _transcript([], task_id="a")),
            (1, "control-b.json", _transcript([], task_id="b", arm="control")),
            (2, "experiment-c.json", _transcript([], task_id="c", day=2)),
        ],
        [
            {"day": 1, "arm": "experiment", "task_id": "a", "score": 0.2, "termination_reason": "max_turns",
             "requests": 30},
            {"day": 1, "arm": "control", "task_id": "b", "score": 0.8, "termination_reason": "completed",
             "requests": 5},
            {"day": 2, "arm": "experiment", "task_id": "c", "score": 0.7, "termination_reason": "completed",
             "requests": 5},
        ],
    )
    report = tm.analyze(run_dir)
    assert report["run_id"] == "run"
    assert report["days"] == [1, 2]
    assert report["total"]["tasks"] == 3
    assert set(report["by_day"]) == {"1", "2"}
    assert report["by_day"]["1"]["tasks"] == 2
    assert set(report["by_arm"]) == {"experiment", "control"}
    assert report["by_arm"]["control"]["tasks"] == 1
    assert report["by_arm"]["control"]["cap_rate"] == 0.0
    # 按日/按臂分组同口径：day1 含 a（触顶失败）+ b（未触顶）。
    assert report["by_day"]["1"]["cap_failure_rate"] == pytest.approx(1 / 2)
    assert report["by_day"]["1"]["cap_success_rate"] == 0.0
    assert report["by_day"]["1"]["cap_unknown_n"] == 0
    assert report["by_arm"]["experiment"]["cap_failure_rate"] == pytest.approx(1 / 2)

    day1 = tm.analyze(run_dir, day=1)
    assert day1["days"] == [1]
    assert day1["total"]["tasks"] == 2
    assert set(day1["by_arm"]) == {"experiment", "control"}


def test_cli_prints_json_report(tmp_path, capsys):
    run_dir = tmp_path / "run"
    _write(
        run_dir,
        [(1, "experiment-a.json", _transcript([], task_id="a"))],
        [{"day": 1, "arm": "experiment", "task_id": "a", "termination_reason": "completed", "requests": 3}],
    )
    assert tm.main([str(run_dir), "--day", "1"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert set(report) == {"run_id", "days", "total", "by_day", "by_arm"}
    assert report["total"]["tasks"] == 1
