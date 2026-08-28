#!/usr/bin/env python3
r"""重跑稳定性审计（T9，评审 §十五：RunToRunVariance）。

单日单跑可能受 sampling / Tool 网络 / Judge / 环境 timing 影响——+5pp 到底
是真变化还是自然波动？本脚本选 5 个典型任务 × 3 次重复（同窗口，省 preflight），
看 RunToRunVariance。

任务选取（纯函数 select_audit_tasks，n=5，键预注册 sha256("rerun-audit")）：
  五类典型（评审 §十五原文：高分任务 / 30 轮失败任务 / Memory 明显改善任务 /
  Memory 反向退化任务 / 中位任务），各类候选确定性排序后轮流取、去重后补足：
    1. 最高分    = 代表分（该任务 run.jsonl 行最大 score）最大
    2. 失败典型  = ExhaustedFailure（触顶∧失败）行数最多；触顶 =
       termination_reason=="max_turns"（旧行 fallback requests>=30）∧
       score<0.5（与 campaign 同口径）
    3. 改善最大  = delta = D7 − D1 最大（D1 实验臂行 → D7 实验等效臂行：
                  四臂日取 x2（campaign_cross 原实验臂口径），否则 experiment）
    4. 退化最大  = delta 最小
    5. 中位      = 代表分最接近全体代表分中位数
  同类并列按 sha256("rerun-audit"+task_id) 排序（确定性）；每类取当前候选，
  跨类去重，不足 5 个时按类别序继续补足。分类不可区分情形（delta 无配对候选 /
  只有单一符号）由 select_audit_tasks_with_notes 输出 noted 标记（2026-08-19
  pi-test 复核修复：主批 D7 四臂日无 experiment 行时改善/退化类不再失效）。

执行：每任务 ×REPEATS=3 次重复，复用 campaign.run_agent 回路（8789
injection=on，同 MAX_TURNS/TOOL_TIMEOUT/重试/workspace 克隆/judge safe_grade）。
指标 RunToRunVariance = 每任务 score 极差（max−min）+ 样本标准差
（statistics.stdev，n<2 记 0.0）；输出 JSON + 汇总（均值极差/均值标准差）。

写入隔离：本脚本不落盘 transcripts——纯稳定性测量，评分只用内存执行对象，
不产生 evolution 输入（评审 §十 与 preview.html §10 写入隔离精神）。

CLI：
    ./.venv/bin/python rerun_audit.py results/<run_id>
        [--out-dir results/rerun-audit-<date>]
"""

import argparse
import hashlib
import json
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI

from campaign import run_agent, safe_grade, setup_workspace, task_prompt
from campaign_plan import load_tasks
import confirm_tasks
from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
AGENT_SERVER = "http://127.0.0.1:8789/v1"
SELECTION_KEY = "rerun-audit"  # 选取键（预注册，任务书 §1.4）
N_TASKS = 5
REPEATS = 3
PASS_THRESHOLD = 0.5


def _hash_rank(task_id: str) -> str:
    return hashlib.sha256(f"{SELECTION_KEY}{task_id}".encode()).hexdigest()


def _d1_row(task_rows: list[dict]) -> dict | None:
    """D1 实验臂行：优先 experiment，缺则回退 x2（任务书 §1.4 / metrics_v2 同口径）。"""
    d1 = [r for r in task_rows if int(r.get("day") or 0) == 1 and r.get("arm") == "experiment"]
    if not d1:
        d1 = [r for r in task_rows if int(r.get("day") or 0) == 1 and r.get("arm") == "x2"]
    return d1[0] if d1 else None


def _d7_row(task_rows: list[dict]) -> dict | None:
    """D7 实验等效臂行：优先 x2（四臂日 X2 = 原实验臂口径，campaign_cross），
    缺则回退 experiment（任务书 §1.4；2026-08-19 pi-test 复核修复：主批 D7 四臂日
    无 experiment 行时 delta 不再恒空）。"""
    d7 = [r for r in task_rows if int(r.get("day") or 0) == 7 and r.get("arm") == "x2"]
    if not d7:
        d7 = [r for r in task_rows if int(r.get("day") or 0) == 7 and r.get("arm") == "experiment"]
    return d7[0] if d7 else None


def _is_capped(row: dict) -> bool:
    term = row.get("termination_reason")
    if term is not None:
        return term == "max_turns"
    return int(row.get("requests") or 0) >= 30  # 旧行 fallback（与 campaign 同口径）


def select_audit_tasks(rows: list[dict], n: int = N_TASKS) -> list[str]:
    """五类典型选取（口径见模块 docstring；确定性）。分类不可区分情形（delta 无
    配对候选 / 单符号）的 noted 标记见 select_audit_tasks_with_notes。"""
    selected, _notes = select_audit_tasks_with_notes(rows, n)
    return selected


def select_audit_tasks_with_notes(rows: list[dict], n: int = N_TASKS) -> tuple[list[str], list[str]]:
    """五类典型选取 + noted 标记（2026-08-19 pi-test 复核修复）：改善/退化两类的
    分类不可区分情形（delta 无配对候选，或只有单一符号）输出 noted 说明。"""
    if not rows:
        return [], []
    by_task: dict[str, list[dict]] = {}
    for row in rows:
        by_task.setdefault(row["task_id"], []).append(row)
    rep: dict[str, float] = {}
    exhausted_n: dict[str, int] = {}
    delta: dict[str, float] = {}
    for tid, task_rows in by_task.items():
        rep[tid] = max(float(r.get("score") or 0.0) for r in task_rows)
        exhausted_n[tid] = sum(1 for r in task_rows if _is_capped(r) and float(r.get("score") or 0.0) < PASS_THRESHOLD)
        d1, d7 = _d1_row(task_rows), _d7_row(task_rows)
        if d1 is not None and d7 is not None:
            delta[tid] = float(d7.get("score") or 0.0) - float(d1.get("score") or 0.0)
    notes: list[str] = []
    if not delta:
        notes.append("delta 无配对候选（D1→D7 实验等效臂配对缺失）：改善/退化两类分类不可区分（noted）。")
    else:
        if not any(v > 0 for v in delta.values()):
            notes.append("改善类无候选（无 delta>0 任务）（noted）。")
        if not any(v < 0 for v in delta.values()):
            notes.append("退化类无候选（无 delta<0 任务）（noted）。")
    median_rep = statistics.median(rep.values()) if rep else 0.0
    categories: list[list[str]] = [
        sorted(rep, key=lambda t: (-rep[t], _hash_rank(t))),  # 1. 最高分
        sorted((t for t in exhausted_n if exhausted_n[t] > 0), key=lambda t: (-exhausted_n[t], _hash_rank(t))),  # 2. 失败典型
        sorted(delta, key=lambda t: (-delta[t], _hash_rank(t))),  # 3. 改善最大
        sorted(delta, key=lambda t: (delta[t], _hash_rank(t))),  # 4. 退化最大
        sorted(rep, key=lambda t: (abs(rep[t] - median_rep), _hash_rank(t))),  # 5. 中位
    ]
    selected: list[str] = []
    pos = [0] * len(categories)
    while len(selected) < n:
        progressed = False
        for ci in range(len(categories)):
            if len(selected) >= n:
                break
            while pos[ci] < len(categories[ci]) and categories[ci][pos[ci]] in selected:
                pos[ci] += 1
            if pos[ci] < len(categories[ci]):
                selected.append(categories[ci][pos[ci]])
                pos[ci] += 1
                progressed = True
        if not progressed:
            break
    return selected, notes


def run_to_run_variance(scores: list[float]) -> dict:
    """RunToRunVariance：极差 + 样本标准差（n<2 时 stddev=0.0）。"""
    if not scores:
        return {"n": 0, "mean": 0.0, "min": None, "max": None, "range": 0.0, "stddev": 0.0}
    return {
        "n": len(scores),
        "mean": statistics.fmean(scores),
        "min": min(scores),
        "max": max(scores),
        "range": max(scores) - min(scores),
        "stddev": statistics.stdev(scores) if len(scores) >= 2 else 0.0,
    }


@dataclass
class RunContext:
    student_client: object
    run_agent: object
    grade: object
    setup_workspace: object
    task_prompt: object
    task_timeout: object


def run_audit(task_ids: list[str], ctx: RunContext, out_dir: Path, *, repeats: int = REPEATS) -> dict:
    """每任务 ×repeats 重复（8789 injection=on），输出审计 JSON。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    confirm_tasks.assert_no_confirm_tasks(task_ids, context="rerun_audit")
    per_task: dict[str, dict] = {}
    for tid in task_ids:
        prompt = ctx.task_prompt(tid)
        timeout_s = ctx.task_timeout(tid)
        scores: list[float] = []
        for i in range(repeats):
            # P0：每次重复使用独立 repeat-N/<task-id> 工作区，开始前断言目录不存在。
            ws = ctx.setup_workspace(tid, out_dir / "workspaces" / tid / f"repeat-{i}")
            execution = ctx.run_agent(
                ctx.student_client, "agent-auto", prompt, ws, timeout_s,
                injection=True, task_id=tid, domain="office",
                arm="experiment", condition="rerun-injection-on",
            )
            grade = ctx.grade(tid, execution, ws)
            scores.append(float(grade.get("score") or 0.0))
        per_task[tid] = {"scores": scores, "variance": run_to_run_variance(scores)}
    report = {
        "selection_key": SELECTION_KEY,
        "repeats": repeats,
        "per_task": per_task,
        "summary": {
            "n_tasks": len(task_ids),
            "mean_range": statistics.fmean(v["variance"]["range"] for v in per_task.values()) if per_task else 0.0,
            "mean_stddev": statistics.fmean(v["variance"]["stddev"] for v in per_task.values()) if per_task else 0.0,
        },
    }
    (out_dir / "audit.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="重跑稳定性审计（T9，评审 §十五）")
    ap.add_argument("results", type=Path, help="results/<run_id>（run.jsonl 任务选取）")
    ap.add_argument("--out-dir", type=Path, default=EVAL_DIR / "results" / f"rerun-audit-{time.strftime('%Y%m%d')}")
    args = ap.parse_args()
    run_jsonl = args.results / "run.jsonl"
    if not run_jsonl.exists():
        sys.exit(f"run.jsonl not found: {run_jsonl}")
    rows = [json.loads(line) for line in run_jsonl.read_text().splitlines() if line.strip()]
    task_ids, notes = select_audit_tasks_with_notes(rows)
    if not task_ids:
        sys.exit("no tasks found in run.jsonl — cannot build audit subset")
    if notes:
        print("selection notes:")
        for note in notes:
            print(f"  - {note}")
    print(f"audit tasks ({len(task_ids)}): {task_ids}")
    ensure_for_base_url(AGENT_SERVER)
    client = OpenAI(base_url=AGENT_SERVER, api_key="lobster-local-key", timeout=1800.0)
    meta = {t.id: t for t in load_tasks()}
    ctx = RunContext(
        student_client=client,
        run_agent=run_agent,
        grade=safe_grade,
        setup_workspace=setup_workspace,
        task_prompt=task_prompt,
        task_timeout=lambda tid: meta.get(tid).timeout_seconds if meta.get(tid) else 1800,
    )
    report = run_audit(task_ids, ctx, args.out_dir)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {args.out_dir / 'audit.json'}")


if __name__ == "__main__":
    main()
