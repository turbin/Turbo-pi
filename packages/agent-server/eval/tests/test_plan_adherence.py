"""plan_adherence.py 测试（T7，评审 §三：9B 是否遵循 Teacher Plan）。

预注册口径（见 plan_adherence.py docstring）：
  PlanAdoptionRate = 注入 Method/Guard 卡的任务（注入开启臂行）中，transcript
     任一 toolCall 覆盖 ≥1 个卡片关键动作 token 的任务占比
  PlanDeviationRate = 触顶∧失败任务中，与全部注入卡动作 token 零重叠的
     toolCall 占比（启发式，注明误报面）
  触顶 = termination_reason=="max_turns"；旧行 fallback requests>=30
  动作 token = bash 命令动词（词边界）+ 文件路径（子串）+ 工具名（词边界）
"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import plan_adherence as pa  # noqa: E402

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
    """内存 sqlite fixture（DDL 与 experience-store.ts 一致）。"""
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


def _ability(card_id, role, procedure="", boundary=""):
    payload = {"role": role, "procedure": procedure, "boundary": boundary, "taskId": "task_t"}
    return (card_id, "ABILITY", role, json.dumps(payload), 0.8, 0.5, "active", "s.jsonl", "e1", "h1", "2026-08-19T00:00:00Z")


def _trace(rid, injected, task_id, retrieved="[]"):
    return (rid, "2026-08-19T00:00:00Z", "m", retrieved, 1, json.dumps(injected), task_id)


# ── transcript helpers（QCB OpenClaw 事件形态，同 campaign.py 落盘） ──


def _assistant(*parts):
    return {"type": "message", "message": {"role": "assistant", "content": list(parts)}}


def _tool_call(command):
    return {"type": "toolCall", "name": "bash", "arguments": {"command": command}}


def _row(task_id, day=1, arm="experiment", score=0.5, term=None, requests=5):
    r = {"day": day, "task_id": task_id, "arm": arm, "score": score, "requests": requests}
    if term is not None:
        r["termination_reason"] = term
    return r


def _transcript(task_id, *commands):
    events = []
    for cmd in commands:
        events.append(_assistant(_tool_call(cmd)))
        events.append({"type": "message", "message": {"role": "toolResult", "content": ["ok"]}})
    return {"task_id": task_id, "arm": "experiment", "day": 1, "prompt": "p", "transcript": events, "score": 0.5}


# ── token 提取与覆盖 ──


def test_extract_action_tokens_verbs_paths():
    tokens = pa.extract_action_tokens("1) cat config/app.json 2) python3 main.py 3) then run bash")
    assert "cat" in tokens["words"]
    assert "python3" in tokens["words"]
    assert "bash" in tokens["words"]
    assert "config/app.json" in tokens["paths"]
    assert "main.py" in tokens["paths"]


def test_extract_action_tokens_filters_stopwords_and_short():
    tokens = pa.extract_action_tokens("the and for cat")
    assert "the" not in tokens["words"]
    assert "and" not in tokens["words"]
    assert "cat" in tokens["words"]


def test_token_covered_word_boundary_vs_path_substring():
    assert pa.token_covered("cat", "cat config.json", is_path=False)
    assert not pa.token_covered("cat", "concatenate files", is_path=False)  # "cat" 非独立词
    assert pa.token_covered("config.json", "ls config.json && rm config.json.bak", is_path=True)


# ── PlanAdoptionRate ──


def test_plan_adoption_rate_half():
    con = make_db(
        experiences=[
            _ability("c1", "Method", procedure="1) cat config/app.json 2) python3 verify.py"),
            _ability("c2", "Guard", boundary="never run python3 outside workspace"),
        ],
        traces=[
            _trace("r1", ["c1"], "t1"),
            _trace("r2", ["c2"], "t2"),
        ],
    )
    cards_by_task = pa.injected_method_guard_cards(con, {"t1", "t2"})
    rows = [_row("t1"), _row("t2")]
    transcripts = {"t1": _transcript("t1", "cat config/app.json"), "t2": _transcript("t2", "ls unrelated/")}
    res = pa.plan_adoption_rate(rows, transcripts, cards_by_task)
    assert res["denominator"] == 2
    assert res["adopted_n"] == 1
    assert res["rate"] == 0.5
    # 明细逐任务
    by_task = {d["task_id"]: d for d in res["detail"]}
    assert by_task["t1"]["adopted"] is True
    assert by_task["t2"]["adopted"] is False


def test_plan_adoption_transcript_missing_excluded_from_denominator():
    # 缺 transcript 的任务不计入分母（detail 注记 adopted=None）——
    # 观察项：transcript 数据缺失会静默抬高 adoption 率（分母只含可判任务）。
    con = make_db(
        experiences=[_ability("c1", "Method", procedure="1) cat app.json")],
        traces=[_trace("r1", ["c1"], "t1"), _trace("r2", ["c1"], "t2")],
    )
    cards_by_task = pa.injected_method_guard_cards(con, {"t1", "t2"})
    rows = [_row("t1"), _row("t2")]
    transcripts = {"t1": _transcript("t1", "cat app.json")}  # t2 的 transcript 缺失
    res = pa.plan_adoption_rate(rows, transcripts, cards_by_task)
    assert res["denominator"] == 1
    assert res["rate"] == 1.0
    assert res["detail"][1]["task_id"] == "t2"
    assert res["detail"][1]["adopted"] is None


def test_plan_adoption_rate_only_injection_on_arms():
    con = make_db(experiences=[_ability("c1", "Method", procedure="1) cat app.json")], traces=[_trace("r1", ["c1"], "t1")])
    cards_by_task = pa.injected_method_guard_cards(con, {"t1"})
    # 同一任务 control 臂（注入关）行不计入分母
    rows = [_row("t1", arm="control")]
    transcripts = {"t1": _transcript("t1", "cat app.json")}
    res = pa.plan_adoption_rate(rows, transcripts, cards_by_task)
    assert res["denominator"] == 0
    assert res["rate"] == 0.0


def test_plan_adoption_rate_no_cards_empty():
    con = make_db(experiences=[], traces=[])
    cards_by_task = pa.injected_method_guard_cards(con, {"t1"})
    rows = [_row("t1")]
    res = pa.plan_adoption_rate(rows, {}, cards_by_task)
    assert res["denominator"] == 0
    assert res["rate"] == 0.0


# ── PlanDeviationRate ──


def test_plan_deviation_rate():
    con = make_db(
        experiences=[_ability("c1", "Method", procedure="1) cat app.json 2) python3 verify.py")],
        traces=[_trace("r1", ["c1"], "t1")],
    )
    cards_by_task = pa.injected_method_guard_cards(con, {"t1"})
    # 触顶∧失败任务 t1：4 个 toolCall，1 个覆盖 cat（app.json 无关），3 个零重叠
    rows = [_row("t1", score=0.2, term="max_turns")]
    transcripts = {"t1": _transcript("t1", "cat app.json", "ls unrelated", "rm -rf tmp", "grep x file.log")}
    res = pa.plan_deviation_rate(rows, transcripts, cards_by_task)
    assert res["toolcalls_n"] == 4
    assert res["deviating_n"] == 3
    assert res["rate"] == pytest.approx(0.75)


def test_plan_deviation_rate_non_capped_excluded():
    con = make_db(experiences=[_ability("c1", "Method", procedure="1) cat app.json")], traces=[_trace("r1", ["c1"], "t1")])
    cards_by_task = pa.injected_method_guard_cards(con, {"t1"})
    # 失败但未触顶 → 不参与
    rows = [_row("t1", score=0.2, term="completed")]
    res = pa.plan_deviation_rate(rows, {}, cards_by_task)
    assert res["toolcalls_n"] == 0
    assert res["rate"] == 0.0


def test_plan_deviation_rate_old_rows_fallback():
    con = make_db(experiences=[_ability("c1", "Method", procedure="1) cat app.json")], traces=[_trace("r1", ["c1"], "t1")])
    cards_by_task = pa.injected_method_guard_cards(con, {"t1"})
    # 旧行无 termination_reason，requests>=30 视为触顶（与 trajectory_metrics 同口径）
    rows = [_row("t1", score=0.1, requests=30)]
    transcripts = {"t1": _transcript("t1", "ls unrelated")}
    res = pa.plan_deviation_rate(rows, transcripts, cards_by_task)
    assert res["toolcalls_n"] == 1
    assert res["deviating_n"] == 1


# ── 整库 wiring（report 按日分组） ──


def test_report_by_day_and_empty_db(tmp_path):
    db_file = tmp_path / "experience.db"
    con = sqlite3.connect(str(db_file))
    con.executescript(SCHEMA)
    for row in [_ability("c1", "Method", procedure="1) cat app.json"), _trace("r1", ["c1"], "t1")]:
        if row[1] == "ABILITY":
            con.execute(
                "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
                " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                row,
            )
        else:
            con.execute(
                "INSERT INTO request_traces (request_id, ts, model, retrieved_ids, hit, injected_ids, task_id)"
                " VALUES (?,?,?,?,?,?,?)",
                row,
            )
    con.commit()
    con.close()
    run_dir = tmp_path / "campaign-x"
    (run_dir / "transcripts" / "day1").mkdir(parents=True)
    (run_dir / "transcripts" / "day1" / "experiment-t1.json").write_text(json.dumps(_transcript("t1", "cat app.json")))
    (run_dir / "run.jsonl").write_text(json.dumps(_row("t1", day=1)) + "\n")
    rep = pa.report(run_dir, db_file)
    assert rep["by_day"]["1"]["plan_adoption_rate"] == 1.0
    # 空库：无卡 → 分母 0，rate 0.0，不炸
    empty_file = tmp_path / "empty.db"
    con2 = sqlite3.connect(str(empty_file))
    con2.executescript(SCHEMA)
    con2.commit()
    con2.close()
    rep2 = pa.report(run_dir, empty_file)
    assert rep2["by_day"]["1"]["plan_adoption_rate"] == 0.0
    assert rep2["by_day"]["1"]["plan_adoption_denominator"] == 0
