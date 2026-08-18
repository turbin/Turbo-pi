"""台账 4（T6）：快照留存 + 回滚 runbook 支持。

snapshot_store.py 新模式：`snapshot_store.py <live.db> --snapshots-dir <dir> [--retain N]`
——生成 snapshot-<ts>.db 并保留最新 N 份（N 预注册默认 7）；legacy 双参模式不变。

运行：cd packages/agent-server && eval/.venv/bin/python -m pytest eval/tests/test_snapshot_store.py -q
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from snapshot_store import create_snapshots_dir_snapshot, prune_snapshots, snapshot  # noqa: E402


def make_live_db(path: Path) -> None:
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE t (x TEXT)")
    con.execute("INSERT INTO t VALUES ('v')")
    con.commit()
    con.close()


def test_legacy_two_arg_mode_still_works(tmp_path):
    live = tmp_path / "live.db"
    snap = tmp_path / "snap.db"
    make_live_db(live)
    snapshot(live, snap)
    assert snap.exists()
    con = sqlite3.connect(str(snap))
    assert con.execute("SELECT x FROM t").fetchone()[0] == "v"
    con.close()


def test_snapshots_dir_mode_creates_timestamped_snapshot(tmp_path):
    live = tmp_path / "live.db"
    make_live_db(live)
    snapdir = tmp_path / "snaps"
    path = create_snapshots_dir_snapshot(live, snapdir)
    assert path.exists()
    assert path.name.startswith("snapshot-")
    assert path.suffix == ".db"
    # 内容与 live 一致（SQLite online backup）。
    con = sqlite3.connect(str(path))
    assert con.execute("SELECT x FROM t").fetchone()[0] == "v"
    con.close()


def test_prune_keeps_newest_n(tmp_path):
    snapdir = tmp_path / "snaps"
    snapdir.mkdir()
    # 手工造 5 份快照（不同 mtime 顺序即文件名序）。
    for i in range(5):
        (snapdir / f"snapshot-2026080{i}.db").write_bytes(b"x")
    (snapdir / "unrelated.txt").write_text("keep")
    kept = prune_snapshots(snapdir, retain=2)
    remaining = sorted(p.name for p in snapdir.glob("snapshot-*.db"))
    assert remaining == ["snapshot-20260803.db", "snapshot-20260804.db"]  # 最新 2 份
    assert kept == 3
    assert (snapdir / "unrelated.txt").exists()  # 非快照文件不动


def test_create_then_prune_keeps_default_retain(tmp_path):
    """每日调用模式：连造 9 份 → 只留最新 7 份（N 预注册默认 7）。"""
    live = tmp_path / "live.db"
    make_live_db(live)
    snapdir = tmp_path / "snaps"
    created = None
    for i in range(9):
        created = create_snapshots_dir_snapshot(live, snapdir, ts=f"2026080{i}-000000")
    assert created.exists()
    remaining = sorted(p.name for p in snapdir.glob("snapshot-*.db"))
    assert len(remaining) == 7
    assert remaining[0] == "snapshot-20260802-000000.db"  # 最早两份被剪
    # 全部快照内容仍有效。
    con = sqlite3.connect(str(snapdir / remaining[-1]))
    assert con.execute("SELECT x FROM t").fetchone()[0] == "v"
    con.close()
