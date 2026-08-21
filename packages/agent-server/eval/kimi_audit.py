#!/usr/bin/env python3
r"""Kimi judge audit（Teacher/Judge 同源稳健性审计，preview.html §13）。

协议：doc/design/2026-08-19-d-stage-cross-day-runbook.md §4（预注册，严格照做）；
与主 judge 同 rubric、同 transcript 摘要、同评分聚合，仅把 LLM 判官换成 Kimi。

时机：D2 / D7 各一次（交叉日对账后执行）。

抽样（确定性，键预注册）：
  从指定 day 已完成任务（run.jsonl 行）中确定性抽 ≤limit 个（默认 6）：
  按 sha256(f"{run_id}-d{day}-kimi-audit-{task_id}") 的 hex 升序取前 limit；
  池不足 limit 取全部并标注（note 写进报告）。抽样键（sha256 hex）输出进报告。
  臂 = 该任务当日首个完成行（run.jsonl 文件序）对应的臂；transcript 取
  transcripts/day{N}/<arm>-<task_id>.json。
  池只含 judge 相关口径任务：首行 grading.grading_type ∈ {llm_judge, hybrid}；
  automated/error 首行任务排除并注明（无 LLM 判分可对照，排除理由进报告）。

重判（与主 judge 完全同源）：
  prompt = lib_grading._build_judge_prompt(task, _summarize_transcript(transcript),
    task.llm_judge_rubric or _format_grading_criteria(task))——同一 rubric、
  同一 transcript 摘要；调用本地 _call_kimi_judge_api（stdlib HTTP，结构同
  lib_grading._call_llm_judge_api，temperature 固定 1.0）：
    base_url = env KIMI_BASE_URL（默认 https://api.kimi.com/coding/v1）
    api_key  = env KIMI_API_KEY（只读 os.environ，缺省 fail-loud）
    model    = env KIMI_AUDIT_MODEL（默认 kimi-for-coding）
  temperature=1.0 原因：kimi-for-coding 只允许 temperature=1（2026-08-21 连通性
  冒烟实测，0.0 → 400 "invalid temperature: only 1 is allowed for this model"）；
  与主 judge（lib_grading 硬编码 0.0）的温度差是 audit 已知口径差异，随报告
  kimi.notes 声明，vendored lib_grading 不改。
  响应解析复用 _parse_judge_text_response + _normalize_judge_response。
  缺 transcripts / 缺 KIMI_API_KEY / Kimi API 错误 → fail-loud（RuntimeError）。

分数口径（与 grade_task 相同聚合）：
  llm_judge：audit 总分 = 归一化 total（Kimi 自报 total 优先，缺省 = 逐项均值，
    同 _grade_llm_judge / _normalize_judge_response）。
  hybrid：同 _combine_grades——automated 子分与 llm 子分按 task.grading_weights
    加权，AUTO_PENALTY_THRESHOLD=0.75 罚零（auto<0.75 时 llm 贡献清零）。
    差异注明：automated 子分不重跑 exec 评分代码（audit 只读既有产物），
    复用 run.jsonl 已存 breakdown 的 automated.* 均值（= _grade_automated 的
    _average_scores 同一口径）；llm 子分 = Kimi 归一化 total。
  主判分 = run.jsonl 行 grading.score 与 breakdown（只读）。

一致性判定（预注册双判据，两条都满足才 consistent）：
  ① 逐任务 |score_kimi − score_deepseek| ≤ 0.2 的占比 ≥ 2/3（整数口径
     n_within*3 ≥ n*2，|Δ|=0.2 恰过）；
  ② 排序方向一致：Spearman 等级相关 ρ > 0（并列取平均秩；任一序列零方差
     或 n<2 → ρ 不可求 → 判②不满足，注明原因）。n<6 时注明解释纪律
     （小样本 ρ 解释力有限）；verdict=sensitive → 主结论降级为探索性。

纪律：只读 run.jsonl / transcripts；只写独立报告 results/<run_id>/kimi-audit-
  dayN.json；不回写 run.jsonl、不进判据、不替代主 judge、不影响其他流程。
  api_key 不进报告。

CLI：
    ./.venv/bin/python kimi_audit.py results/<run_id> --day N \
        [--limit 6] [--transcripts-dir PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

EVAL_DIR = Path(__file__).resolve().parent
QCB_DIR = EVAL_DIR / "qcb" / "tasks-v1.1"
HARNESS_REF = EVAL_DIR / "qcb" / "harness-ref"
sys.path.insert(0, str(HARNESS_REF))  # vendored QCB lib_tasks/lib_grading

from lib_grading import (  # noqa: E402
    AUTO_PENALTY_THRESHOLD,
    _build_judge_prompt,
    _format_grading_criteria,
    _normalize_judge_response,
    _parse_judge_text_response,
    _summarize_transcript,
)
from lib_tasks import Task, TaskLoader  # noqa: E402

SELECTION_KEY = "kimi-audit"  # 抽样键（预注册，runbook §4）
DEFAULT_LIMIT = 6
DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1"
DEFAULT_KIMI_MODEL = "kimi-for-coding"
# kimi-for-coding 只允许 temperature=1（2026-08-21 主会话连通性冒烟实测：
# temperature=0.0 → 400 "invalid temperature: only 1 is allowed for this model"）。
# 与主 judge（lib_grading._call_llm_judge_api 硬编码 0.0）的温度差是 audit 已知
# 口径差异，写进报告 kimi.notes；vendored lib_grading 是 harness 参考实现，不改。
KIMI_TEMPERATURE = 1.0
KIMI_MAX_TOKENS = 20480
DELTA_THRESHOLD = 0.2
REQUIRED_WITHIN_RATIO = 2.0 / 3.0
PROTOCOL_REF = "doc/design/2026-08-19-d-stage-cross-day-runbook.md §4；doc/design/preview.html §13"
JUDGE_GRADING_TYPES = ("llm_judge", "hybrid")


def _sample_key(run_id: str, day: int, task_id: str) -> str:
    """抽样键：sha256(f"{run_id}-d{day}-kimi-audit-{task_id}") 的 hex。"""
    return hashlib.sha256(f"{run_id}-d{day}-{SELECTION_KEY}-{task_id}".encode()).hexdigest()


def sample_tasks(run_id: str, day: int, rows: list[dict], limit: int = DEFAULT_LIMIT) -> tuple[list[str], dict[str, dict], dict]:
    """确定性抽样（纯函数）。

    返回 (sampled_task_ids, first_row_by_task, meta)：
      first_row_by_task[tid] = 该任务当日首个完成行（文件序）；
      meta 含 pool_size / sample_size / note（不足 limit 标注）/ sample_keys /
      excluded_tasks（automated/error 等无 LLM 判分的首行任务及原因）。
    """
    first_rows: dict[str, dict] = {}
    excluded: dict[str, str] = {}
    for row in rows:
        if int(row.get("day") or -1) != day:
            continue
        tid = str(row["task_id"])
        if tid in first_rows:
            continue
        gt = (row.get("grading") or {}).get("grading_type")
        if gt in JUDGE_GRADING_TYPES:
            first_rows[tid] = row
        else:
            excluded[tid] = f"first-row grading_type={gt} (no LLM judge score to compare)"
    ordered = sorted(first_rows, key=lambda t: _sample_key(run_id, day, t))
    sampled = ordered[:limit]
    pool = len(ordered)
    note: str | None
    if pool < limit:
        note = f"sampling pool {pool} < limit {limit}: took all {pool} tasks"
    elif pool > limit:
        note = f"sampling pool {pool} > limit {limit}: took first {limit} by sha256 key"
    else:
        note = None
    meta = {
        "key_format": 'sha256(f"{run_id}-d{day}-kimi-audit-{task_id}") hex 升序',
        "limit": limit,
        "pool_size": pool,
        "sample_size": len(sampled),
        "note": note,
        "sample_keys": {t: _sample_key(run_id, day, t) for t in sampled},
        "excluded_tasks": excluded,
    }
    return sampled, first_rows, meta


def load_task(task_id: str) -> Task:
    """与主批同源加载任务（campaign.grade 同一 TaskLoader / 同一 tasks 目录）。"""
    return TaskLoader(QCB_DIR / "tasks").load_task(QCB_DIR / "tasks" / f"{task_id}.md")


def build_judge_prompt(task: Task, transcript: list[dict]) -> str:
    """主 judge 同源 prompt：同一 rubric + 同一 _summarize_transcript。"""
    rubric = task.llm_judge_rubric or _format_grading_criteria(task)
    return _build_judge_prompt(task, _summarize_transcript(transcript), rubric)


def _call_kimi_judge_api(
    prompt: str,
    model: str,
    base_url: str,
    api_key: str,
    timeout_seconds: float = 1800.0,
) -> str:
    """调 Kimi chat completions（stdlib urllib，结构同 lib_grading._call_llm_judge_api）。

    temperature 固定 1.0：kimi-for-coding 只允许 temperature=1（2026-08-21
    主会话连通性冒烟实测：temperature=0.0 → 400 "invalid temperature: only 1
    is allowed for this model"）。与主 judge（lib_grading 硬编码 temperature=0.0）
    的温度差是 audit 已知口径差异，随报告 kimi.notes 声明；vendored
    lib_grading 是 harness 参考实现，不改。
    """
    url = base_url.rstrip("/") + "/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": KIMI_TEMPERATURE,
        "max_tokens": KIMI_MAX_TOKENS,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise RuntimeError(f"LLM judge API returned {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM judge API request failed: {exc}") from exc
    choices = body.get("choices", [])
    if not choices:
        raise RuntimeError(f"LLM judge API returned no choices: {body}")
    return choices[0].get("message", {}).get("content", "")


def judge_with_kimi(prompt: str, *, api_key: str, base_url: str, model: str) -> dict:
    """调 Kimi 重判（本地 _call_kimi_judge_api，temperature=1.0）；
    解析复用 _parse_judge_text_response + _normalize_judge_response。"""
    response_text = _call_kimi_judge_api(prompt=prompt, model=model, base_url=base_url, api_key=api_key)
    return _normalize_judge_response(_parse_judge_text_response(response_text))


def _automated_subscore(breakdown: dict) -> float:
    """automated 子分 = run.jsonl 已存 breakdown 的 automated.* 均值。

    与 _grade_automated 的 _average_scores 同一口径（audit 不重跑 exec 评分
    代码——只读既有产物；见模块 docstring 差异注明）。
    """
    vals = [float(v) for k, v in breakdown.items() if str(k).startswith("automated.") and isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else 0.0


def audit_score(grading_type: str, breakdown: dict, grading_weights: dict | None, kimi_parsed: dict) -> float:
    """audit 总分 = 与 grade_task 相同聚合（llm_judge 归一化 total / hybrid 加权+罚零）。"""
    total = kimi_parsed.get("total")
    if total is None:
        scores = [v for v in kimi_parsed.get("scores", {}).values() if isinstance(v, (int, float))]
        total = sum(scores) / len(scores) if scores else 0.0
    total = float(total)
    if grading_type == "llm_judge":
        return total
    if grading_type == "hybrid":
        auto = _automated_subscore(breakdown)
        weights = grading_weights or {"automated": 0.5, "llm_judge": 0.5}
        auto_w = float(weights.get("automated", 0.5))
        llm_w = float(weights.get("llm_judge", 0.5))
        total_w = auto_w + llm_w
        if total_w <= 0:
            auto_w = llm_w = 0.5
            total_w = 1.0
        llm_adj = 0.0 if auto < AUTO_PENALTY_THRESHOLD else total
        return (auto * auto_w + llm_adj * llm_w) / total_w
    raise ValueError(f"audit requires llm_judge or hybrid grading, got {grading_type!r}")


def criterion1_within(deltas: list[float], threshold: float = DELTA_THRESHOLD) -> dict:
    """判据①：|Δ| ≤ 0.2 占比 ≥ 2/3（整数口径 n_within*3 ≥ n*2；|Δ|=0.2 恰过）。"""
    n = len(deltas)
    n_within = sum(1 for d in deltas if abs(d) <= threshold + 1e-9)
    return {
        "threshold": threshold,
        "n": n,
        "n_within": n_within,
        "proportion": round(n_within / n, 4) if n else 0.0,
        "required_ratio": round(REQUIRED_WITHIN_RATIO, 4),
        "passed": n > 0 and n_within * 3 >= n * 2,
    }


def _average_ranks(values: list[float]) -> list[float]:
    """并列取平均秩（Spearman 标准处理）。"""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def spearman_rho(xs: list[float], ys: list[float]) -> float | None:
    """Spearman 等级相关（平均秩处理并列）；n<2 或任一序列零方差 → None。"""
    n = len(xs)
    if n < 2 or len(ys) != n:
        return None
    rx, ry = _average_ranks(xs), _average_ranks(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    denom = math.sqrt(sum((a - mx) ** 2 for a in rx)) * math.sqrt(sum((b - my) ** 2 for b in ry))
    if denom == 0:
        return None
    return num / denom


def criterion2_spearman(xs: list[float], ys: list[float]) -> dict:
    """判据②：排序方向一致（Spearman ρ > 0）；n<6 注明解释纪律。"""
    rho = spearman_rho(xs, ys)
    n = len(xs)
    if rho is None:
        return {
            "n": n,
            "rho": None,
            "passed": False,
            "note": "ranking direction not evaluable (n<2 or zero variance on one side) — criterion ② not satisfied",
        }
    passed = rho > 0
    if n < 6:
        note = f"n={n} < 6: Spearman 小样本，解释力有限（解释纪律）"
    elif 0.0 < rho <= 0.3:
        note = f"rho={rho:.3f}: 正相关但很弱，方向一致性有限"
    else:
        note = None
    return {"n": n, "rho": round(rho, 4), "passed": passed, "note": note}


def verdict(criterion1: dict, criterion2: dict) -> str:
    """双判据都满足 → consistent；任一条不满足 → sensitive（预注册）。"""
    return "consistent" if criterion1["passed"] and criterion2["passed"] else "sensitive"


def _resolve_kimi_config() -> tuple[str, str, str]:
    """Kimi 参数只读 os.environ（env 注入由调用方启动命令做，本脚本不读 .env 文件）。"""
    api_key = os.environ.get("KIMI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "KIMI_API_KEY is required (inject via environment; kimi_audit never reads .env files)"
        )
    base_url = os.environ.get("KIMI_BASE_URL") or DEFAULT_KIMI_BASE_URL
    model = os.environ.get("KIMI_AUDIT_MODEL") or DEFAULT_KIMI_MODEL
    return api_key, base_url, model


def audit_day(run_dir: Path, day: int, *, limit: int = DEFAULT_LIMIT, transcripts_dir: Path | None = None) -> dict:
    """执行一日 Kimi audit；只写 results/<run_id>/kimi-audit-dayN.json（独立文件）。"""
    run_dir = Path(run_dir)
    run_jsonl = run_dir / "run.jsonl"
    if not run_jsonl.exists():
        raise RuntimeError(f"run.jsonl not found: {run_jsonl}")
    run_id = run_dir.name
    rows = [json.loads(line) for line in run_jsonl.read_text(encoding="utf-8").splitlines() if line.strip()]
    day_rows = [r for r in rows if int(r.get("day") or -1) == day]
    if not day_rows:
        raise RuntimeError(f"no completed tasks (rows) for day {day} in {run_jsonl}")
    sampled, first_rows, sampling_meta = sample_tasks(run_id, day, day_rows, limit=limit)
    if not sampled:
        raise RuntimeError(
            f"no judge-graded (llm_judge/hybrid) tasks for day {day} — nothing to audit"
        )
    api_key, base_url, model = _resolve_kimi_config()
    tdir = Path(transcripts_dir) if transcripts_dir is not None else run_dir / "transcripts"

    per_task: dict[str, Any] = {}
    deltas_raw: list[float] = []
    xs_raw: list[float] = []
    ys_raw: list[float] = []
    for tid in sampled:
        row = first_rows[tid]
        arm = str(row["arm"])
        tpath = tdir / f"day{day}" / f"{arm}-{tid}.json"
        if not tpath.exists():
            raise RuntimeError(f"transcript not found for sampled task {tid}: {tpath}")
        traj = json.loads(tpath.read_text(encoding="utf-8"))
        task = load_task(tid)
        prompt = build_judge_prompt(task, traj.get("transcript") or [])
        kimi_parsed = judge_with_kimi(prompt, api_key=api_key, base_url=base_url, model=model)
        grading = row.get("grading") or {}
        gt = grading.get("grading_type")
        score_ds = float(grading.get("score") or 0.0)
        score_kimi = audit_score(gt, grading.get("breakdown") or {}, task.grading_weights, kimi_parsed)
        delta_raw = score_kimi - score_ds
        deltas_raw.append(delta_raw)
        xs_raw.append(score_ds)
        ys_raw.append(score_kimi)
        per_task[tid] = {
            "arm": arm,
            "transcript": str(tpath),
            "grading_type": gt,
            "score_deepseek": round(score_ds, 4),
            "score_kimi": round(score_kimi, 4),
            "delta": round(delta_raw, 4),
            "within_0_2": abs(delta_raw) <= DELTA_THRESHOLD + 1e-9,
            "breakdown_deepseek": grading.get("breakdown") or {},
            "breakdown_kimi": kimi_parsed.get("scores") or {},
            "kimi_total": kimi_parsed.get("total"),
            "kimi_notes": str(kimi_parsed.get("notes") or "")[:500],
        }

    c1 = criterion1_within(deltas_raw)  # 判据用未舍入的原始 delta（|Δ|=0.2 边界）
    c2 = criterion2_spearman(xs_raw, ys_raw)  # 排序用原始分（避免 4 位舍入造出假并列）
    v = verdict(c1, c2)
    report = {
        "audit": SELECTION_KEY,
        "protocol_ref": PROTOCOL_REF,
        "run_id": run_id,
        "day": day,
        "kimi": {
            "model": model,
            "base_url": base_url,
            "temperature": KIMI_TEMPERATURE,
            "notes": (
                f"temperature={KIMI_TEMPERATURE}：kimi-for-coding 只允许 temperature=1"
                "（2026-08-21 连通性冒烟实测，0.0 → 400 invalid temperature）；"
                "主 judge（lib_grading._call_llm_judge_api）用 temperature=0.0 —— "
                "温度差是 audit 已知口径差异"
            ),
        },  # api_key 不进报告
        "sampling": sampling_meta,
        "per_task": per_task,
        "criteria": {
            "criterion1": {
                "name": "逐任务 |score_kimi − score_deepseek| ≤ 0.2 占比 ≥ 2/3",
                **c1,
            },
            "criterion2": {
                "name": "排序方向一致（Spearman 等级相关 > 0）",
                **c2,
            },
            "verdict": v,
            "interpretation": (
                "consistent → 主结论维持；sensitive → 判分敏感，主结论降级为探索性（runbook §4）"
            ),
        },
    }
    out_path = run_dir / f"kimi-audit-day{day}.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


def _print_summary(report: dict) -> None:
    """终端摘要（不回写任何既有产物）。"""
    c = report["criteria"]
    print(f"kimi audit day {report['day']} run {report['run_id']}: verdict={c['verdict']}")
    print(f"  criterion1 |Δ|<=0.2: {c['criterion1']['n_within']}/{c['criterion1']['n']} "
          f"(required >=2/3, passed={c['criterion1']['passed']})")
    rho = c["criterion2"]["rho"]
    print(f"  criterion2 spearman: rho={rho} (passed={c['criterion2']['passed']})")
    if c["criterion2"].get("note"):
        print(f"    note: {c['criterion2']['note']}")
    sm = report["sampling"]
    print(f"  sampling: pool={sm['pool_size']} sample={sm['sample_size']} (limit={sm['limit']})")
    if sm.get("note"):
        print(f"    note: {sm['note']}")
    if sm.get("excluded_tasks"):
        print(f"    excluded ({len(sm['excluded_tasks'])}): " + "; ".join(
            f"{t}: {r}" for t, r in sm["excluded_tasks"].items()
        ))
    print(f"  per-task ({len(report['per_task'])}):")
    for tid, pt in report["per_task"].items():
        mark = "ok" if pt["within_0_2"] else "OUT"
        print(f"    {tid} [{pt['arm']}] ds={pt['score_deepseek']:.3f} kimi={pt['score_kimi']:.3f} "
              f"delta={pt['delta']:+.3f} {mark}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Kimi judge audit（Teacher/Judge 同源稳健性，preview §13 / runbook §4）")
    ap.add_argument("results", type=Path, help="results/<run_id>（含 run.jsonl）")
    ap.add_argument("--day", type=int, required=True, help="审计日（D2 / D7 各一次）")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="抽样上限（默认 6）")
    ap.add_argument("--transcripts-dir", type=Path, default=None,
                    help="transcripts 根目录（默认 results/<run_id>/transcripts）")
    args = ap.parse_args(argv)
    report = audit_day(args.results, args.day, limit=args.limit, transcripts_dir=args.transcripts_dir)
    _print_summary(report)
    print(f"wrote {args.results / f'kimi-audit-day{args.day}.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
