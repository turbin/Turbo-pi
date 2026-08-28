"""Regression tests for P0 confirm-task denylist."""

from __future__ import annotations

import json
from pathlib import Path

import confirm_tasks


def test_assert_no_confirm_tasks_passes_when_manifest_missing(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(confirm_tasks, "MANIFEST_PATH", tmp_path / "no-manifest.json")
    confirm_tasks.assert_no_confirm_tasks(["task_00001"])


def test_assert_no_confirm_tasks_blocks_listed_ids(monkeypatch, tmp_path: Path) -> None:
    manifest = tmp_path / "confirm-task-manifest.json"
    manifest.write_text(json.dumps({"confirm_task_ids": ["task_00001", "task_00002"]}), encoding="utf-8")
    monkeypatch.setattr(confirm_tasks, "MANIFEST_PATH", manifest)
    confirm_tasks.assert_no_confirm_tasks(["task_00003"])
    try:
        confirm_tasks.assert_no_confirm_tasks(["task_00001"], context="day 1")
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "task_00001" in str(e)
        assert "day 1" in str(e)
