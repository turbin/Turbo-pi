#!/usr/bin/env python3
"""D7 预注册裁决核算（修订② 2026-08-23 用户批准，开跑前冻结）。

判定规则（doc/design/2026-08-23-d2-adversarial-review-and-amendments.md §3）：
1. 主检验：D7 当日 20 任务级配对差分（X2−X1，库演进）双侧 sign-flip 置换检验，
   α=0.05，同报 mean/median/sd/SEM。n=20 → 2^20 精确枚举。
2. 复制判定：D7 与 D2 同号且幅差 ≤1 个 D7-SEM → "方向一致"；≤0.5 SEM → "定量一致"。
   预设裁决词（同号同幅时）="方向一致的弱证据、功效不足（n=40 下 p≈0.06）、
   不判混淆不判证伪不停批，继续累积"。
3. 合并检验：D2+D7 日内分层置换（跨日不混排），n=40，预注册 α=0.10
   （复制检验非原初检验）。Monte Carlo 固定 seed=20260819，2,000,000 抽。
4. 敏感性（附属非主判定）：score_simple 无惩罚口径重算 + 剔 3 极端任务重算 + 中位数。
5. 实例偏置判定（A/B/C 三级）：V_D7 = [(X2−X1)+(X3−X4)]/2；
   A 级=V≥+0.05 且双尾 p<0.05；B 级=V≥+0.096 且单尾 p<0.05；
   C 级=V≤0 或（|V|<0.03 且 p>0.10）→ 噪声归档；中间带维持不可判定。

用法：
    ./.venv/bin/python d7_adjudication.py results/campaign-20260819/run.jsonl
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import numpy as np

SEED = 20260819
MC_DRAWS = 2_000_000
ALPHA_MAIN = 0.05
ALPHA_COMBINED = 0.10


def load_pairs(path: Path, day: int, score_key: str = "score") -> dict[str, dict[str, float]]:
    """day × kind==repeat 行 → {task_id: {arm: score}}。"""
    pairs: dict[str, dict[str, float]] = {}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if r.get("day") != day or r.get("kind", "repeat") != "repeat":
            continue
        score = r.get(score_key)
        if score_key != "score":
            score = (r.get("grading") or {}).get(score_key, r.get("score"))
        if score is None:
            continue
        pairs.setdefault(r["task_id"], {})[r["arm"]] = float(score)
    return pairs


def paired_diffs(pairs: dict[str, dict[str, float]], num_arm: str, den_arm: str) -> tuple[list[str], np.ndarray]:
    tasks = sorted(t for t, d in pairs.items() if num_arm in d and den_arm in d)
    diffs = np.array([pairs[t][num_arm] - pairs[t][den_arm] for t in tasks])
    return tasks, diffs


def exact_sign_flip_p(diffs: np.ndarray) -> float:
    """双侧 sign-flip 置换精确 p（2^n 枚举，均值口径）。"""
    n = len(diffs)
    obs = abs(diffs.mean())
    extreme = 0
    total = 0
    for signs in itertools.product((1.0, -1.0), repeat=n):
        total += 1
        if abs(float(np.dot(signs, diffs)) / n) >= obs - 1e-12:
            extreme += 1
    return extreme / total


def mc_stratified_p(d2: np.ndarray, d7: np.ndarray, seed: int, draws: int) -> float:
    """D2+D7 日内分层置换（跨日不混排）Monte Carlo 双侧 p。"""
    rng = np.random.default_rng(seed)
    obs = abs(float(np.concatenate([d2, d7]).mean()))
    n2, n7 = len(d2), len(d7)
    ge = 0
    for _ in range(draws // 100_000):
        s2 = rng.choice((-1.0, 1.0), size=(100_000, n2))
        s7 = rng.choice((-1.0, 1.0), size=(100_000, n7))
        means = (s2 @ d2 + s7 @ d7) / (n2 + n7)
        ge += int(np.count_nonzero(np.abs(means) >= obs - 1e-12))
    return ge / draws


def stats(diffs: np.ndarray) -> dict[str, float]:
    n = len(diffs)
    return {
        "n": n,
        "mean": round(float(diffs.mean()), 4),
        "median": round(float(np.median(diffs)), 4),
        "sd": round(float(diffs.std(ddof=1)), 4),
        "sem": round(float(diffs.std(ddof=1) / np.sqrt(n)), 4),
    }


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "results/campaign-20260819/run.jsonl")
    report: dict[str, object] = {"source": str(path), "seed": SEED}

    # ---- 1. 主检验：D7 X2−X1 精确置换 ----
    d7 = load_pairs(path, 7)
    tasks21, diff21 = paired_diffs(d7, "x2", "x1")
    p_main = exact_sign_flip_p(diff21)
    report["main_test_d7_library_evolution"] = {
        **stats(diff21),
        "contrast": "X2-X1",
        "p_two_sided_exact": round(p_main, 6),
        "alpha": ALPHA_MAIN,
        "significant": p_main < ALPHA_MAIN,
    }

    # ---- 2. 复制判定：D7 vs D2 同号同幅 ----
    d2 = load_pairs(path, 2)
    _, diff21_d2 = paired_diffs(d2, "x2", "x1")
    d2_stats = stats(diff21_d2)
    d7_mean = float(diff21.mean())
    d2_mean = float(diff21_d2.mean())
    sem7 = float(diff21.std(ddof=1) / np.sqrt(len(diff21)))
    same_sign = (d7_mean > 0) == (d2_mean > 0) and d7_mean != 0 and d2_mean != 0
    gap_sem = abs(d7_mean - d2_mean) / sem7 if sem7 > 0 else float("inf")
    if same_sign and gap_sem <= 0.5:
        verdict = "定量一致"
    elif same_sign and gap_sem <= 1.0:
        verdict = "方向一致"
    else:
        verdict = "不同号/不同幅"
    report["replication_d2_vs_d7"] = {
        "d2": d2_stats,
        "d7_mean": round(d7_mean, 4),
        "same_sign": same_sign,
        "gap_in_d7_sem": round(gap_sem, 2),
        "verdict": verdict,
        "preset_wording_applies": verdict in ("方向一致", "定量一致"),
        "preset_wording": (
            "方向一致的弱证据、功效不足（n=40 下 p≈0.06）、不判混淆不判证伪不停批，继续累积"
            if verdict in ("方向一致", "定量一致")
            else None
        ),
    }

    # ---- 3. 合并检验 D2+D7（日内分层，α=0.10） ----
    p_comb = mc_stratified_p(diff21_d2, diff21, SEED, MC_DRAWS)
    comb = np.concatenate([diff21_d2, diff21])
    report["combined_d2_d7"] = {
        **stats(comb),
        "p_two_sided_mc": round(p_comb, 6),
        "mc_draws": MC_DRAWS,
        "alpha": ALPHA_COMBINED,
        "significant": p_comb < ALPHA_COMBINED,
    }

    # ---- 4. 敏感性（附属非主判定） ----
    d7_simple = load_pairs(path, 7, score_key="score_simple")
    _, diff_simple = paired_diffs(d7_simple, "x2", "x1")
    order = np.argsort(-np.abs(diff21))
    keep = np.array([i for i in range(len(diff21)) if i not in set(order[:3].tolist())])
    diff_trim = diff21[keep]
    report["sensitivity"] = {
        "score_simple_mean": round(float(diff_simple.mean()), 4),
        "drop3_extreme_tasks": [tasks21[i] for i in order[:3]],
        "drop3_mean": round(float(diff_trim.mean()), 4),
        "drop3_n": len(diff_trim),
        "median_main": round(float(np.median(diff21)), 4),
    }

    # ---- 5. 实例偏置 V_D7 = [(X2−X1)+(X3−X4)]/2 ----
    tasks_all = sorted(
        t for t, d in d7.items() if all(a in d for a in ("x1", "x2", "x3", "x4"))
    )
    v = np.array(
        [((d7[t]["x2"] - d7[t]["x1"]) + (d7[t]["x3"] - d7[t]["x4"])) / 2 for t in tasks_all]
    )
    p_v = exact_sign_flip_p(v)
    v_mean = float(v.mean())
    # 单尾 p（V>0 方向）：对称分布下 ≈ 双尾/2，此处按枚举重算
    n = len(v)
    obs = v_mean
    ge_pos = 0
    total = 0
    for signs in itertools.product((1.0, -1.0), repeat=n):
        total += 1
        if float(np.dot(signs, v)) / n >= obs - 1e-12:
            ge_pos += 1
    p_v_one = ge_pos / total
    if v_mean >= 0.05 and p_v < 0.05:
        tier = "A"
    elif v_mean >= 0.096 and p_v_one < 0.05:
        tier = "B"
    elif v_mean <= 0 or (abs(v_mean) < 0.03 and p_v > 0.10):
        tier = "C"
    else:
        tier = "不可判定（中间带）"
    report["instance_bias_v"] = {
        **stats(v),
        "p_two_sided_exact": round(p_v, 6),
        "p_one_sided_pos_exact": round(p_v_one, 6),
        "tier": tier,
        "tier_meaning": {
            "A": "实例偏置确立（V≥+0.05 且双尾 p<0.05）",
            "B": "确立且未衰减（V≥+0.096 且单尾 p<0.05）",
            "C": "噪声归档（V≤0 或 |V|<0.03 且 p>0.10）",
        }.get(tier, tier),
    }

    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
