#!/usr/bin/env python3
"""C 阶段 campaign — 指标与判据（纯函数，无副作用）。

输入：结果 JSONL 行（每天每任务一行）：
  {day, task_id, kind: "repeat"|"new", arm: "experiment"|"control",
   score: 0..1, passed: bool, escalated: bool, requests: int,
   trace_ids: [gateway trace ids]}

判据（预注册，doc/design/2026-08-05-agent-server-c-campaign-design.md）：
  ① 重复任务升级率 D7 ≤ 5%（实验臂）
  ② 新任务升级率（全程）< 20%（实验臂）
  ③ 升级率逐日下降趋势 + 成本/错误分布同报（报告中呈现，不在此断言）

C2（2026-08-09 对抗审查）："escalated" 必须真实标注（运行时 x-gateway 标记或
model_runs 回填）；未标注的行一律 fail loud，绝不当作 0 升级率放行。

T4（2026-08-19 D 阶段增强，preview.html §3 Analysis Addendum）：假独立三指标，
预注册——只做报告，不改既有判据函数：
  成功 = score >= 0.5（与 campaign.py PASS_THRESHOLD 同口径）
  "明显失败"（§3 组合定义）：score < 0.3 ∨ grading_error == True ∨
    (termination_reason == "max_turns" ∧ score < 0.5)；旧 run.jsonl 行无
    termination_reason 时第三个子句跳过（.get 容错）。
  AutonomousSuccessRate = 成功且未升级任务数 / 全部任务数
  MissedEscalationRate  = 明显失败且未升级任务数 / 明显失败任务数
  EscalatedSuccessRate  = 升级后成功任务数 / 升级任务数
  比率分母为零时记 0.0，并附各分母计数（n 字段）供口径核对。
"""

import json
import sqlite3
from pathlib import Path

CRITERION_REPEAT_D7_MAX = 0.05
CRITERION_NEW_MAX = 0.20
PASS_THRESHOLD = 0.5  # 成功口径，与 campaign.py 同值


def load_results(path: Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def annotate_escalation(rows: list[dict], gateway_db: Path) -> list[dict]:
    """C2: join gateway model_runs——按 trace_id 回填缺失的 escalated 标记。

    model_runs 是升级事实的唯一 ground truth；运行时 x-gateway 标记缺失时
    （旧结果、直连路径）用这张表补标。只补"escalated"缺失的行。
    """
    if not gateway_db.exists():
        raise FileNotFoundError(f"gateway database not found: {gateway_db}")
    con = sqlite3.connect(f"file:{gateway_db}?mode=ro", uri=True)
    try:
        rows_table = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='model_runs'").fetchall()
        if not rows_table:
            raise ValueError(f"gateway database {gateway_db} has no model_runs table")
        escalated_trace_ids = {
            r[0]
            for r in con.execute(
                "SELECT DISTINCT trace_id FROM model_runs WHERE purpose='escalation' AND state='succeeded'"
            )
        }
    finally:
        con.close()
    out = []
    for row in rows:
        if "escalated" not in row:
            row = {**row, "escalated": any(t in escalated_trace_ids for t in row.get("trace_ids", []))}
        out.append(row)
    return out


def escalation_rate(rows: list[dict]) -> float:
    """C2: 未标注 escalated 的行拒绝出结论（fail loud），绝不静默当作 0。"""
    if not rows:
        return 0.0
    unmarked = [r for r in rows if "escalated" not in r]
    if unmarked:
        raise ValueError(
            f"{len(unmarked)}/{len(rows)} result rows lack the 'escalated' marker — "
            "annotate with gateway model_runs first (issue-003 C2: unmarked rows must not pass criteria)"
        )
    return sum(1 for r in rows if r.get("escalated")) / len(rows)


def pass_rate(rows: list[dict]) -> float:
    if not rows:
        return 0.0
    return sum(1 for r in rows if r.get("passed")) / len(rows)


def _grading_error(row: dict) -> bool:
    """评分崩溃标记：row["grading"]["grading_error"]（campaign.py 落盘形态）
    或顶层 row["grading_error"]（合成/手工行）两种形态都认。"""
    grading = row.get("grading")
    if isinstance(grading, dict):
        return bool(grading.get("grading_error"))
    return bool(row.get("grading_error"))


def is_obvious_failure(row: dict) -> bool:
    """preview.html §3 预注册"明显失败"组合：score < 0.3 ∨ grading_error ∨
    (termination_reason == "max_turns" ∧ score < 0.5)。
    旧行无 termination_reason 时第三个子句跳过；score 缺失按 0 处理（保守：
    缺评分即视为失败，纳入漏升级审计）。"""
    score = row.get("score", 0.0)
    if score < 0.3:
        return True
    if _grading_error(row):
        return True
    return row.get("termination_reason") == "max_turns" and score < PASS_THRESHOLD


def addendum_metrics(rows: list[dict]) -> dict:
    """§3 假独立三指标 + 分母计数；输入行集合的总体口径（不按臂过滤，
    调用方决定作用域），比率分母为零时记 0.0。"""
    total = len(rows)
    success = [r for r in rows if r.get("score", 0.0) >= PASS_THRESHOLD]
    autonomous = [r for r in success if not r.get("escalated")]
    failures = [r for r in rows if is_obvious_failure(r)]
    missed = [r for r in failures if not r.get("escalated")]
    escalated_rows = [r for r in rows if r.get("escalated")]
    escalated_ok = [r for r in escalated_rows if r.get("score", 0.0) >= PASS_THRESHOLD]
    return {
        "autonomous_success_rate": len(autonomous) / total if total else 0.0,
        "autonomous_success_n": len(autonomous),
        "total_n": total,
        "missed_escalation_rate": len(missed) / len(failures) if failures else 0.0,
        "missed_escalation_n": len(missed),
        "obvious_failure_n": len(failures),
        "escalated_success_rate": len(escalated_ok) / len(escalated_rows) if escalated_rows else 0.0,
        "escalated_success_n": len(escalated_ok),
        "escalated_n": len(escalated_rows),
    }


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
