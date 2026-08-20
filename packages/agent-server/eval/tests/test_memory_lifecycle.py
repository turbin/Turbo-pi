"""memory_lifecycle.py 测试（T7，评审 §八：Memory 生命周期离线报表）。

预注册口径（见 memory_lifecycle.py docstring）：
  ReuseCount        = request_traces.retrieved_ids 展开逐卡计数
  SuccessAfterReuse = 有检索命中的任务中 score>=0.5（任务分 = run.jsonl 行最大值）
                     的比例
  Utility           = 有 ON/OFF 对照配对时 mean(score_ON − score_OFF)（限命中
                     任务，同日配对）；无配对时用命中任务 score 均值近似并标注
  Age               = created_at 到今天的自然日数
  DuplicateRate     = 同 source_task 的多 active 卡比例（active 口径 =
                     experiences.status='active'，experience-store.ts）
"""

import json
import sqlite3
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import memory_lifecycle as ml  # noqa: E402

SCHEMA = """
CREATE TABLE experiences (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT NOT NULL,
    quality REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    rescore_excluded_batches INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    branch_path TEXT,
    times_selected INTEGER NOT NULL DEFAULT 0,
    source_session TEXT NOT NULL,
    source_entry_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE request_traces (
    request_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    model TEXT NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0,
    retrieved_count INTEGER NOT NULL DEFAULT 0,
    retrieved_ids TEXT NOT NULL DEFAULT '[]',
    retrieved_kinds TEXT NOT NULL DEFAULT '[]',
    hit INTEGER NOT NULL DEFAULT 0,
    injected_ids TEXT NOT NULL DEFAULT '[]',
    task_id TEXT,
    finish_reason TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER,
    error TEXT,
    retrieved_scores TEXT NOT NULL DEFAULT '[]',
    injected_tokens INTEGER
);
"""


def make_db(experiences=None, traces=None):
    con = sqlite3.connect(":memory:")
    con.executescript(SCHEMA)
    for row in experiences or []:
        con.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
            " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
    for row in traces or []:
        con.execute(
            "INSERT INTO request_traces (request_id, ts, model, retrieved_ids, hit, injected_ids, task_id)"
            " VALUES (?,?,?,?,?,?,?)",
            row,
        )
    con.commit()
    return con


def _trace(rid, task_id, retrieved, hit=1, injected="[]"):
    return (rid, "2026-08-19T00:00:00Z", "m", json.dumps(retrieved), hit, injected, task_id)


def _card(card_id, payload, status="active", created_at="2026-08-19T00:00:00Z"):
    return (card_id, "ABILITY", "t", json.dumps(payload), 0.8, 0.5, status, "s.jsonl", "e1", "h1", created_at)


def _row(task_id, day=1, arm="experiment", score=0.5):
    return {"day": day, "task_id": task_id, "arm": arm, "score": score, "requests": 5}


# ── ReuseCount ──


def test_reuse_counts():
    con = make_db(traces=[_trace("r1", "t1", ["c1", "c2"]), _trace("r2", "t1", ["c2"]), _trace("r3", "t2", [])])
    assert ml.reuse_counts(con) == {"c1": 1, "c2": 2}


def test_reuse_counts_empty():
    assert ml.reuse_counts(make_db()) == {}


# ── SuccessAfterReuse ──


def test_success_after_reuse():
    con = make_db(
        traces=[
            _trace("r1", "t1", ["c1"]),  # 命中
            _trace("r2", "t2", ["c2"]),  # 命中
            _trace("r3", "t3", []),  # 未命中
        ]
    )
    rows = [_row("t1", score=0.8), _row("t2", score=0.2), _row("t3", score=0.9)]
    res = ml.success_after_reuse(con, rows)
    assert res["n_hit_tasks"] == 2
    assert res["n_success"] == 1
    assert res["rate"] == 0.5


def test_success_after_reuse_no_hits():
    con = make_db(traces=[_trace("r3", "t3", [])])
    res = ml.success_after_reuse(con, [_row("t3")])
    assert res["n_hit_tasks"] == 0
    assert res["rate"] == 0.0


# ── Utility ──


def test_utility_four_arm_day_pairs_x2_x3_not_x1_x3():
    # 配对规则（预注册，pi-test 5.2 打回修复）：只允许同库配对照——
    # experiment vs control / 四臂日 x2 vs x3；x1（冻结+ON）−x3（当日+OFF）
    # 等混库组合一律不配对。
    con = make_db(traces=[_trace("r1", "t1", ["c1"])])
    rows = [
        _row("t1", day=7, arm="x1", score=0.9),
        _row("t1", day=7, arm="x2", score=0.6),
        _row("t1", day=7, arm="x3", score=0.5),
        _row("t1", day=7, arm="x4", score=0.8),
    ]
    res = ml.utility(con, rows)
    assert res["method"] == "matched"
    assert res["value"] == pytest.approx(0.1)  # x2(0.6) − x3(0.5)，非旧行为的 x1−x3
    assert res["n_pairs"] == 1
    assert res["unpaired_n"] == 0


def test_utility_mixed_library_combo_never_paired_and_counted():
    # 只有混库/冻结组合的任务日：跳过并计 unpaired_n → 无合法配对 → 近似
    con = make_db(traces=[_trace("r1", "t1", ["c1"]), _trace("r2", "t2", ["c1"])])
    rows = [
        _row("t1", day=7, arm="x1", score=0.9),  # x1−x3 混库组合
        _row("t1", day=7, arm="x3", score=0.5),
        _row("t2", day=7, arm="x1", score=0.4),  # x1−x4 冻结组合（同样不配对）
        _row("t2", day=7, arm="x4", score=0.8),
    ]
    res = ml.utility(con, rows)
    assert res["method"] == "approximation"  # 无合法配对 → 近似
    assert res["unpaired_n"] == 2


def test_utility_mixed_paired_and_unpaired_groups():
    # t1 有 x2−x3 合法配对（matched），t2 只有 x1−x3 混库组合 → unpaired_n=1
    con = make_db(traces=[_trace("r1", "t1", ["c1"]), _trace("r2", "t2", ["c1"])])
    rows = [
        _row("t1", day=7, arm="x2", score=0.6),
        _row("t1", day=7, arm="x3", score=0.5),
        _row("t2", day=7, arm="x1", score=0.9),
        _row("t2", day=7, arm="x3", score=0.5),
    ]
    res = ml.utility(con, rows)
    assert res["method"] == "matched"
    assert res["value"] == pytest.approx(0.1)
    assert res["n_pairs"] == 1
    assert res["unpaired_n"] == 1


def test_utility_matched_pairs():
    # t1: exp 0.7 / ctrl 0.5（同日）→ +0.2；t2: exp 0.4 / ctrl 0.6 → −0.2；两任务均命中
    con = make_db(traces=[_trace("r1", "t1", ["c1"]), _trace("r2", "t2", ["c1"])])
    rows = [
        _row("t1", day=1, arm="experiment", score=0.7),
        _row("t1", day=1, arm="control", score=0.5),
        _row("t2", day=1, arm="experiment", score=0.4),
        _row("t2", day=1, arm="control", score=0.6),
    ]
    res = ml.utility(con, rows)
    assert res["method"] == "matched"
    assert res["value"] == pytest.approx(0.0)
    assert res["n_pairs"] == 2


def test_utility_matched_only_hit_tasks():
    # t3 有对照配对但未检索命中 → 不计入
    con = make_db(traces=[_trace("r1", "t1", ["c1"])])
    rows = [
        _row("t1", day=1, arm="experiment", score=0.7),
        _row("t1", day=1, arm="control", score=0.5),
        _row("t3", day=1, arm="experiment", score=0.9),
        _row("t3", day=1, arm="control", score=0.1),
    ]
    res = ml.utility(con, rows)
    assert res["method"] == "matched"
    assert res["value"] == pytest.approx(0.2)
    assert res["n_pairs"] == 1


def test_utility_approximation_without_pairs():
    # 无对照臂 → 命中任务 score 均值近似并标注
    con = make_db(traces=[_trace("r1", "t1", ["c1"]), _trace("r2", "t2", [])])
    rows = [_row("t1", score=0.6), _row("t2", score=0.9)]
    res = ml.utility(con, rows)
    assert res["method"] == "approximation"
    assert res["value"] == pytest.approx(0.6)
    assert res["n_hit_tasks"] == 1


# ── Age ──


def test_age_report():
    con = make_db(
        experiences=[
            _card("c1", {"taskId": "t"}, created_at="2026-08-09T00:00:00Z"),
            _card("c2", {"taskId": "t"}, created_at="2026-08-19T12:00:00Z"),
        ]
    )
    res = ml.age_report(con, today=date(2026, 8, 19))
    assert res["n"] == 2
    assert res["min_days"] == 0
    assert res["max_days"] == 10
    assert res["median_days"] == 5
    by_id = {c["id"]: c for c in res["per_card"]}
    assert by_id["c1"]["age_days"] == 10
    assert by_id["c2"]["age_days"] == 0


def test_age_report_empty():
    res = ml.age_report(make_db(), today=date(2026, 8, 19))
    assert res["n"] == 0
    assert res["min_days"] is None


# ── DuplicateRate ──


def test_duplicate_rate(tmp_path):
    con = make_db(
        experiences=[
            _card("c1", {"taskId": "task_00001_a"}),
            _card("c2", {"taskId": "task_00001_a"}),  # 与 c1 同 source_task → 重复
            _card("c3", {"taskId": "task_00002_b"}),
            _card("c4", {"taskId": "task_00003_c"}, status="dormant"),  # 非 active 不计
            _card("c5", {"procedure": "1) cat x"}),  # 无法解析 source_task
        ]
    )
    res = ml.duplicate_rate(con, session_dirs=[tmp_path])
    assert res["n_active"] == 4
    assert res["n_resolvable"] == 3
    assert res["n_duplicate"] == 2  # c1、c2
    assert res["rate"] == pytest.approx(2 / 3)
    assert res["n_unresolved"] == 1


def test_duplicate_rate_no_duplicates(tmp_path):
    con = make_db(experiences=[_card("c1", {"taskId": "task_00001_a"}), _card("c3", {"taskId": "task_00002_b"})])
    res = ml.duplicate_rate(con, session_dirs=[tmp_path])
    assert res["n_duplicate"] == 0
    assert res["rate"] == 0.0


# ── 整库 wiring（report 汇总） ──


def test_report(tmp_path):
    con = make_db(
        experiences=[
            _card("c1", {"taskId": "task_00001_a"}, created_at="2026-08-09T00:00:00Z"),
            _card("c2", {"taskId": "task_00001_a"}, created_at="2026-08-10T00:00:00Z"),
        ],
        traces=[_trace("r1", "t1", ["c1"])],
    )
    rows = [_row("t1", score=0.7)]
    rep = ml.report(con, rows, session_dirs=[tmp_path], today=date(2026, 8, 19))
    assert rep["reuse_count"]["c1"] == 1
    assert rep["success_after_reuse"]["rate"] == 1.0
    assert rep["utility"]["method"] == "approximation"
    assert rep["age"]["n"] == 2
    assert rep["duplicate_rate"]["rate"] == 1.0
