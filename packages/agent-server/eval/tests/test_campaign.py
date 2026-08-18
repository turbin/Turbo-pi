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


def _gateway_db_with_window(tmp_path, name: str):
    """建 model_runs + request_executions（带 created_at），返回 db 路径。"""
    import sqlite3

    db = tmp_path / name
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE model_runs (trace_id TEXT, purpose TEXT, state TEXT, quality_signals_json TEXT)"
    )
    con.execute("CREATE TABLE request_executions (trace_id TEXT PRIMARY KEY, created_at TEXT)")
    rows = [
        # 旧窗口：length 升级（脏历史，B 阶段残留）
        ("t-old-1", "2026-08-04 21:00:00.000000"),
        ("t-old-2", "2026-08-04 21:05:00.000000"),
        # 新窗口（pilot）：t-new-1 未升级、t-new-2 length 升级
        ("t-new-1", "2026-08-09 10:00:00.000000"),
        ("t-new-2", "2026-08-09 10:05:00.000000"),
    ]
    con.executemany("INSERT INTO request_executions VALUES (?, ?)", rows)
    runs = [
        ("t-old-1", "primary", "succeeded", None),
        ("t-old-1", "escalation", "succeeded", '{"escalation_reason": "finish_reason_length"}'),
        ("t-old-2", "primary", "succeeded", None),
        ("t-new-1", "primary", "succeeded", None),
        ("t-new-2", "primary", "succeeded", None),
        ("t-new-2", "escalation", "succeeded", '{"escalation_reason": "finish_reason_length"}'),
    ]
    con.executemany("INSERT INTO model_runs VALUES (?, ?, ?, ?)", runs)
    con.commit()
    con.close()
    return db


def test_gate_length_escalation_since_window(tmp_path):
    """issue-005：--since 后只统计窗口内请求——共享 DB 的历史脏数据
    （全历史口径 2/3=0.67）不再把 pilot 窗口钉死。"""
    from gate_length_escalation import main

    db = _gateway_db_with_window(tmp_path, "gateway.db")

    # 全历史口径：3 请求 2 个 length 升级 → FAIL。
    assert main(["--db", str(db), "--max-rate", "0.5"]) == 1
    # --since 过滤：仅 t-new-1/t-new-2 → 1/2=0.5。
    assert main(["--db", str(db), "--max-rate", "0.9", "--since", "2026-08-09T00:00:00"]) == 0
    assert main(["--db", str(db), "--max-rate", "0.5", "--since", "2026-08-09T00:00:00"]) == 1


def test_gate_length_escalation_last_hours(tmp_path):
    """issue-005：--last-hours N 相对 now 倒推窗口。"""
    import datetime

    from gate_length_escalation import main

    db = _gateway_db_with_window(tmp_path, "gateway2.db")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    # 把新窗口数据的时间改为 now（pilot 刚跑完），旧数据保持 5 天前。
    import sqlite3

    con = sqlite3.connect(db)
    con.execute("UPDATE request_executions SET created_at = ? WHERE trace_id LIKE 't-new-%'", (now + ".000000",))
    con.commit()
    con.close()

    # --last-hours 24：只统计 t-new-*（1/2=0.5）→ 0.9 阈值 PASS、0.5 阈值 FAIL。
    assert main(["--db", str(db), "--max-rate", "0.9", "--last-hours", "24"]) == 0
    assert main(["--db", str(db), "--max-rate", "0.5", "--last-hours", "24"]) == 1


# ── issue-003 C1：run_agent 必须显式接收 injection 参数（red-first）────────


def test_run_agent_accepts_injection_kwarg_and_records_marker(tmp_path):
    """C1 回归：committed 代码中 run_agent 无 injection 参数，首个真实任务即
    TypeError。现在必须显式接收并转发到 extra_body，且记录升级标记与 trace_ids。

    F0（issue-013）：task_id 同为必选关键字参数——extra_body 必须携带
    {"injection", "task_id"}，缺归因键静默丢失 F2 join 链。"""
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
        client, "agent-auto", "do the thing", tmp_path, timeout_s=60, injection=False, task_id="task_00042"
    )
    assert seen["extra_body"] == {"injection": False, "task_id": "task_00042"}
    assert result["status"] == "completed"
    assert result["trace_ids"] == ["chatcmpl-fake-1"]
    assert result["escalated"] is True


# ── 2026-08-09 D1 事故：单请求 APITimeout 杀死整日批次（red-first）────────


def test_run_agent_retries_transient_api_errors(tmp_path):
    """27B 慢回合 latency 可达 700-950s；单次 APITimeoutError 不得杀死批次。"""
    import types

    import campaign
    import openai

    campaign.RETRY_BASE_SECONDS = 0
    calls = {"n": 0}

    class Msg:
        content = "ok"
        tool_calls = None

        def model_dump(self):
            return {"role": "assistant", "content": "ok"}

    class Resp:
        id = "chatcmpl-fake-2"
        headers = {}
        choices = [types.SimpleNamespace(message=Msg())]

    class Completions:
        def create(self, **kwargs):
            calls["n"] += 1
            if calls["n"] < 3:
                raise openai.APITimeoutError(request=None)
            return Resp()

    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=Completions()))
    result = campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=60, injection=False, task_id="task_x")
    assert calls["n"] == 3
    assert result["status"] == "completed"


def test_run_agent_gives_up_after_max_retries(tmp_path):
    import types

    import campaign
    import openai

    campaign.RETRY_BASE_SECONDS = 0

    class Completions:
        def create(self, **kwargs):
            raise openai.APIConnectionError(request=None)

    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=Completions()))
    with pytest.raises(Exception):
        campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=60, injection=False, task_id="task_x")


def test_run_agent_tool_timeout_returns_observation_not_crash(tmp_path):
    """2026-08-10 D2 事故：agent 发起的大范围 find 扫描撞 120s 工具超时，
    TimeoutExpired 未捕获杀死整批。工具超时必须作为观察返回给 agent。"""
    import types

    import campaign

    campaign.RETRY_BASE_SECONDS = 0
    campaign.TOOL_TIMEOUT_SECONDS = 1  # 测试提速

    class MsgWithCall:
        content = None
        tool_calls = [
            types.SimpleNamespace(
                id="call_1",
                function=types.SimpleNamespace(name="bash", arguments='{"command": "sleep 5"}'),
            )
        ]

        def model_dump(self):
            return {"role": "assistant", "content": None, "tool_calls": []}

    class MsgFinal:
        content = "understood, adapting"
        tool_calls = None

        def model_dump(self):
            return {"role": "assistant", "content": "understood, adapting"}

    class Resp:
        def __init__(self, msg):
            self.id = "chatcmpl-fake-3"
            self.headers = {}
            self.choices = [types.SimpleNamespace(message=msg)]

    class Completions:
        def __init__(self):
            self.n = 0

        def create(self, **kwargs):
            self.n += 1
            return Resp(MsgWithCall() if self.n == 1 else MsgFinal())

    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=Completions()))
    result = campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=60, injection=False, task_id="task_x")
    assert result["status"] == "completed"
    # 工具超时被转换为 toolResult 观察而不是异常
    tool_results = [
        e for e in result["transcript"]
        if e.get("message", {}).get("role") == "toolResult"
    ]
    assert tool_results, "expected a toolResult entry for the timed-out command"
    assert "timed out" in tool_results[0]["message"]["content"][0]


def test_safe_grade_degrades_on_grader_crash(tmp_path, monkeypatch):
    """issue-011：任务内嵌评分脚本自身 bug（UnboundLocalError 等）不得杀死批次。"""
    import campaign

    def boom(task_id, execution, ws):
        raise UnboundLocalError("cannot access local variable 'readme_content'")

    monkeypatch.setattr(campaign, "grade", boom)
    g = campaign.safe_grade("task_x", {}, tmp_path)
    assert g["grading_error"] is True
    assert g["score"] == 0.0
    assert g["grading_type"] == "error"
    assert "readme_content" in g["notes"]


def test_completed_keys_for_resume(tmp_path):
    import json

    import campaign

    p = tmp_path / "run.jsonl"
    p.write_text(
        "\n".join([
            json.dumps({"day": 1, "arm": "experiment", "task_id": "task_a"}),
            json.dumps({"day": 1, "arm": "control", "task_id": "task_a"}),
        ])
    )
    assert campaign.completed_keys(p) == {(1, "experiment", "task_a"), (1, "control", "task_a")}
    assert campaign.completed_keys(tmp_path / "missing.jsonl") == set()
