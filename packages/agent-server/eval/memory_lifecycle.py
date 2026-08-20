#!/usr/bin/env python3
"""Memory 生命周期离线报表（T7，评审 §八）。

输入：experience.db（experiences + request_traces）+ 可选 results/<run_id>
run.jsonl（任务分数，供 SuccessAfterReuse / Utility）。输出 JSON。

指标（预注册口径，见任务书 §1.2 与评审 §八）：

  ReuseCount        = request_traces.retrieved_ids（JSON 数组）展开后逐卡计数
                      ——一条经验被检索到多少次
  SuccessAfterReuse = 命中任务中成功比例。命中任务 = 该任务（task_id）任一
                      request 的 retrieved_ids 非空；任务分 = run.jsonl 中该
                      任务行的最大 score（跨日/跨臂）；成功 = score>=0.5
  Utility           = E[Δscore∣memory]。有对照配对时（命中任务、同日配对）按
                      ON−OFF 逐配对取均值；配对规则预注册（pi-test 5.2 打回修复）：
                      **只允许同库配对照**——experiment vs control（旧双臂）与
                      x2 vs x3（四臂日，preview §7.2 D7 主因果比较=当前库）；
                      x1/x4（冻结库臂）与其他混库组合（如 x1−x3）一律不配对并计
                      unpaired_n（旧行为按文件序取首臂会配出 x1−x3 混库配对且随
                      task-block 随机执行序不稳）。无配对时用命中任务 score 均值
                      近似，输出 method="approximation" 标注。
                      ON 臂 = experiment/x1/x2，OFF 臂 = control/x3/x4；
                      unpaired_n = 双面齐备但无合法同库配对的 (task, day) 组数
  Age               = created_at 到今天的自然日数（分布 + 逐卡明细）
  DuplicateRate     = 同 source_task 多 active 卡的比例；active 口径 =
                      experiences.status='active'（experience-store.ts）。
                      source_task 解析同 leakage_check（payload.taskId →
                      sourceSession → session 头 metadata.task_id）；无法解析
                      的卡不计分母并计数（n_unresolved）

CLI：
    ./.venv/bin/python memory_lifecycle.py [--experience-db PATH]
        [--results RUN_ID] [--sessions-dir PATH]
    默认 experience.db = packages/agent-server/var/eval/experience.db；
    --results 缺省时 SuccessAfterReuse/Utility 跳过（无 run.jsonl）。
"""

import argparse
import json
import sqlite3
import statistics
import sys
from datetime import date, datetime
from pathlib import Path

from leakage_check import resolve_source_task

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_DB = EVAL_DIR.parent / "var" / "eval" / "experience.db"
# session 文件搜索目录（sourceSession 解析用）：agent-server var 目录 + eval 合成会话
DEFAULT_SESSION_DIRS = [EVAL_DIR.parent / "var" / "eval" / "sessions", EVAL_DIR / "sessions-synth"]
PASS_THRESHOLD = 0.5  # 成功口径，与 campaign.py 同值
ON_ARMS = ("experiment", "x1", "x2")
OFF_ARMS = ("control", "x3", "x4")
# 配对规则（预注册，pi-test 5.2 打回修复）：只允许同库配对照——旧双臂
# experiment vs control；四臂日 x2 vs x3（当日库，preview §7.2 D7 主因果比较）。
# x1/x4（冻结库）与其他混库组合一律不配对并计 unpaired_n。
ALLOWED_PAIRS: tuple[tuple[str, str], ...] = (("experiment", "control"), ("x2", "x3"))


def connect_db(path: Path) -> sqlite3.Connection:
    if str(path) == ":memory:":
        return sqlite3.connect(":memory:")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def load_rows(run_dir: Path | None) -> list[dict]:
    if run_dir is None or not (run_dir / "run.jsonl").exists():
        return []
    return [json.loads(line) for line in (run_dir / "run.jsonl").read_text().splitlines() if line.strip()]


# ── ReuseCount ──


def reuse_counts(con: sqlite3.Connection) -> dict[str, int]:
    """retrieved_ids 展开逐卡计数（全部 request_traces）。"""
    counts: dict[str, int] = {}
    for (retrieved_raw,) in con.execute("SELECT retrieved_ids FROM request_traces").fetchall():
        try:
            ids = json.loads(retrieved_raw or "[]")
        except json.JSONDecodeError:
            continue
        for card_id in ids:
            if isinstance(card_id, str):
                counts[card_id] = counts.get(card_id, 0) + 1
    return counts


# ── SuccessAfterReuse ──


def hit_tasks(con: sqlite3.Connection) -> set[str]:
    """命中任务集 = 任一 request 的 retrieved_ids 非空。"""
    hits: set[str] = set()
    for (task_id, retrieved_raw) in con.execute("SELECT task_id, retrieved_ids FROM request_traces WHERE task_id IS NOT NULL").fetchall():
        try:
            ids = json.loads(retrieved_raw or "[]")
        except json.JSONDecodeError:
            continue
        if ids:
            hits.add(task_id)
    return hits


def success_after_reuse(con: sqlite3.Connection, rows: list[dict]) -> dict:
    """命中任务中 score>=0.5 的比例（任务分 = 行最大值，口径见模块 docstring）。"""
    hits = hit_tasks(con)
    best_score: dict[str, float] = {}
    for row in rows:
        tid = row["task_id"]
        best_score[tid] = max(best_score.get(tid, 0.0), float(row.get("score") or 0.0))
    hit_with_score = [tid for tid in hits if tid in best_score]
    n_success = sum(1 for tid in hit_with_score if best_score[tid] >= PASS_THRESHOLD)
    return {
        "rate": (n_success / len(hit_with_score)) if hit_with_score else 0.0,
        "n_hit_tasks": len(hit_with_score),
        "n_success": n_success,
        "n_hit_without_score": len(hits) - len(hit_with_score),
    }


# ── Utility ──


def matched_deltas(con: sqlite3.Connection, rows: list[dict]) -> tuple[list[tuple[str, float]], int]:
    """(合法配对, unpaired_n)——配对规则见模块 docstring（只允许同库配对照）。

    每个 (task, day) 组内按 ALLOWED_PAIRS 声明序取第一组同库配对（同日内
    experiment/control 与 x2/x3 并存属混合批次形态，取前者并保持确定性）；
    unpaired_n = 双面（ON/OFF）齐备但无合法同库配对的组数。
    """
    hits = hit_tasks(con)
    by_task_day: dict[tuple[str, int], dict[str, float]] = {}
    for row in rows:
        if row["task_id"] not in hits:
            continue
        by_task_day.setdefault((row["task_id"], int(row["day"])), {})[row["arm"]] = float(row.get("score") or 0.0)
    deltas: list[tuple[str, float]] = []
    unpaired_n = 0
    for (tid, _day), arms in sorted(by_task_day.items()):
        paired = False
        for on_arm, off_arm in ALLOWED_PAIRS:
            if on_arm in arms and off_arm in arms:
                deltas.append((tid, arms[on_arm] - arms[off_arm]))
                paired = True
                break
        if not paired:
            on_present = any(a in arms for a in ON_ARMS)
            off_present = any(a in arms for a in OFF_ARMS)
            if on_present and off_present:
                unpaired_n += 1  # 双面齐备但无合法同库配对 → 跳过并计数
    return deltas, unpaired_n


def utility(con: sqlite3.Connection, rows: list[dict]) -> dict:
    """E[Δscore∣memory]（口径见模块 docstring；无配对时近似并标注）。"""
    deltas, unpaired_n = matched_deltas(con, rows)
    if deltas:
        values = [d for _tid, d in deltas]
        return {"value": statistics.fmean(values), "method": "matched", "n_pairs": len(deltas), "unpaired_n": unpaired_n}
    hits = hit_tasks(con)
    best_score: dict[str, float] = {}
    for row in rows:
        best_score[row["task_id"]] = max(best_score.get(row["task_id"], 0.0), float(row.get("score") or 0.0))
    hit_scores = [best_score[tid] for tid in hits if tid in best_score]
    return {
        "value": statistics.fmean(hit_scores) if hit_scores else 0.0,
        "method": "approximation",  # 无合法同库对照配对，用命中任务 score 均值近似
        "n_hit_tasks": len(hit_scores),
        "unpaired_n": unpaired_n,
    }


# ── Age ──


def age_report(con: sqlite3.Connection, today: date | None = None) -> dict:
    """created_at 到今天的天数分布 + 逐卡明细。"""
    today = today or date.today()
    per_card: list[dict] = []
    for (card_id, created_at) in con.execute("SELECT id, created_at FROM experiences").fetchall():
        parsed = None
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime((created_at or "")[:19], fmt).date()
                break
            except ValueError:
                continue
        days = (today - parsed).days if parsed else None
        per_card.append({"id": card_id, "created_at": created_at, "age_days": days})
    days_list = [c["age_days"] for c in per_card if c["age_days"] is not None]
    return {
        "n": len(per_card),
        "min_days": min(days_list) if days_list else None,
        "median_days": statistics.median(days_list) if days_list else None,
        "max_days": max(days_list) if days_list else None,
        "per_card": per_card,
    }


# ── DuplicateRate ──


def duplicate_rate(con: sqlite3.Connection, session_dirs: list[Path]) -> dict:
    """同 source_task 多 active 卡比例（active 口径 = status='active'）。"""
    rows = con.execute("SELECT id, payload FROM experiences WHERE status = 'active'").fetchall()
    by_source: dict[str, list[str]] = {}
    unresolved: list[str] = []
    for card_id, payload_raw in rows:
        try:
            payload = json.loads(payload_raw)
        except json.JSONDecodeError:
            payload = {}
        source = resolve_source_task(payload, session_dirs)
        if source:
            by_source.setdefault(source, []).append(card_id)
        else:
            unresolved.append(card_id)
    duplicate_ids = [cid for ids in by_source.values() if len(ids) > 1 for cid in ids]
    n_resolvable = sum(len(ids) for ids in by_source.values())
    return {
        "rate": (len(duplicate_ids) / n_resolvable) if n_resolvable else 0.0,
        "n_active": len(rows),
        "n_resolvable": n_resolvable,
        "n_duplicate": len(duplicate_ids),
        "n_unresolved": len(unresolved),
        "duplicate_groups": {source: ids for source, ids in by_source.items() if len(ids) > 1},
    }


# ── 整库 wiring ──


def report(
    con: sqlite3.Connection,
    rows: list[dict],
    session_dirs: list[Path] | None = None,
    today: date | None = None,
) -> dict:
    return {
        "reuse_count": reuse_counts(con),
        "success_after_reuse": success_after_reuse(con, rows),
        "utility": utility(con, rows),
        "age": age_report(con, today=today),
        "duplicate_rate": duplicate_rate(con, session_dirs or DEFAULT_SESSION_DIRS),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Memory 生命周期离线报表（T7，评审 §八）")
    ap.add_argument("--experience-db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--results", type=str, default="", help="results/<run_id>（提供任务分数）")
    ap.add_argument("--sessions-dir", type=Path, action="append", default=[], help="session 搜索目录（可多次）")
    args = ap.parse_args()
    if not args.experience_db.exists():
        sys.exit(f"experience.db not found: {args.experience_db}")
    run_dir = EVAL_DIR / "results" / args.results if args.results else None
    rows = load_rows(run_dir)
    con = connect_db(args.experience_db)
    try:
        rep = report(con, rows, session_dirs=args.sessions_dir or DEFAULT_SESSION_DIRS)
    finally:
        con.close()
    if not rows:
        rep["note"] = "no run.jsonl provided — SuccessAfterReuse/Utility use empty score set"
    print(json.dumps(rep, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
