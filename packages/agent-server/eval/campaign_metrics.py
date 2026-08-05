#!/usr/bin/env python3
"""C 阶段 campaign — 指标与判据（纯函数，无副作用）。

输入：结果 JSONL 行（每天每任务一行）：
  {day, task_id, kind: "repeat"|"new", arm: "experiment"|"control",
   score: 0..1, passed: bool, escalated: bool, requests: int}

判据（预注册，doc/design/2026-08-05-agent-server-c-campaign-design.md）：
  ① 重复任务升级率 D7 ≤ 5%（实验臂）
  ② 新任务升级率（全程）< 20%（实验臂）
  ③ 升级率逐日下降趋势 + 成本/错误分布同报（报告中呈现，不在此断言）
"""

import json
from pathlib import Path

CRITERION_REPEAT_D7_MAX = 0.05
CRITERION_NEW_MAX = 0.20


def load_results(path: Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def escalation_rate(rows: list[dict]) -> float:
    if not rows:
        return 0.0
    return sum(1 for r in rows if r.get("escalated")) / len(rows)


def pass_rate(rows: list[dict]) -> float:
    if not rows:
        return 0.0
    return sum(1 for r in rows if r.get("passed")) / len(rows)


def daily_summary(rows: list[dict]) -> list[dict]:
    days = sorted({r["day"] for r in rows})
    out = []
    for d in days:
        day_rows = [r for r in rows if r["day"] == d and r.get("arm", "experiment") == "experiment"]
        rep = [r for r in day_rows if r["kind"] == "repeat"]
        new = [r for r in day_rows if r["kind"] == "new"]
        out.append(
            {
                "day": d,
                "repeat_esc": escalation_rate(rep),
                "repeat_pass": pass_rate(rep),
                "new_esc": escalation_rate(new),
                "new_pass": pass_rate(new),
                "repeat_n": len(rep),
                "new_n": len(new),
            }
        )
    return out


def check_criteria(rows: list[dict]) -> dict:
    """Pre-registered pass/fail. Days are 1-based; D7 = the final day present."""
    exp = [r for r in rows if r.get("arm", "experiment") == "experiment"]
    final_day = max((r["day"] for r in exp), default=0)
    rep_d7 = [r for r in exp if r["kind"] == "repeat" and r["day"] == final_day]
    new_all = [r for r in exp if r["kind"] == "new"]
    rep_rate = escalation_rate(rep_d7)
    new_rate = escalation_rate(new_all)
    return {
        "final_day": final_day,
        "repeat_escalation_final_day": rep_rate,
        "new_escalation_all": new_rate,
        "criterion_repeat_d7_max": CRITERION_REPEAT_D7_MAX,
        "criterion_new_max": CRITERION_NEW_MAX,
        "criterion1_repeat_ok": rep_rate <= CRITERION_REPEAT_D7_MAX,
        "criterion2_new_ok": new_rate < CRITERION_NEW_MAX,
    }
