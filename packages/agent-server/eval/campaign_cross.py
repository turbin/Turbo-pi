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
落库为准。sanity 哨兵分级（修订① 2026-08-23 用户批准，D7 起前瞻生效）：
|X3−X4| ≤ 0.10 → ok；0.10 < |diff| ≤ 0.18 → note（工程注记，不停批）；
|diff| > 0.18 → stop 候选（置换 p 由报告层人工执行）。D2 实测噪声地板：
配对 sd≈0.32 / SEM≈0.072（n=20 日），2.5×SEM≈0.18，日 FPR ~2%；原
SANITY_TOLERANCE=0.05 预注册失准（零效应日误报率 ~50%），已 superseded。

落库形态：campaign.py --arms x1,x2,x3,x4 模式每行 {day, task_id, arm: xN,
kind: repeat, score, library: frozen|daily, ...}；本模块纯函数核算。
D7 实例交叉（修订③ 方案 A）：冻结臂任务按 sha256(run_id+day+task_id)
奇偶对半分配冻结实例 a/b（campaign.frozen_instance_for，run.jsonl 行带
frozen_instance 维度）；差分核算不受实例维度影响——实例效应在冻结-current
对比中已抵消，实例分层在 D7 报告中另行呈现（metrics_v2 暂不改）。
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

# sanity 臂差哨兵分级（修订① 2026-08-23 用户批准，D7 起前瞻生效）：
#   工程门（哨兵）与统计门（置换检验）分离——D2 教训即二者混用。
# D2 实测噪声地板：配对 sd≈0.32 / SEM≈0.072（n=20 任务/日），2.5×SEM≈0.18。
#   Tier-1 note：|diff| > 0.10 → 报告注记，不停批（日 FPR ~18%）
#   Tier-2 stop：|diff| > 0.18 → 停批候选；配对置换 p<0.05 条件由报告层
#                 人工执行（双条件缺一不停；日 FPR ~2%）。
SANITY_TIER1_NOTE = 0.10
SANITY_TIER2_STOP = 0.18
# 历史常量（superseded by SANITY_TIER1_NOTE/SANITY_TIER2_STOP）：0.05 预注册
# 失准——零效应日误报率 ~50%，不再参与判定，保留仅作口径追溯。
SANITY_TOLERANCE = 0.05


def four_arm_plan(tasks: list, day: int) -> dict[str, list[str]]:
    """四臂计划：每臂 = 当日重复集（20 任务，同一任务集）。"""
    repeat, _new = split_tasks(tasks)
    return {arm: sorted(repeat) for arm in CROSS_ARMS}


def _mean(scores: list[float]) -> float:
    return sum(scores) / len(scores) if scores else 0.0


def _repeat_rows(rows: list[dict]) -> list[dict]:
    """差分核算样本集：只含 kind=="repeat" 的行；kind 缺失的旧行按 repeat
    处理（.get 容错，旧落库行无 kind 字段）。held_out 行（kind=held_out）
    排除——preview.html §7.2：transfer 比较独立于 cross 2×2 差分口径，
    held_out 只挂 x2/x3 会污染 x2/x3 均值与 sanity_diff（pi-test 复核确认）。"""
    return [r for r in rows if r.get("kind", "repeat") == "repeat"]


def cross_arm_diffs(rows: list[dict]) -> dict:
    """四臂差分核算（纯函数）。行需含 day/task_id/arm/score，四臂齐全。

    preview.html §7.2：只统计 kind=="repeat" 的行（held_out 行排除，
    kind 缺失旧行按 repeat 容错）；n_per_arm_per_day 按过滤后实际计数。"""
    rows = _repeat_rows(rows)
    arms_present = {r["arm"] for r in rows}
    missing = set(CROSS_ARMS) - arms_present
    if missing:
        raise ValueError(f"cross-arm diffs require all four arms; missing: {sorted(missing)}")
    days = sorted({int(r["day"]) for r in rows})

    per_day: dict[str, dict] = {}
    n_per_arm_per_day: dict[str, dict[str, int]] = {}
    for day in days:
        day_rows = [r for r in rows if int(r["day"]) == day]
        means = {arm: _mean([r["score"] for r in day_rows if r["arm"] == arm]) for arm in CROSS_ARMS}
        per_day[str(day)] = {
            **means,
            "library_evolution": means["x2"] - means["x1"],
            "injection_effect": means["x1"] - means["x4"],
            "sanity_diff": means["x3"] - means["x4"],
        }
        n_per_arm_per_day[str(day)] = {arm: len([r for r in day_rows if r["arm"] == arm]) for arm in CROSS_ARMS}

    overall_means = {arm: _mean([r["score"] for r in rows if r["arm"] == arm]) for arm in CROSS_ARMS}
    overall = {
        **overall_means,
        "library_evolution": overall_means["x2"] - overall_means["x1"],
        "injection_effect": overall_means["x1"] - overall_means["x4"],
        "sanity_diff": overall_means["x3"] - overall_means["x4"],
    }
    return {"per_day": per_day, "overall": overall, "n_per_arm_per_day": n_per_arm_per_day}


def transfer_gain(rows: list[dict]) -> dict | None:
    """Held-out transfer 增益（preview.html §7.2）：TransferGain = held_out
    任务 x2 均分 − x3 均分（D7 memory on/off 比较）。独立于 cross 2×2 差分
    口径（held_out 行不进 cross_arm_diffs）；附两臂计数。无 held_out 行
    （非四臂日/旧结果）返回 None。"""
    held = [r for r in rows if r.get("kind") == "held_out"]
    if not held:
        return None
    x2 = [r["score"] for r in held if r["arm"] == "x2"]
    x3 = [r["score"] for r in held if r["arm"] == "x3"]
    return {
        "transfer_gain": _mean(x2) - _mean(x3),
        "x2_n": len(x2),
        "x3_n": len(x3),
    }


def check_sanity(rows: list[dict]) -> dict:
    """sanity 臂差（X3 − X4）分级哨兵（修订① 2026-08-23 用户批准，D7 前瞻生效）。

    D2 实测噪声地板：配对 sd≈0.32 / SEM≈0.072（n=20 任务/日），2.5×SEM≈0.18。
    三级：
      tier=ok   |diff| ≤ 0.10（Tier-1 下界内，无注记）
      tier=note 0.10 < |diff| ≤ 0.18 → 工程注记，不停批（日 FPR ~18%）
      tier=stop |diff| > 0.18 → 停批候选：requires_permutation_check=True，
                配对置换 p<0.05 条件由报告层人工执行（双条件缺一不停，日 FPR ~2%）
    工程门（哨兵）与统计门（置换检验）分离。`ok` 字段 = (tier == "ok")，
    向后兼容既有消费方；SANITY_TOLERANCE=0.05 已 superseded。"""
    diffs = cross_arm_diffs(rows)
    max_abs = max(abs(d["sanity_diff"]) for d in diffs["per_day"].values())
    if max_abs > SANITY_TIER2_STOP:
        tier = "stop"
    elif max_abs > SANITY_TIER1_NOTE:
        tier = "note"
    else:
        tier = "ok"
    return {
        "ok": tier == "ok",
        "tier": tier,
        "max_abs_day_diff": round(max_abs, 4),
        "overall_sanity_diff": round(diffs["overall"]["sanity_diff"], 4),
        "requires_permutation_check": tier == "stop",
        "tier1_note": SANITY_TIER1_NOTE,
        "tier2_stop": SANITY_TIER2_STOP,
    }
