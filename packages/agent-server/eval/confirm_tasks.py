#!/usr/bin/env python3
"""Strict confirm-set (never-executed tasks) manifest loader and denylist.

E4 will be the only runner allowed to touch the 20 tasks listed in
`confirm-task-manifest.json`; every other runner (E0-E3, pilot, audit) must
refuse to start if any of those IDs appears in its batch.
"""

from __future__ import annotations

import json
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = EVAL_DIR / "confirm-task-manifest.json"


def _load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        return {"confirm_task_ids": [], "confirm_tasks": []}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def confirm_task_ids() -> set[str]:
    """Return the frozen set of E4 confirm-task IDs."""
    return set(_load_manifest().get("confirm_task_ids", []))


def assert_no_confirm_tasks(task_ids: list[str], *, context: str = "") -> None:
    """Raise RuntimeError if any task ID is in the E4 confirm set.

    The denylist is enforced at runner startup, before any workspace is created
    or any model call is made.
    """
    denied = confirm_task_ids()
    if not denied:
        return
    hits = [tid for tid in task_ids if tid in denied]
    if not hits:
        return
    ctx = f" ({context})" if context else ""
    raise RuntimeError(
        f"E4 confirm-set tasks are denylisted until E4{ctx}: {', '.join(hits)}"
    )
