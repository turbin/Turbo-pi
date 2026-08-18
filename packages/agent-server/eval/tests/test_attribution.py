"""F2 归因奖惩（T3）回归测试：卡×结果关联表 + confidence 奖惩规则。

覆盖点（plans §3 F2，dev-tasks T3）：
1. 合成序列「卡 A 注入后 ≥3 个不同任务日连续失败 → 降权（confidence 降 + 待降级标记）」
2. 「卡 B 连续成功 → 加分（封顶 1.0）」
3. 「<3 失败样本不动」
4. 多卡共注入样本仅记数不动作（credit assignment 首版不做）
5. 样本单位 = 任务日（(day, task_id)）；同任务日多请求只算一个样本
6. --apply 写 confidence 列；--demote 人工确认通道（active→dormant + 复升排除标记）
7. 三种证据源：--store（post-F0 request_traces）/ --sessions-dir（experience_injection
   条目近似）/ --injections（显式清单，C 回放用）

运行：cd packages/agent-server && eval/.venv/bin/python -m pytest eval/tests/test_attribution.py -q
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import attribution  # noqa: E402


# ---------------------------------------------------------------------------
# 工具：构造 run.jsonl / store / session 文件
# ---------------------------------------------------------------------------

def write_run_json(path: Path, rows: list[dict]) -> None:
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def make_store(path: Path, cards: list[dict], traces: list[dict] | None = None) -> None:
    """构造 post-F0 store：experiences（含 confidence 列）+ request_traces（含 injected_ids/task_id）。"""
    db = sqlite3.connect(str(path))
    db.executescript("""
        CREATE TABLE experiences (
            id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
            payload TEXT NOT NULL, quality REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active', branch_path TEXT,
            times_selected INTEGER NOT NULL DEFAULT 0,
            source_session TEXT NOT NULL, source_entry_id TEXT NOT NULL,
            content_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            confidence REAL NOT NULL DEFAULT 0.5,
            rescore_excluded_batches INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE request_traces (
            request_id TEXT PRIMARY KEY, ts TEXT NOT NULL, model TEXT NOT NULL,
            stream INTEGER NOT NULL DEFAULT 0, retrieved_count INTEGER NOT NULL DEFAULT 0,
            retrieved_ids TEXT NOT NULL DEFAULT '[]', retrieved_kinds TEXT NOT NULL DEFAULT '[]',
            hit INTEGER NOT NULL DEFAULT 0, injected_ids TEXT NOT NULL DEFAULT '[]',
            task_id TEXT, finish_reason TEXT, prompt_tokens INTEGER,
            completion_tokens INTEGER, latency_ms INTEGER, error TEXT
        );
    """)
    for c in cards:
        db.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, status, source_session,"
            " source_entry_id, content_hash, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (c["id"], c["type"], c["title"], json.dumps(c.get("payload", {})), c.get("quality", 0.8),
             c.get("status", "active"), c.get("source_session", ""), c.get("source_entry_id", ""),
             c.get("content_hash", f"hash-{c['id']}"), c.get("confidence", 0.5)),
        )
    for t in traces or []:
        db.execute(
            "INSERT INTO request_traces (request_id, ts, model, injected_ids, task_id, hit) VALUES (?,?,?,?,?,?)",
            (t["request_id"], t["ts"], "m", json.dumps(t["injected_ids"]), t["task_id"], 1),
        )
    db.commit()
    db.close()


def make_session(path: Path, task_id: str, day: int, arm: str, ts: str, retrieved: list[str], disabled=False) -> None:
    lines = [
        {"type": "session", "version": 3, "id": f"{arm}-{task_id}-{day}",
         "timestamp": ts, "metadata": {"task_id": task_id, "arm": arm, "day": day}},
        {"type": "custom", "customType": "experience_injection",
         "data": {"retrieved": retrieved} | ({"disabled": True} if disabled else {})},
    ]
    path.write_text("\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# 规则：奖惩（合成序列）
# ---------------------------------------------------------------------------

def _run_rules(samples: list[dict], conf: dict[str, float] | None = None):
    """便捷入口：manifest 样本 + 默认 confidence 0.5 → stats dict。"""
    cards = attribution.compute_attribution(
        [attribution.TaskDaySample(**s) for s in samples],
        cards_meta={}, confidence=conf or {},
    )
    return cards


def test_card_a_fails_on_three_task_days_is_demoted():
    """卡 A：≥3 个不同任务日失败 → 降权（confidence 0.5→0.25）+ 待降级标记。"""
    samples = [
        {"day": d, "task_id": f"task_0000{d}", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-a"], "source": "test"}
        for d in range(1, 4)
    ]
    stats = _run_rules(samples)
    a = stats["exp-a"]
    assert a.failures == 3
    assert a.successes == 0
    assert a.action == "demote"
    assert a.demote_candidate is True
    assert a.confidence_before == 0.5
    assert a.confidence_after == 0.25  # min(0.5*0.5, 0.3)


def test_card_b_successes_raise_confidence_capped():
    """卡 B：连续成功 → 加分，封顶 1.0。"""
    samples = [
        {"day": d, "task_id": f"task_b{d}", "arm": "experiment", "score": 0.9,
         "card_ids": ["exp-b"], "source": "test"}
        for d in range(1, 5)
    ]
    b = _run_rules(samples)["exp-b"]
    assert b.successes == 4
    assert b.action == "reward"
    assert b.confidence_after == 0.9  # 0.5 + 4*0.1

    # 6 个成功 → 封顶 1.0
    more = [{"day": d, "task_id": f"task_c{d}", "arm": "experiment", "score": 0.8,
             "card_ids": ["exp-c"], "source": "test"} for d in range(1, 7)]
    c = _run_rules(more)["exp-c"]
    assert c.confidence_after == 1.0


def test_less_than_three_failures_no_action():
    """<3 失败样本 → 不动（阈值预注册 DEMOTION_MIN_FAILURES=3）。"""
    samples = [
        {"day": 1, "task_id": "task_x", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-x"], "source": "test"},
        {"day": 2, "task_id": "task_y", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-x"], "source": "test"},
    ]
    x = _run_rules(samples)["exp-x"]
    assert x.failures == 2
    assert x.action == "none"
    assert x.confidence_after == 0.5
    assert x.demote_candidate is False


def test_same_task_day_multiple_requests_is_one_sample():
    """样本单位 = 任务日：同 (day, task_id) 的多次注入只算一个样本（共享 judge 分数）。"""
    samples = [
        {"day": 1, "task_id": "task_s", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-s"], "source": "test"},
        {"day": 1, "task_id": "task_s", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-s"], "source": "test"},
        {"day": 1, "task_id": "task_s", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-s"], "source": "test"},
        {"day": 2, "task_id": "task_s", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-s"], "source": "test"},
    ]
    s = _run_rules(samples)["exp-s"]
    assert s.injected_task_days == 2  # day1 的 3 条请求合并为 1 个样本
    assert s.failures == 2


def test_multi_card_injection_counted_but_no_action():
    """多卡共注入：仅记数（multi_injection_samples），不驱动奖惩。"""
    samples = [
        {"day": 1, "task_id": "task_m", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-a", "exp-b"], "source": "test"},
        {"day": 2, "task_id": "task_m2", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-a", "exp-b"], "source": "test"},
    ]
    stats = _run_rules(samples)
    for cid in ("exp-a", "exp-b"):
        s = stats[cid]
        assert s.multi_injection_samples == 2
        assert s.failures == 0
        assert s.action == "none"
        assert s.confidence_after == 0.5


def test_reward_then_demotion_clamp_order():
    """先加分后封顶：成功加分后触发降权事件 → 按降权公式收敛（min(c*0.5, 0.3)）。"""
    samples = [
        {"day": 1, "task_id": "task_o", "arm": "experiment", "score": 0.9,
         "card_ids": ["exp-o"], "source": "test"},
        {"day": 2, "task_id": "task_p", "arm": "experiment", "score": 0.9,
         "card_ids": ["exp-o"], "source": "test"},
        {"day": 3, "task_id": "task_q", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-o"], "source": "test"},
        {"day": 4, "task_id": "task_r", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-o"], "source": "test"},
        {"day": 5, "task_id": "task_s2", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-o"], "source": "test"},
    ]
    o = _run_rules(samples)["exp-o"]
    assert o.successes == 2 and o.failures == 3
    assert o.confidence_after == 0.3  # (0.5+0.2)*0.5=0.35 → 0.3 封顶（实战降权标记阈值）


# ---------------------------------------------------------------------------
# 证据源：--store / --sessions-dir / --injections
# ---------------------------------------------------------------------------

def test_store_mode_joins_request_traces_with_run_json(tmp_path):
    """--store：request_traces（injected_ids × task_id × ts）join run.jsonl 分数。"""
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": 1, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 2, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 3, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 4, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
    ])
    store_path = tmp_path / "exp.db"
    make_store(store_path, [{"id": "exp-91", "type": "ABILITY", "title": "audit card"}],
               traces=[
                   {"request_id": "r1", "ts": "2026-08-10T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
                   {"request_id": "r2", "ts": "2026-08-10T02:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
                   {"request_id": "r3", "ts": "2026-08-11T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
                   {"request_id": "r4", "ts": "2026-08-12T01:00:00Z", "injected_ids": ["exp-91", "exp-other"], "task_id": "task_91"},
               ])
    samples = attribution.build_samples_from_traces(store_path, run_path, campaign_start_date="2026-08-09")
    # day2(08-10) 两条请求合并为一个样本；day3(08-11) 一个；day4(08-12) 多卡样本。
    day_samples = {(s.day, tuple(s.card_ids)): s for s in samples}
    assert (2, ("exp-91",)) in day_samples
    assert (3, ("exp-91",)) in day_samples
    assert (4, ("exp-91", "exp-other")) in day_samples
    stats = attribution.compute_attribution(samples, cards_meta={}, confidence={})
    assert stats["exp-91"].failures == 2  # day2+day3 单卡失败样本
    assert stats["exp-91"].multi_injection_samples == 1


def test_sessions_mode_reads_experience_injection_entries(tmp_path):
    """--sessions-dir：experience_injection 条目近似（实验臂），control 臂 disabled 排除。"""
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": 1, "task_id": "task_s1", "arm": "experiment", "score": 0.7, "kind": "repeat"},
        {"day": 2, "task_id": "task_s1", "arm": "experiment", "score": 0.7, "kind": "repeat"},
        {"day": 1, "task_id": "task_s1", "arm": "control", "score": 0.7, "kind": "repeat"},
    ])
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    make_session(sdir / "exp-a.jsonl", "task_s1", 1, "experiment", "2026-08-10T01:00:00Z", ["exp-1", "exp-2"])
    make_session(sdir / "exp-b.jsonl", "task_s1", 2, "experiment", "2026-08-11T02:00:00Z", ["exp-1"])
    make_session(sdir / "ctl.jsonl", "task_s1", 1, "control", "2026-08-10T03:00:00Z", ["exp-1"], disabled=True)

    samples = attribution.build_samples_from_sessions(sdir, run_path, campaign_start_date="2026-08-09")
    # day1 = 多卡样本（exp-1+exp-2）；day2 = exp-1 单卡成功样本；control 臂 disabled 排除。
    stats = attribution.compute_attribution(samples, cards_meta={}, confidence={})
    assert stats["exp-1"].injected_task_days == 2
    assert stats["exp-1"].successes == 1
    assert stats["exp-1"].multi_injection_samples == 1
    assert stats["exp-2"].successes == 0  # 只在多卡样本中：记数不动作
    assert stats["exp-2"].multi_injection_samples == 1


def test_manifest_mode_replays_documented_injections(tmp_path):
    """--injections：显式清单（C 回放用）；缺失 run.jsonl 行的样本跳过并计数。"""
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": 3, "task_id": "task_00091_x", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 4, "task_id": "task_00091_x", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 5, "task_id": "task_00091_x", "arm": "experiment", "score": 0.0, "kind": "repeat"},
    ])
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text("\n".join(
        json.dumps({"day": d, "task_id": "task_00091_x", "arm": "experiment",
                    "card_ids": ["exp-94dd6dbd90f3fa62"], "evidence": "issue-010 注入审查"})
        for d in (3, 4, 5)
    ) + "\n")
    samples, skipped = attribution.build_samples_from_manifest(manifest, run_path)
    assert skipped == 0
    stats = attribution.compute_attribution(samples, cards_meta={}, confidence={})
    card = stats["exp-94dd6dbd90f3fa62"]
    assert card.failures == 3
    assert card.action == "demote"
    assert card.demote_candidate is True


# ---------------------------------------------------------------------------
# 落地：--apply（写 confidence）/ --demote（人工确认降级通道）
# ---------------------------------------------------------------------------

def test_apply_writes_confidence_to_store(tmp_path):
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": d, "task_id": f"task_f{d}", "arm": "experiment", "score": 0.0, "kind": "repeat"}
        for d in (1, 2, 3)
    ])
    store_path = tmp_path / "exp.db"
    make_store(store_path, [{"id": "exp-a", "type": "ABILITY", "title": "a"}],
               traces=[{"request_id": f"r{d}", "ts": f"2026-08-{d + 8:02d}T01:00:00Z",
                        "injected_ids": ["exp-a"], "task_id": f"task_f{d}"} for d in (1, 2, 3)])
    report = tmp_path / "report.json"
    attribution.run_attribution_cli(
        run_json=str(run_path), store=str(store_path), report=str(report),
        campaign_start_date="2026-08-09", apply=True,
    )
    db = sqlite3.connect(str(store_path))
    conf = db.execute("SELECT confidence FROM experiences WHERE id='exp-a'").fetchone()[0]
    db.close()
    assert conf == 0.25
    rep = json.loads(open(report).read())
    assert rep["cards"]["exp-a"]["action"] == "demote"
    assert rep["demote_candidates"] == ["exp-a"]


def test_demote_command_sets_dormant_and_rescore_exclusion(tmp_path):
    """--demote：人工确认通道——active→dormant + rescore_excluded_batches=RESCORE_EXCLUDE_BATCHES。"""
    store_path = tmp_path / "exp.db"
    make_store(store_path, [{"id": "exp-a", "type": "ABILITY", "title": "a", "status": "active"}])
    n = attribution.demote_cards(store_path, ["exp-a"])
    assert n == 1
    db = sqlite3.connect(str(store_path))
    row = db.execute("SELECT status, rescore_excluded_batches FROM experiences WHERE id='exp-a'").fetchone()
    db.close()
    assert row[0] == "dormant"
    assert row[1] == attribution.RESCORE_EXCLUDE_BATCHES


def test_demote_ignores_unknown_ids(tmp_path):
    store_path = tmp_path / "exp.db"
    make_store(store_path, [{"id": "exp-a", "type": "ABILITY", "title": "a"}])
    assert attribution.demote_cards(store_path, ["exp-a", "exp-ghost"]) == 1
    db = sqlite3.connect(str(store_path))
    rows = db.execute("SELECT id, status FROM experiences").fetchall()
    db.close()
    assert dict(rows) == {"exp-a": "dormant"}
