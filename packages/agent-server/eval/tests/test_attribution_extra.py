"""T3 归因奖惩补充回归：样本单位语义 / 降权边界 / 证据源跳过路径。

主回归（test_attribution.py，12 例）覆盖核心规则与三证据源。本文件补：
1. **样本单位语义锁（决策 T3-1）**：同任务跨 3 个任务日失败 → 降权且
   distinct_tasks=1——锁定"任务日样本"口径（方案 §3-2 字面"≥3 个不同任务"
   与验收判据冲突的裁决，见 m3-test-review §2a）；审计计数 distinct_tasks
   必须随报告输出；
2. **降权边界**：高置信度起点（0.9）+ 3 失败 → 0.3 封顶（min(c*0.5, 0.3)）；
   成功加分后触发的降权 → 仍收敛到 ≤0.3 标记带；
3. **--store 模式跳过路径**：control 臂（injected_ids=[]）不采样；task_id
   无 run.jsonl 对应行不采样（同任务日只算实验臂样本）；
4. **--sessions-dir 模式 day 回退**：metadata 无 day 时按 session ts 映射日。

运行：cd packages/agent-server && eval/.venv/bin/python -m pytest eval/tests/test_attribution_extra.py -q
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import attribution  # noqa: E402


def write_run_json(path: Path, rows: list[dict]) -> None:
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def make_store(path: Path, cards: list[dict], traces: list[dict]) -> None:
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
             c.get("status", "active"), "", "", f"hash-{c['id']}", c.get("confidence", 0.5)),
        )
    for t in traces:
        db.execute(
            "INSERT INTO request_traces (request_id, ts, model, injected_ids, task_id, hit) VALUES (?,?,?,?,?,?)",
            (t["request_id"], t["ts"], "m", json.dumps(t["injected_ids"]), t["task_id"], 1),
        )
    db.commit()
    db.close()


def make_session(path: Path, task_id: str, ts: str, arm: str, retrieved: list[str], day=None, disabled=False) -> None:
    meta = {"task_id": task_id, "arm": arm}
    if day is not None:
        meta["day"] = day
    lines = [
        {"type": "session", "version": 3, "id": f"{arm}-{task_id}", "timestamp": ts, "metadata": meta},
        {"type": "custom", "customType": "experience_injection",
         "data": {"retrieved": retrieved} | ({"disabled": True} if disabled else {})},
    ]
    path.write_text("\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n", encoding="utf-8")


def test_same_task_three_task_days_demotes_with_distinct_tasks_one(tmp_path):
    """样本单位语义锁（T3-1）：同任务跨 3 日失败 → 降权，distinct_tasks=1。"""
    samples = [
        {"day": d, "task_id": "task_00091_x", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-94dd6dbd90f3fa62"], "source": "issue-010 回放"}
        for d in (3, 4, 5)
    ]
    stats = attribution.compute_attribution(
        [attribution.TaskDaySample(**s) for s in samples], cards_meta={}, confidence={},
    )
    card = stats["exp-94dd6dbd90f3fa62"]
    assert card.injected_task_days == 3
    assert card.distinct_tasks == 1  # 审计计数：口径差异可见
    assert card.failures == 3
    assert card.action == "demote"
    assert card.confidence_after == 0.25


def test_demotion_from_high_confidence_clamps_to_marker_band(tmp_path):
    """降权边界：高置信度起点 + 3 失败 → min(c*0.5, 0.3)=0.3 封顶（标记带）。"""
    samples = [
        {"day": d, "task_id": f"task_h{d}", "arm": "experiment", "score": 0.0,
         "card_ids": ["exp-h"], "source": "test"}
        for d in (1, 2, 3)
    ]
    stats = attribution.compute_attribution(
        [attribution.TaskDaySample(**s) for s in samples], cards_meta={}, confidence={"exp-h": 0.9},
    )
    h = stats["exp-h"]
    assert h.confidence_before == 0.9
    assert h.confidence_after == 0.3  # 0.9*0.5=0.45 → 0.3 封顶
    assert h.action == "demote"


def test_successes_then_demotion_always_converges_to_marker_band(tmp_path):
    """先加分后降权：无论历史成功积累，降权事件恒收敛到 ≤0.3。"""
    samples = [
        {"day": 1, "task_id": "task_s1", "arm": "experiment", "score": 0.9, "card_ids": ["exp-o"], "source": "t"},
        {"day": 2, "task_id": "task_s2", "arm": "experiment", "score": 0.9, "card_ids": ["exp-o"], "source": "t"},
        {"day": 3, "task_id": "task_f1", "arm": "experiment", "score": 0.0, "card_ids": ["exp-o"], "source": "t"},
        {"day": 4, "task_id": "task_f2", "arm": "experiment", "score": 0.0, "card_ids": ["exp-o"], "source": "t"},
        {"day": 5, "task_id": "task_f3", "arm": "experiment", "score": 0.0, "card_ids": ["exp-o"], "source": "t"},
    ]
    o = attribution.compute_attribution(
        [attribution.TaskDaySample(**s) for s in samples], cards_meta={}, confidence={"exp-o": 0.8},
    )["exp-o"]
    assert o.successes == 2
    assert o.confidence_after == 0.3  # (0.8+0.2)*0.5=0.5 → 0.3 封顶


def test_store_mode_skips_control_arm_and_unmatched_task_days(tmp_path):
    """--store：control 臂（injected_ids=[]）与 run.jsonl 无对应行的请求不采样。"""
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": 1, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 2, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 3, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
    ])
    store_path = tmp_path / "exp.db"
    make_store(store_path, [{"id": "exp-91", "type": "ABILITY", "title": "audit"}], traces=[
        # 实验臂：3 个任务日（08-09/10/11 → day1/2/3）。
        {"request_id": "r1", "ts": "2026-08-09T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
        {"request_id": "r2", "ts": "2026-08-10T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
        {"request_id": "r3", "ts": "2026-08-11T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
        # control 臂：injected_ids=[]（注入关闭）→ 不采样。
        {"request_id": "rc", "ts": "2026-08-09T02:00:00Z", "injected_ids": [], "task_id": "task_91"},
        # 有注入但 run.jsonl 无对应行（非 campaign 请求 / 日期越界）→ 不采样。
        {"request_id": "rx", "ts": "2026-08-12T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_91"},
        {"request_id": "ry", "ts": "2026-08-09T01:00:00Z", "injected_ids": ["exp-91"], "task_id": "task_other"},
    ])
    samples = attribution.build_samples_from_traces(store_path, run_path, campaign_start_date="2026-08-09")
    assert len(samples) == 3
    stats = attribution.compute_attribution(samples, cards_meta={}, confidence={})
    assert stats["exp-91"].injected_task_days == 3
    assert stats["exp-91"].failures == 3


def test_sessions_mode_falls_back_to_ts_based_day(tmp_path):
    """--sessions-dir：metadata 无 day 时按 session ts 映射 campaign 日。"""
    run_path = tmp_path / "run.jsonl"
    write_run_json(run_path, [
        {"day": 1, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 2, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
        {"day": 3, "task_id": "task_91", "arm": "experiment", "score": 0.0, "kind": "repeat"},
    ])
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    # 无 day 元数据：day 由 ts 推导（08-09 → day1）。
    make_session(sdir / "s1.jsonl", "task_91", "2026-08-09T01:00:00Z", "experiment", ["exp-91"])
    make_session(sdir / "s2.jsonl", "task_91", "2026-08-10T02:00:00Z", "experiment", ["exp-91"])
    make_session(sdir / "s3.jsonl", "task_91", "2026-08-11T03:00:00Z", "experiment", ["exp-91"])
    samples = attribution.build_samples_from_sessions(sdir, run_path, campaign_start_date="2026-08-09")
    assert {s.day for s in samples} == {1, 2, 3}
