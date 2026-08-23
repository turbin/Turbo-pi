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
from campaign_cross import (  # noqa: E402
    CROSS_ARMS,
    SANITY_TIER1_NOTE,
    SANITY_TIER2_STOP,
    SANITY_TOLERANCE,
    check_sanity,
    cross_arm_diffs,
)


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


def _sanity_boundary_rows(x3_score: float) -> list[dict]:
    """X3 抬到 x3_score、X4 恒 0.0 的边界构造：每臂每日 1 任务，sanity_diff =
    x3_score − 0.0 逐位精确（浮点无噪声），三档边界断言可靠。"""
    rows = []
    for day, tid in ((1, "task_00000"), (2, "task_00001")):
        for arm in CROSS_ARMS:
            score = {"x1": 0.5, "x2": 0.5, "x3": x3_score, "x4": 0.0}[arm]
            rows.append({"day": day, "task_id": tid, "arm": arm, "kind": "repeat", "score": score})
    return rows


def test_sanity_tier_constants_pre_registered():
    """修订① 预注册阈值：Tier-1 note=0.10、Tier-2 stop=0.18（2.5×SEM）；
    SANITY_TOLERANCE=0.05 保留为历史常量（superseded，不参与判定）。"""
    assert SANITY_TIER1_NOTE == 0.10
    assert SANITY_TIER2_STOP == 0.18
    assert SANITY_TOLERANCE == 0.05


def test_check_sanity_tier_ok_at_and_below_note_threshold():
    """|diff| ≤ 0.10 → tier=ok（边界 0.10 含），不停批不注记。"""
    for x3 in (0.0, 0.05, 0.10):
        sanity = check_sanity(_sanity_boundary_rows(x3))
        assert sanity["tier"] == "ok", f"x3={x3} 应 ok"
        assert sanity["ok"] is True
        assert sanity["requires_permutation_check"] is False


def test_check_sanity_tier_note_between_thresholds():
    """0.10 < |diff| ≤ 0.18 → tier=note（工程注记，不停批；边界 0.18 含）。"""
    for x3 in (0.11, 0.15, 0.18):
        sanity = check_sanity(_sanity_boundary_rows(x3))
        assert sanity["tier"] == "note", f"x3={x3} 应 note"
        assert sanity["ok"] is False
        assert sanity["requires_permutation_check"] is False


def test_check_sanity_tier_stop_above_tier2():
    """|diff| > 0.18 → tier=stop 候选：requires_permutation_check=True，置换 p
    条件由报告层人工执行（工程门与统计门分离）。"""
    sanity = check_sanity(_sanity_boundary_rows(0.19))
    assert sanity["tier"] == "stop"
    assert sanity["ok"] is False
    assert sanity["requires_permutation_check"] is True


def test_check_sanity_ok_field_equals_tier_ok():
    """向后兼容：ok 字段语义 = (tier == "ok")，既有消费方（campaign.py --metrics
    report["cross"]["sanity"]["ok"]）行为不变。"""
    for x3 in (0.0, 0.10, 0.11, 0.18, 0.19, 0.5):
        sanity = check_sanity(_sanity_boundary_rows(x3))
        assert sanity["ok"] == (sanity["tier"] == "ok"), f"x3={x3} ok 语义断裂"


def test_sanity_tier_docstring_d2_calibration():
    """docstring 口径必须写明 D2 校准依据：配对 sd≈0.32/SEM≈0.072、
    2.5×SEM≈0.18、日 FPR ~2%（修订① 预注册，防阈值回归失据）。"""
    doc = (campaign_cross.__doc__ or "") + (check_sanity.__doc__ or "")
    for token in ("0.32", "0.072", "0.18", "FPR"):
        assert token in doc, f"docstring 缺校准口径 token: {token}"


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


def _four_arm_rows_with_held_out() -> list[dict]:
    """D7 四臂日真实落库形态：重复 20 任务 × 4 臂 + held-out 8 任务只挂 x2/x3
    （campaign.py --arms 模式：held-out 行 kind=held_out、arm=x2/x3）。"""
    rows = []
    for i in range(20):
        for arm in CROSS_ARMS:
            rows.append({"day": 7, "task_id": f"task_{i:05d}", "kind": "repeat", "arm": arm, "score": 0.8})
    for i in range(8):
        for arm in ("x2", "x3"):
            rows.append({"day": 7, "task_id": f"held_{i:02d}", "kind": "held_out", "arm": arm, "score": 0.2})
    return rows


def test_held_out_rows_do_not_contaminate_cross_diffs():
    """held-out 行不得计入四臂差分均值（preview §7.2：transfer 比较独立于
    cross 2×2 差分口径，x1..x4 均值都应只含重复集）。原为 xfail（pi-test 复核
    确认污染成立），修复 cross_arm_diffs 按 kind 过滤后转绿。"""
    rows = _four_arm_rows_with_held_out()
    diffs = cross_arm_diffs(rows)
    # 无污染期望：四臂均值同 0.8 → 差分全 0。
    assert diffs["overall"]["library_evolution"] == pytest.approx(0.0)
    assert diffs["overall"]["sanity_diff"] == pytest.approx(0.0)
    assert diffs["overall"]["injection_effect"] == pytest.approx(0.0)


def test_cross_arm_diffs_n_counts_filtered_repeat_only():
    """n_per_arm_per_day 按过滤后实际计数（held-out 行不计入），非硬编码 20。"""
    rows = _four_arm_rows_with_held_out()
    diffs = cross_arm_diffs(rows)
    n = diffs["n_per_arm_per_day"]
    assert n["7"]["x1"] == 20 and n["7"]["x4"] == 20
    assert n["7"]["x2"] == 20 and n["7"]["x3"] == 20  # held-out 8 行不计入


def test_transfer_gain_computed_from_held_out_rows():
    """preview §7.2：TransferGain = held_out 任务 x2 均分 − x3 均分（D7 memory
    on/off），独立于 cross 差分；附两臂计数。"""
    rows = _four_arm_rows_with_held_out()
    for r in rows:
        if r["kind"] == "held_out" and r["arm"] == "x2":
            r["score"] = 0.8  # memory on 侧提高
    tg = campaign_cross.transfer_gain(rows)
    assert tg["transfer_gain"] == pytest.approx(0.8 - 0.2)
    assert tg["x2_n"] == 8 and tg["x3_n"] == 8


def test_transfer_gain_none_without_held_out_rows():
    """无 held_out 行（非四臂日/旧结果）→ transfer_gain 为 None，不报错。"""
    assert campaign_cross.transfer_gain(make_rows()) is None
