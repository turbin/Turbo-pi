"""C 阶段 campaign 脚手架测试（pytest，eval/.venv 运行）。"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from campaign_metrics import check_criteria, daily_summary, escalation_rate, load_results  # noqa: E402
from campaign_plan import DAYS, REPEAT_N, daily_batch, load_tasks, split_tasks  # noqa: E402


@pytest.fixture(scope="module")
def tasks():
    return load_tasks()


def test_corpus_loads_99_tasks(tasks):
    # 100 任务减去排除的 task_00005（飞书依赖）。
    assert len(tasks) == 99
    assert all(t.id.startswith("task_") for t in tasks)


def test_split_covers_all_tasks_without_overlap(tasks):
    repeat, new = split_tasks(tasks)
    assert len(repeat) == REPEAT_N
    assert not set(repeat) & set(new)
    assert sorted(repeat + new) == sorted(t.id for t in tasks)


def test_split_is_deterministic(tasks):
    assert split_tasks(tasks) == split_tasks(tasks)


def test_daily_batches_cover_new_tasks_exactly_once(tasks):
    seen: list[str] = []
    for day in range(1, DAYS + 1):
        batch = daily_batch(tasks, day)
        assert len(batch["repeat"]) == REPEAT_N
        seen.extend(batch["new"])
    _, new = split_tasks(tasks)
    assert sorted(seen) == new


def test_daily_batch_rejects_out_of_range(tasks):
    with pytest.raises(ValueError):
        daily_batch(tasks, 0)


def _row(day, kind, escalated, passed=True, arm="experiment"):
    return {
        "day": day,
        "task_id": "task_x",
        "kind": kind,
        "arm": arm,
        "score": 1.0 if passed else 0.0,
        "passed": passed,
        "escalated": escalated,
        "requests": 5,
    }


def test_metrics_criteria_pass_case(tmp_path):
    rows = []
    for day in range(1, 8):
        # 重复任务升级率逐日降到 D7=0/20（D6=1/20=5%，D7=0）
        rows += [_row(day, "repeat", escalated=(i < max(0, 7 - day))) for i in range(20)]
        rows += [_row(day, "new", escalated=(i == 0)) for i in range(11)]
    path = tmp_path / "results.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in rows))

    result = check_criteria(load_results(path))
    assert result["final_day"] == 7
    assert result["repeat_escalation_final_day"] == 0.0
    assert result["criterion1_repeat_ok"] is True
    assert result["new_escalation_all"] == pytest.approx(7 / 77)
    assert result["criterion2_new_ok"] is True


def test_metrics_criteria_fail_case():
    rows = [_row(7, "repeat", escalated=True) for _ in range(4)] + [
        _row(7, "repeat", escalated=False) for _ in range(16)
    ]
    result = check_criteria(rows)
    assert result["repeat_escalation_final_day"] == pytest.approx(0.2)
    assert result["criterion1_repeat_ok"] is False


def test_daily_summary_ignores_control_arm_in_experiment_columns():
    rows = [
        _row(1, "repeat", escalated=True, arm="experiment"),
        _row(1, "repeat", escalated=False, arm="control"),
    ]
    summary = daily_summary(rows)
    assert summary[0]["repeat_n"] == 1
    assert summary[0]["repeat_esc"] == 1.0


def test_escalation_rate_empty_is_zero():
    assert escalation_rate([]) == 0.0
