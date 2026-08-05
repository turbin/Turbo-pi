#!/usr/bin/env python3
"""C 阶段办公自动化 campaign — 任务计划（纯函数，无副作用）。

任务源：QwenClawBench v1.1（100 任务，eval/qcb/tasks-v1.1/tasks/*.md）。
划分（seed 固定，分层抽样）：
  - 重复集 REPEAT_N=20：每日都跑，测"可靠记忆"（判据①：D7 升级率 ≤5%）
  - 新任务集 80：按天切片，每日引入一批，测"新任务泛化"（判据②：升级率 <20%）

判据与流程预注册：doc/design/2026-08-05-agent-server-c-campaign-design.md
"""

import random
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

EVAL_DIR = Path(__file__).resolve().parent
TASKS_DIR = EVAL_DIR / "qcb" / "tasks-v1.1" / "tasks"

REPEAT_N = 20
DAYS = 7
SEED = 42
# task_00005 依赖飞书（E 立项时排除），campaign 同样排除。
EXCLUDED = {"task_00005_daily_briefing_scheduler_skill_creation_and_recovery"}


@dataclass
class TaskMeta:
    id: str
    category: str
    grading_type: str
    timeout_seconds: int


def load_tasks(tasks_dir: Path = TASKS_DIR) -> list[TaskMeta]:
    """Parse YAML frontmatter from every task_*.md (body ignored at plan time)."""
    tasks: list[TaskMeta] = []
    for path in sorted(tasks_dir.glob("task_*.md")):
        text = path.read_text()
        match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
        if not match:
            raise ValueError(f"no frontmatter: {path.name}")
        fm = yaml.safe_load(match.group(1))
        if fm["id"] in EXCLUDED:
            continue
        tasks.append(
            TaskMeta(
                id=fm["id"],
                category=fm.get("category", "unknown"),
                grading_type=fm.get("grading_type", "hybrid"),
                timeout_seconds=int(fm.get("timeout_seconds", 1800)),
            )
        )
    return tasks


def split_tasks(tasks: list[TaskMeta], seed: int = SEED, repeat_n: int = REPEAT_N) -> tuple[list[str], list[str]]:
    """Stratified split: repeat set samples every category proportionally."""
    rng = random.Random(seed)
    by_cat: dict[str, list[str]] = {}
    for t in tasks:
        by_cat.setdefault(t.category, []).append(t.id)
    repeat: list[str] = []
    for cat in sorted(by_cat):
        ids = sorted(by_cat[cat])
        rng.shuffle(ids)
        take = max(1, round(repeat_n * len(ids) / len(tasks)))
        repeat.extend(ids[:take])
    # Adjust to exactly repeat_n (deterministic: drop/add from the largest category).
    while len(repeat) > repeat_n:
        repeat.pop()
    pool = [t.id for t in tasks if t.id not in set(repeat)]
    while len(repeat) < repeat_n and pool:
        repeat.append(pool.pop(0))
    new = sorted(t.id for t in tasks if t.id not in set(repeat))
    return sorted(repeat), new


def daily_batch(tasks: list[TaskMeta], day: int) -> dict:
    """Day d (1-based): full repeat set + the d-th slice of the new-task set."""
    if not 1 <= day <= DAYS:
        raise ValueError(f"day must be 1..{DAYS}")
    repeat, new = split_tasks(tasks)
    slices = [new[i::DAYS] for i in range(DAYS)]
    return {"day": day, "repeat": repeat, "new": sorted(slices[day - 1])}
