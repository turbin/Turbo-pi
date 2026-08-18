"""T7：交叉评估臂（库版本 × 注入开关 2×2）差分核算与四臂计划。

预注册差分口径（plans/2026-08-14-plan-library-version-cross-eval.md）：
- 库演进效应 = X2 − X1（同注入开，库版本差）
- 即时注入效应 = X1 − X4（同冻结库，注入开关差）
- sanity 臂差 = X3 − X4（学习回路对无注入行为的间接影响，预期 ≈0）
- C 阶段 +10.3pp 对应量 = (X2 − X3) − 漂移修正 = 库演进 + 即时 两部分之和

功效声明（红线 6）：重复集 n=20/日/臂，单任务 = 5pp；配对设计（同任务跨臂
同日差分）消除任务难度方差；小样本不报显著性，差分以均值差呈现，结论以全量
落库为准。

运行：cd packages/agent-server && eval/.venv/bin/python -m pytest eval/tests/test_campaign_cross.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import campaign_cross  # noqa: E402
from campaign_cross import CROSS_ARMS, check_sanity, cross_arm_diffs  # noqa: E402


def make_rows() -> list[dict]:
    """合成四臂行：X2 最高（演进+注入）、X1 次之（注入）、X4 最低（纯基线）、X3 与 X4 持平。"""
    rows = []
    scores = {
        "x1": 0.60, "x2": 0.70, "x3": 0.45, "x4": 0.45,
    }
    for day in (1, 2):
        for task_id in (f"task_{i:05d}" for i in range(20)):
            for arm in CROSS_ARMS:
                rows.append({
                    "day": day, "task_id": task_id, "arm": arm,
                    "kind": "repeat", "score": scores[arm],
                })
    return rows


def test_cross_arms_constant():
    assert CROSS_ARMS == ("x1", "x2", "x3", "x4")


def test_cross_arm_diffs_pre_registered_formulas():
    """差分口径预注册公式：库演进 X2−X1、注入 X1−X4、sanity X3−X4。"""
    rows = make_rows()
    diffs = cross_arm_diffs(rows)
    assert "per_day" in diffs and "overall" in diffs
    o = diffs["overall"]
    assert o["library_evolution"] == pytest.approx(0.70 - 0.60)
    assert o["injection_effect"] == pytest.approx(0.60 - 0.45)
    assert o["sanity_diff"] == pytest.approx(0.45 - 0.45)
    # 每日均值一致（合成数据）。
    for day in (1, 2):
        d = diffs["per_day"][str(day)]
        assert d["library_evolution"] == pytest.approx(0.10)


def test_check_sanity_ok_for_zero_sanity_diff():
    rows = make_rows()
    sanity = check_sanity(rows)
    assert sanity["ok"] is True
    assert sanity["max_abs_day_diff"] == pytest.approx(0.0)


def test_check_sanity_flags_material_deviation():
    """sanity 显著非零（> 容差）必须报出——未建模混淆的哨兵。"""
    rows = make_rows()
    for r in rows:
        if r["arm"] == "x3":
            r["score"] = r["score"] + 0.3  # X3 与 X4 拉开 0.3
    sanity = check_sanity(rows)
    assert sanity["ok"] is False
    assert sanity["max_abs_day_diff"] == pytest.approx(0.3)


def test_diff_requires_all_four_arms():
    rows = [r for r in make_rows() if r["arm"] != "x4"]
    with pytest.raises(ValueError):
        cross_arm_diffs(rows)


def test_four_arm_plan_covers_repeat_set_only(tmp_path):
    """四臂计划：每臂 = 当日重复集（20 任务）；dry-run 不触网。"""
    from campaign_plan import load_tasks

    tasks = load_tasks()
    plan = campaign_cross.four_arm_plan(tasks, day=3)
    assert set(plan.keys()) == {"x1", "x2", "x3", "x4"}
    for arm, task_ids in plan.items():
        assert len(task_ids) == 20
        assert all(t.startswith("task_") for t in task_ids)
    # 四臂任务集一致（同一重复集）。
    assert set(plan["x1"]) == set(plan["x2"]) == set(plan["x3"]) == set(plan["x4"])
