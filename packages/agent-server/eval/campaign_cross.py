"""T7：交叉评估臂（库版本 × 注入开关 2×2）——四臂计划与差分核算。

预注册差分口径（plans/2026-08-14-plan-library-version-cross-eval.md）：
- 臂定义：
    X1 = 冻结 D1 快照库 + 注入开（固定库的即时注入效应，无演进混淆）
    X2 = 当日库 + 注入开（演进+即时混合 = 原实验臂口径）
    X3 = 当日库 + 注入关（无注入对照 = 原对照臂口径，抗漂移参照）
    X4 = 冻结 D1 快照库 + 注入关（纯 9B 重复测量基线，漂移地板）
- 差分（样本单位 = 任务日，配对设计：同任务跨臂同日差分消除任务难度方差）：
    库演进效应   = mean(X2) − mean(X1)   （同注入开，库版本差）
    即时注入效应 = mean(X1) − mean(X4)   （同冻结库，注入开关差）
    sanity 臂差  = mean(X3) − mean(X4)   （学习回路对无注入行为的间接影响，
                                          预期 ≈0；显著非零 = 未建模混淆）
    C 阶段 +10.3pp 对应量 = (X2 − X3) − 漂移修正 = 库演进 + 即时 两部分之和

功效声明（红线 6）：重复集 n=20 任务/日/臂，单任务 = 5pp；配对设计消除任务
难度方差；小样本不报显著性（不附 CI/检验），差分以均值差呈现，结论以全量
落库为准不外推。sanity 容差 SANITY_TOLERANCE 预注册 = 0.05（超过即报非零）。

落库形态：campaign.py --arms x1,x2,x3,x4 模式每行 {day, task_id, arm: xN,
kind: repeat, score, library: frozen|daily, ...}；本模块纯函数核算。
"""

from __future__ import annotations

from collections import defaultdict

from campaign_plan import split_tasks

CROSS_ARMS = ("x1", "x2", "x3", "x4")

ARM_LIBRARY = {
    "x1": "frozen",
    "x2": "daily",
    "x3": "daily",
    "x4": "frozen",
}

ARM_INJECTION = {
    "x1": True,
    "x2": True,
    "x3": False,
    "x4": False,
}

# sanity 臂差容差（预注册）：|X3 − X4| 超过此值即报非零（未建模混淆哨兵）。
SANITY_TOLERANCE = 0.05


def four_arm_plan(tasks: list, day: int) -> dict[str, list[str]]:
    """四臂计划：每臂 = 当日重复集（20 任务，同一任务集）。"""
    repeat, _new = split_tasks(tasks)
    return {arm: sorted(repeat) for arm in CROSS_ARMS}


def _mean(scores: list[float]) -> float:
    return sum(scores) / len(scores) if scores else 0.0


def cross_arm_diffs(rows: list[dict]) -> dict:
    """四臂差分核算（纯函数）。行需含 day/task_id/arm/score，四臂齐全。"""
    arms_present = {r["arm"] for r in rows}
    missing = set(CROSS_ARMS) - arms_present
    if missing:
        raise ValueError(f"cross-arm diffs require all four arms; missing: {sorted(missing)}")
    days = sorted({int(r["day"]) for r in rows})

    per_day: dict[str, dict] = {}
    for day in days:
        day_rows = [r for r in rows if int(r["day"]) == day]
        means = {arm: _mean([r["score"] for r in day_rows if r["arm"] == arm]) for arm in CROSS_ARMS}
        per_day[str(day)] = {
            **means,
            "library_evolution": means["x2"] - means["x1"],
            "injection_effect": means["x1"] - means["x4"],
            "sanity_diff": means["x3"] - means["x4"],
        }

    overall_means = {arm: _mean([r["score"] for r in rows if r["arm"] == arm]) for arm in CROSS_ARMS}
    overall = {
        **overall_means,
        "library_evolution": overall_means["x2"] - overall_means["x1"],
        "injection_effect": overall_means["x1"] - overall_means["x4"],
        "sanity_diff": overall_means["x3"] - overall_means["x4"],
    }
    return {"per_day": per_day, "overall": overall, "n_per_arm_per_day": 20}


def check_sanity(rows: list[dict], tolerance: float = SANITY_TOLERANCE) -> dict:
    """sanity 臂差（X3 − X4）检验：|差分| 超过容差即报非零（未建模混淆）。"""
    diffs = cross_arm_diffs(rows)
    max_abs = max(abs(d["sanity_diff"]) for d in diffs["per_day"].values())
    return {
        "ok": max_abs <= tolerance,
        "max_abs_day_diff": round(max_abs, 4),
        "tolerance": tolerance,
        "overall_sanity_diff": round(diffs["overall"]["sanity_diff"], 4),
    }
