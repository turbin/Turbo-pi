"""C 阶段 campaign 脚手架测试（pytest，eval/.venv 运行）。"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from campaign_metrics import annotate_escalation, check_criteria, daily_summary, escalation_rate, load_results  # noqa: E402
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


# ── issue-003 C2：未标注行 fail loud（red-first）───────────────────────────


def test_escalation_rate_fails_loud_on_unmarked_rows():
    rows = [_row(7, "repeat", escalated=False) for _ in range(3)]
    rows.append({k: v for k, v in rows[0].items() if k != "escalated"})  # 缺 escalated 标记
    with pytest.raises(ValueError, match="escalated"):
        escalation_rate(rows)


def test_check_criteria_fails_loud_when_annotation_missing():
    rows = [_row(7, "repeat", escalated=True) for _ in range(4)]
    rows.append({k: v for k, v in _row(7, "repeat", escalated=False).items() if k != "escalated"})
    with pytest.raises(ValueError, match="escalated"):
        check_criteria(rows)


def test_annotate_escalation_joins_model_runs(tmp_path):
    """C2：按 trace_id 从 gateway model_runs 回填缺失的 escalated 标记。"""
    import sqlite3

    db = tmp_path / "gateway.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE model_runs (trace_id TEXT, purpose TEXT, state TEXT)")
    con.execute("INSERT INTO model_runs VALUES ('t-esc', 'escalation', 'succeeded')")
    con.execute("INSERT INTO model_runs VALUES ('t-local', 'primary', 'succeeded')")
    con.commit()
    con.close()

    rows = [
        {"day": 1, "trace_ids": ["t-esc"], "arm": "experiment", "kind": "repeat"},
        {"day": 1, "trace_ids": ["t-local"], "arm": "experiment", "kind": "repeat"},
        {"day": 1, "trace_ids": ["t-esc"], "escalated": True, "arm": "experiment", "kind": "repeat"},  # 已有标记不动
    ]
    out = annotate_escalation(rows, db)
    assert out[0]["escalated"] is True
    assert out[1]["escalated"] is False
    assert out[2]["escalated"] is True


def test_annotate_escalation_missing_db_fails(tmp_path):
    with pytest.raises(FileNotFoundError):
        annotate_escalation([_row(1, "repeat", escalated=False)], tmp_path / "nope.db")


# ── issue-003 回归测试 2：length 升级率 gating 脚本 ─────────────────────────


def test_gate_length_escalation_stats(tmp_path):
    """全量口径：finish_reason_length 升级占比（按 trace 去重）。"""
    import sqlite3

    from gate_length_escalation import length_escalation_stats

    db = tmp_path / "gateway.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE model_runs (trace_id TEXT, purpose TEXT, state TEXT, quality_signals_json TEXT)"
    )
    con.executemany(
        "INSERT INTO model_runs VALUES (?, ?, ?, ?)",
        [
            ("t1", "primary", "succeeded", None),
            ("t1", "escalation", "succeeded", '{"escalation_reason": "finish_reason_length"}'),
            ("t2", "primary", "succeeded", None),
            ("t2", "escalation", "succeeded", '{"escalation_reason": "empty_output"}'),
            ("t3", "primary", "succeeded", None),  # 未升级
        ],
    )
    con.commit()
    con.close()

    stats = length_escalation_stats(db)
    assert stats == {"total_requests": 3, "length_escalated": 1}


def test_gate_length_escalation_cli(tmp_path):
    """CLI 退出码：未达标=1（禁止开跑），达标=0。"""
    import sqlite3

    from gate_length_escalation import main

    db = tmp_path / "gateway.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE model_runs (trace_id TEXT, purpose TEXT, state TEXT, quality_signals_json TEXT)"
    )
    con.executemany(
        "INSERT INTO model_runs VALUES (?, ?, ?, ?)",
        [
            ("t1", "primary", "succeeded", None),
            ("t1", "escalation", "succeeded", '{"escalation_reason": "finish_reason_length"}'),
            ("t2", "primary", "succeeded", None),  # 未升级
        ],
    )
    con.commit()
    con.close()

    # 2 请求中 1 个 length 升级 = 50% >> 5%：禁止开跑。
    code = main(["--db", str(db), "--max-rate", "0.05"])
    assert code == 1
    # 宽松阈值下通过。
    assert main(["--db", str(db), "--max-rate", "0.9"]) == 0
    # 空库拒绝盲跑。
    empty = tmp_path / "empty.db"
    con = sqlite3.connect(empty)
    con.execute(
        "CREATE TABLE model_runs (trace_id TEXT, purpose TEXT, state TEXT, quality_signals_json TEXT)"
    )
    con.commit()
    con.close()
    assert main(["--db", str(empty)]) == 1


# ── issue-003 C1：run_agent 必须显式接收 injection 参数（red-first）────────


def test_run_agent_accepts_injection_kwarg_and_records_marker(tmp_path):
    """C1 回归：committed 代码中 run_agent 无 injection 参数，首个真实任务即
    TypeError。现在必须显式接收并转发到 extra_body，且记录升级标记与 trace_ids。"""
    import types

    import campaign

    seen: dict = {}

    class Msg:
        content = "task complete"
        tool_calls = None

        def model_dump(self):
            return {"role": "assistant", "content": self.content}

    class Resp:
        id = "chatcmpl-fake-1"
        headers = {"x-gateway": '{"escalated": true, "reason": "finish_reason_length", "provider": "kimi"}'}
        choices = [types.SimpleNamespace(message=Msg())]

    class Completions:
        def create(self, **kwargs):
            seen["extra_body"] = kwargs.get("extra_body")
            return Resp()

    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=Completions()))

    result = campaign.run_agent(
        client, "agent-auto", "do the thing", tmp_path, timeout_s=60, injection=False
    )
    assert seen["extra_body"] == {"injection": False}
    assert result["status"] == "completed"
    assert result["trace_ids"] == ["chatcmpl-fake-1"]
    assert result["escalated"] is True
