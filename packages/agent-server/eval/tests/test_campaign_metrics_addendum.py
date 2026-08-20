"""D 阶段增强 §3 假独立三指标测试（pytest，eval/.venv 运行）。

预注册口径（preview.html §3，Analysis Addendum）：
  成功 = score >= 0.5（与 PASS_THRESHOLD 同口径）
  "明显失败"组合：score < 0.3 ∨ grading_error == True ∨
    (termination_reason == "max_turns" ∧ score < 0.5)；旧行无
    termination_reason 时该子句跳过（.get 容错）。
  三指标只做报告，不改既有判据函数。
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from campaign_metrics import addendum_metrics, is_obvious_failure  # noqa: E402


def _row(score, *, escalated=False, grading_error=None, termination_reason=None, **kw):
    row = {
        "day": 1,
        "task_id": "task_x",
        "kind": "repeat",
        "arm": "experiment",
        "score": score,
        "passed": score >= 0.5,
        "escalated": escalated,
        "requests": 5,
        **kw,
    }
    if grading_error is not None:
        row["grading"] = {"score": score, "grading_error": grading_error}
    if termination_reason is not None:
        row["termination_reason"] = termination_reason
    return row


# ── "明显失败"组合阈值边界 ──────────────────────────────────────────────


def test_obvious_failure_score_threshold_boundaries():
    # score < 0.3 为明显失败；0.3 边界本身不算。
    assert is_obvious_failure(_row(0.29)) is True
    assert is_obvious_failure(_row(0.30)) is False
    assert is_obvious_failure(_row(0.49)) is False


def test_obvious_failure_grading_error_wins_over_score():
    # 评分崩溃（safe_grade 落 grading_error=True）即使 score 高也算明显失败。
    assert is_obvious_failure(_row(0.8, grading_error=True)) is True
    # 嵌套（row["grading"]）与顶层（row["grading_error"]）两种形态都认。
    assert is_obvious_failure({**_row(0.8), "grading_error": True}) is True


def test_obvious_failure_max_turns_clause():
    # max_turns 触顶且 score < 0.5 → 明显失败；score >= 0.5 不算（触顶但完成了）。
    assert is_obvious_failure(_row(0.4, termination_reason="max_turns")) is True
    assert is_obvious_failure(_row(0.6, termination_reason="max_turns")) is False
    assert is_obvious_failure(_row(0.4, termination_reason="completed")) is False


def test_obvious_failure_old_rows_without_termination_reason():
    # 旧 run.jsonl 行无 termination_reason：该子句跳过（.get 容错）。
    assert is_obvious_failure(_row(0.4)) is False
    # 仍可被 score < 0.3 子句捕获。
    assert is_obvious_failure(_row(0.2)) is True


# ── 三指标 ─────────────────────────────────────────────────────────────


def test_autonomous_success_rate():
    rows = [
        _row(0.8, escalated=False),  # 成功未升级
        _row(0.7, escalated=False),  # 成功未升级
        _row(0.9, escalated=True),  # 成功但升级过 → 不算 autonomous
        _row(0.4, escalated=False),  # 失败
        _row(0.2, escalated=False),  # 失败
    ]
    m = addendum_metrics(rows)
    assert m["autonomous_success_rate"] == pytest.approx(2 / 5)
    assert m["autonomous_success_n"] == 2
    assert m["total_n"] == 5


def test_missed_escalation_rate():
    rows = [
        _row(0.1, escalated=False),  # 明显失败且未升级 → missed
        _row(0.2, escalated=False),  # missed
        _row(0.1, escalated=True),  # 明显失败但已升级 → 不 missed
        _row(0.4, termination_reason="max_turns"),  # 明显失败（触顶 ∧ <0.5）未升级 → missed
        _row(0.8, escalated=False),  # 成功，非明显失败
    ]
    m = addendum_metrics(rows)
    assert m["obvious_failure_n"] == 4
    assert m["missed_escalation_n"] == 3
    assert m["missed_escalation_rate"] == pytest.approx(3 / 4)


def test_escalated_success_rate():
    rows = [
        _row(0.8, escalated=True),
        _row(0.6, escalated=True),
        _row(0.2, escalated=True),
        _row(0.9, escalated=False),  # 未升级不算分母
    ]
    m = addendum_metrics(rows)
    assert m["escalated_n"] == 3
    assert m["escalated_success_n"] == 2
    assert m["escalated_success_rate"] == pytest.approx(2 / 3)


def test_zero_denominators_report_zero():
    m = addendum_metrics([])
    assert m == {
        "autonomous_success_rate": 0.0,
        "autonomous_success_n": 0,
        "total_n": 0,
        "missed_escalation_rate": 0.0,
        "missed_escalation_n": 0,
        "obvious_failure_n": 0,
        "escalated_success_rate": 0.0,
        "escalated_success_n": 0,
        "escalated_n": 0,
    }
    # 无升级任务、无失败任务时比率同为 0（分母计数可见）。
    m2 = addendum_metrics([_row(0.8, escalated=False)])
    assert m2["escalated_n"] == 0
    assert m2["escalated_success_rate"] == 0.0
    assert m2["obvious_failure_n"] == 0
    assert m2["missed_escalation_rate"] == 0.0


# ── --metrics 报告接线 ─────────────────────────────────────────────────


def test_metrics_report_includes_addendum_section(tmp_path, capsys, monkeypatch):
    import campaign

    p = tmp_path / "run.jsonl"
    p.write_text(
        "\n".join(
            json.dumps(r)
            for r in [
                _row(0.8, escalated=False),
                _row(0.1, escalated=False),
                _row(0.9, escalated=True),
            ]
        )
    )
    monkeypatch.setattr(
        sys, "argv", ["campaign.py", "--metrics", str(p), "--gateway-db", str(tmp_path / "missing-gateway.db")]
    )
    campaign.main()
    report = json.loads(capsys.readouterr().out)
    assert "addendum" in report
    assert report["addendum"]["total_n"] == 3
    assert report["addendum"]["autonomous_success_n"] == 1
    assert report["addendum"]["missed_escalation_n"] == 1
    assert report["addendum"]["escalated_n"] == 1
    assert report["addendum"]["escalated_success_n"] == 1
    # 既有判据节不受影响。
    assert "daily" in report
    assert "criteria" in report
