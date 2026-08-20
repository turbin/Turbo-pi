#!/usr/bin/env python3
"""Held-out Transfer 泄漏检查（T7，评审 §十四）。

要证明 Transfer，测试任务绝不能以 exact 或 near-duplicate 形式进入 Memory。
本检查覆盖评审 §十四列的两类泄漏：

  MemoryLeakageRate = held-out 任务 prompt 与库中 active 卡 source prompt 的
     字符 3-gram Jaccard 相似度 > 0.6（阈值预注册）的配对数 / held-out 任务数；
     目标 = 0。
     相似度只对 prompt 文本本身计算——task_id 不同但模板相同（对象 ID 不同）
     也会被检出；这是"模板泄漏"近似的全部来源。

  future-task 提前入库：source_task ∈ held-out 且 created_at < 该任务首跑日
     的 active 卡 = 违规（数据流水线错误）。held-out 任务只挂 D7（preview
     §7.2/Q8），首跑日 = campaign 开始日 + 6 天（D7）；campaign 开始日从
     --campaign-start-date 或 results 目录名 campaign-YYYYMMDD 解析，
     解析不到时该检查跳过并在输出标注 skipped。

source_task 解析（先读 experience-store.ts schema 与真实 db 字段后的取法）：
  1. payload.taskId（ABILITY 卡，offline/verifier.ts cardsToStaged 写入；
     真实库中带臂前缀如 "control-task_00002_..."，normalize_task_id 以
     "task_" 为锚剥离前缀）；
  2. 回落 payload.sourceSession（EVIDENCE 卡）→ session 文件头
     metadata.task_id（offline/etl.ts sessionTaskId 同口径；session 文件按
     原路径 + session_dirs 目录名搜索解析）；
  3. 均取不到 → 用卡片 content 全文与 held-out prompt 比对（近似口径，评审
     §十四"prompt near duplicate"的精神扩展；输出 pairs 里 fallback=true 标注）。
      **漏检偏置（pi-test 定性，2026-08-19 打回修复）**：fallback 路径是假阴性
      （漏检）方向——卡 content 是蒸馏改写文本（procedure/boundary 步骤语），
      与 held-out prompt 的字符 3-gram 相似度可能远低于阈值，真实泄漏被漏掉；
      且 future-task 检查同样依赖 source_task 解析，解析失败时两条检查同时失明。
      故报表输出 unresolved_n / unresolved_ratio（三阶解析全失败的 active 卡
      计数与占比），unresolved_ratio > 0.2（预注册 UNRESOLVED_DEGRADED_THRESHOLD）
      时 conclusion="degraded"——泄漏结论降级为探索性，不可作"无泄漏"证据。

卡 content（近似口径用）= payload.procedure / boundary / text / title 首个
非空值；held-out prompt = campaign.task_prompt(task_id)（QCB 任务 md
## Prompt 节）。

CLI：
    ./.venv/bin/python leakage_check.py [--experience-db PATH]
        [--results RUN_ID] [--campaign-start-date YYYY-MM-DD]
    默认 experience.db = packages/agent-server/var/eval/experience.db；
    --results 默认 results/campaign-<今日>。输出 JSON + 违规明细。
"""

import argparse
import json
import re
import sqlite3
import sys
import time
from datetime import date, timedelta
from pathlib import Path

from campaign_plan import held_out_tasks, load_tasks
from campaign import task_prompt as _campaign_task_prompt

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_DB = EVAL_DIR.parent / "var" / "eval" / "experience.db"
# session 文件搜索目录（sourceSession 解析用）：agent-server var 目录 + eval 合成会话
DEFAULT_SESSION_DIRS = [EVAL_DIR.parent / "var" / "eval" / "sessions", EVAL_DIR / "sessions-synth"]

SIMILARITY_THRESHOLD = 0.6  # 预注册（任务书 §1.2 / 评审 §十四）
UNRESOLVED_DEGRADED_THRESHOLD = 0.2  # 预注册：source 解析失败占比 > 0.2 → conclusion="degraded"
HELD_OUT_FIRST_DAY = 7  # held-out 只挂 D7（preview.html §7.2/Q8）
D7_OFFSET_DAYS = HELD_OUT_FIRST_DAY - 1  # D7 = campaign 开始日 + 6 天


def char_trigrams(text: str) -> set[str]:
    """字符 3-gram；短于 3 字符的文本整体作为一个 gram（启发式，防除零）。"""
    if len(text) < 3:
        return {text} if text else set()
    return {text[i : i + 3] for i in range(len(text) - 2)}


def jaccard_sim(a: str, b: str) -> float:
    """字符 3-gram Jaccard 相似度（0..1，空集对记 0.0）。"""
    ga, gb = char_trigrams(a), char_trigrams(b)
    if not ga and not gb:
        return 1.0
    union = ga | gb
    if not union:
        return 0.0
    return len(ga & gb) / len(union)


# ── source_task 解析 ──


def normalize_task_id(raw: str) -> str:
    """去臂前缀：真实库中 ABILITY payload.taskId 形如 "control-task_00002_..."，
    以 "task_" 为锚剥离前缀；无锚原样返回。"""
    idx = raw.find("task_")
    return raw[idx:] if idx >= 0 else raw


def session_task_id(path: Path, session_dirs: list[Path]) -> str:
    """读 session 文件头 metadata.task_id（offline/etl.ts sessionTaskId 同口径）。

    候选解析顺序：原路径 → 各搜索目录 + 文件名 → 各搜索目录 + "sessions(‑synth)"
    标记后的相对后缀（真实库 sourceSession 常为 pkg 相对路径如
    "eval/sessions-synth/campaign-d1/x.jsonl"）。
    """
    candidates: list[Path] = [path]
    for d in session_dirs:
        candidates.append(d / path.name)
        for marker in ("sessions-synth", "sessions"):
            idx = str(path).find(marker)
            if idx >= 0:
                suffix = str(path)[idx + len(marker) :].lstrip("/")
                if suffix:
                    candidates.append(d / suffix)
    for cand in candidates:
        if not Path(cand).exists():
            continue
        try:
            for line in Path(cand).read_text().splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                if entry.get("type") == "session":
                    meta = entry.get("metadata") or {}
                    tid = meta.get("task_id") or meta.get("taskId") or ""
                    if isinstance(tid, str) and tid:
                        return tid
                    break
        except (OSError, json.JSONDecodeError):
            continue
    return ""


def resolve_source_task(payload: dict, session_dirs: list[Path]) -> str:
    """卡 → source_task（解析顺序见模块 docstring）；取不到返回 ""。"""
    task_id = payload.get("taskId")
    if isinstance(task_id, str) and task_id:
        return normalize_task_id(task_id)
    source = payload.get("sourceSession")
    if isinstance(source, str) and source:
        tid = session_task_id(Path(source), session_dirs)
        if tid:
            return tid
    return ""


def card_content(payload: dict) -> str:
    """卡 content（近似口径比对用）：procedure/boundary/text/title 首个非空。"""
    for key in ("procedure", "boundary", "text", "title"):
        val = payload.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def card_source_prompt(payload: dict, session_dirs: list[Path], task_prompt_fn=None) -> tuple[str | None, str, bool]:
    """(source_task, prompt 文本, 是否解析到 source prompt)。

    source_task 解析成功且任务 md 可取 → (task_id, 任务 prompt, True)；
    否则 → (None, 卡 content 全文, False)（近似口径，docstring 注明）。
    """
    task_id = resolve_source_task(payload, session_dirs)
    if task_id:
        loader = task_prompt_fn if task_prompt_fn is not None else _campaign_task_prompt
        try:
            prompt = loader(task_id)
            if prompt:
                return task_id, prompt, True
        except (OSError, ValueError, IndexError):
            pass  # 任务 md 缺失 → 回落 content
    return None, card_content(payload), False


def load_cards(con: sqlite3.Connection, status: str = "active") -> list[dict]:
    """active 卡（可检索进入 prompt 的口径，experience-store.ts status 三态）。"""
    rows = con.execute(
        "SELECT id, type, title, payload, created_at, status FROM experiences WHERE status = ?", (status,)
    ).fetchall()
    cards = []
    for card_id, exp_type, title, payload_raw, created_at, _status in rows:
        try:
            payload = json.loads(payload_raw)
        except json.JSONDecodeError:
            payload = {}
        cards.append({"id": card_id, "type": exp_type, "title": title, "payload": payload, "created_at": created_at})
    return cards


# ── 指标（纯函数） ──


def memory_leakage_rate(
    held_prompts: dict[str, str],
    cards: list[dict],
    threshold: float = SIMILARITY_THRESHOLD,
) -> dict:
    """MemoryLeakageRate（口径见模块 docstring）。

    cards 元素须含 {"id", "source_task"（str|None）, "prompt"（文本）,
    "resolved"（bool）}；held_prompts = {held_task_id: prompt}。
    """
    pairs: list[dict] = []
    for held_id, held_prompt in held_prompts.items():
        for card in cards:
            sim = jaccard_sim(held_prompt, card["prompt"])
            if sim > threshold:
                pairs.append(
                    {
                        "held_out_task": held_id,
                        "card_id": card["id"],
                        "similarity": round(sim, 4),
                        "source_task": card["source_task"],
                        "fallback": not card["resolved"],
                    }
                )
    n_held = len(held_prompts)
    return {
        "rate": (len(pairs) / n_held) if n_held else 0.0,
        "pairs": pairs,
        "n_held_out": n_held,
        "target": 0,
        "threshold": threshold,
    }


def future_task_violations(cards: list[dict], first_run_dates: dict[str, str]) -> list[dict]:
    """future-task 提前入库检查：source_task ∈ held-out 且 created_at 日期
    < 该任务首跑日的 active 卡。created_at 取日期部分（'T' 或 ' ' 分隔）。"""
    violations: list[dict] = []
    for card in cards:
        source = card.get("source_task")
        if not source or source not in first_run_dates:
            continue
        created = (card.get("created_at") or "").split("T")[0].split(" ")[0]
        first_run = first_run_dates[source]
        if isinstance(first_run, date):
            first_run = first_run.isoformat()  # 容忍 date 对象（测试/调用方注入）
        if created and created < first_run:
            violations.append(
                {"card_id": card["id"], "source_task": source, "created_at": card.get("created_at"), "first_run_date": first_run_dates[source]}
            )
    return violations


def first_run_dates_for_held(held_ids: list[str], campaign_start: date) -> dict[str, str]:
    """held-out 任务首跑日 = D7 = campaign 开始日 + 6 天（全部 held-out 同值）。"""
    d7 = campaign_start + timedelta(days=D7_OFFSET_DAYS)
    return {tid: d7.isoformat() for tid in held_ids}


def campaign_start_from_run_id(run_id: str) -> date | None:
    """results 目录名 campaign-YYYYMMDD → 开始日；解析不到返回 None。"""
    m = re.search(r"(\d{8})$", run_id)
    if not m:
        return None
    try:
        return date(int(m.group(1)[:4]), int(m.group(1)[4:6]), int(m.group(1)[6:8]))
    except ValueError:
        return None


# ── 整库 wiring ──


def report(
    db_path: Path,
    held_ids: list[str],
    first_run_dates: dict[str, str],
    task_prompt_fn=None,
    session_dirs: list[Path] | None = None,
    threshold: float = SIMILARITY_THRESHOLD,
    *,
    skip_future_check: bool = False,
) -> dict:
    """完整报表：MemoryLeakageRate + future-task 检查 + 明细。"""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cards = load_cards(con)
    finally:
        con.close()
    dirs = session_dirs or DEFAULT_SESSION_DIRS
    entries = []
    for card in cards:
        task_id, prompt, resolved = card_source_prompt(card["payload"], dirs, task_prompt_fn=task_prompt_fn)
        entries.append(
            {"id": card["id"], "source_task": task_id, "prompt": prompt, "resolved": resolved, "created_at": card["created_at"]}
        )
    held_prompts = {}
    missing: list[str] = []
    for tid in held_ids:
        loader = task_prompt_fn if task_prompt_fn is not None else _campaign_task_prompt
        try:
            prompt = loader(tid)
        except (OSError, ValueError, IndexError):
            prompt = ""
        if prompt:
            held_prompts[tid] = prompt
        else:
            missing.append(tid)
    leakage = memory_leakage_rate(held_prompts, entries, threshold=threshold)
    violations = [] if skip_future_check else future_task_violations(entries, first_run_dates)
    # 解析率审计（pi-test 打回修复）：三阶解析全失败的卡回落 content 比对会假阴性
    # （漏检方向）——占比超阈值时泄漏结论降级为探索性。
    total_cards = len(entries)
    unresolved_n = sum(1 for e in entries if not e["resolved"])
    unresolved_ratio = (unresolved_n / total_cards) if total_cards else 0.0
    conclusion = "degraded" if unresolved_ratio > UNRESOLVED_DEGRADED_THRESHOLD else "ok"
    return {
        "memory_leakage_rate": leakage["rate"],
        "leak_pairs": leakage["pairs"],
        "n_held_out": leakage["n_held_out"],
        "n_held_with_prompt": len(held_prompts),
        "held_missing_prompt": missing,
        "target": 0,
        "threshold": threshold,
        "future_task_violations": violations,
        "future_task_first_run": sorted(set(v.isoformat() if isinstance(v, date) else v for v in first_run_dates.values()))[0] if first_run_dates else None,
        "future_task_check_skipped": skip_future_check,
        "n_cards_checked": total_cards,
        "unresolved_n": unresolved_n,
        "unresolved_ratio": unresolved_ratio,
        "conclusion": conclusion,
        "degraded_threshold": UNRESOLVED_DEGRADED_THRESHOLD,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Held-out Transfer 泄漏检查（T7，评审 §十四）")
    ap.add_argument("--experience-db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--results", type=str, default=f"campaign-{time.strftime('%Y%m%d')}", help="results/<run_id>（取 campaign 开始日）")
    ap.add_argument("--campaign-start-date", type=str, default="", help="YYYY-MM-DD；缺省从 --results 目录名解析")
    args = ap.parse_args()
    if not args.experience_db.exists():
        sys.exit(f"experience.db not found: {args.experience_db}")
    held = held_out_tasks(load_tasks())
    start = None
    if args.campaign_start_date:
        start = date.fromisoformat(args.campaign_start_date)
    else:
        start = campaign_start_from_run_id(args.results)
    if start is None:
        print(json.dumps({"error": "cannot determine campaign start date; pass --campaign-start-date"}, ensure_ascii=False, indent=2))
        sys.exit(1)
    rep = report(
        db_path=args.experience_db,
        held_ids=held,
        first_run_dates=first_run_dates_for_held(held, start),
    )
    print(json.dumps(rep, indent=2, ensure_ascii=False))
    if rep["conclusion"] == "degraded":
        print(
            f"CONCLUSION: degraded — {rep['unresolved_n']}/{rep['n_cards_checked']} active cards unresolved "
            f"(ratio {rep['unresolved_ratio']} > {rep['degraded_threshold']}); leak rate is exploratory only "
            "(fallback content comparison is false-negative biased)",
            file=sys.stderr,
        )
    if rep["leak_pairs"]:
        print("LEAK DETECTED:", file=sys.stderr)
        for p in rep["leak_pairs"]:
            print(f"  held-out={p['held_out_task']} card={p['card_id']} sim={p['similarity']} "
                  f"source_task={p['source_task']} fallback={p['fallback']}", file=sys.stderr)
    for v in rep["future_task_violations"]:
        print(f"FUTURE-TASK VIOLATION: card={v['card_id']} source_task={v['source_task']} "
              f"created_at={v['created_at']} first_run={v['first_run_date']}", file=sys.stderr)


if __name__ == "__main__":
    main()
