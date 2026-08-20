#!/usr/bin/env python3
"""Trajectory 离线分析器（D 阶段增强，preview.html §8.2 / §17.3）。

读取 results/<run_id>/transcripts/dayN/*.json（campaign.py 落盘形态：
{task_id, arm, day, prompt, transcript, score}；transcript 为 QCB OpenClaw
事件形态 {type:"message", message:{role, content:[parts]}}——assistant 消息
content 的 part 为 {type:"text",text} 或 {type:"toolCall",name,arguments}，
toolResult 消息 content 为文本列表）。CapRate 另读
results/<run_id>/run.jsonl（T1 起含 termination_reason；旧行无该字段时
fallback requests>=30 并在输出标注 caprate_fallback_n）。

指标为启发式（预注册，preview.html §8.2 注明启发式性质）：
  RoundCount           = 每个任务 transcript 中 assistant 决策回合
                         （assistant message 事件）数；分布报 P50/P75/P90/P95
                         （numpy 兼容线性插值）。
  CapRate（2026-08-19 用户裁决：按最终成败拆三档——单独总体触顶率不可解释，
          preview.html §3.1"触顶且目标未完成" / §8.3 联合判定 / §22 红线 4
          "不把 round 降低但 score 同时下降解释为 Agent 改善"）：
    cap_rate          = 触顶任务数 / 任务数（总体，兼容旧口径）
    cap_success_rate  = 触顶且成功（score >= 0.5，与 campaign PASS_THRESHOLD
                        同口径）任务数 / 任务数——"预算用满但交付"
    cap_failure_rate  = 触顶且失败任务数 / 任务数——"无效绕圈"
    cap_unknown_n     = 无分数任务数（run.jsonl 缺失 / 任务行缺失 / 行无 score）
    触顶判定：termination_reason=="max_turns"；旧行（无该键）fallback
    requests>=30，与成败拆分直接联用该行 score；fallback 行数标注
    caprate_fallback_n。学习有效判读 = cap_failure_rate ↓（cap_success_rate
    允许非零）。
  RepeatToolRate       = 相邻两回合（连续两个含 toolCall 的 assistant 回合，
                         按位置对齐 zip 到较短长度）中 (name, canonical
                         arguments) 完全相同的位置数 / 全部 toolCall 数。
  RetryRate            = 错误 toolResult 后下一含 toolCall 回合仍调用同名
                         工具的次数 / 错误 toolResult 数；错误标记（大小写
                         不敏感子串）：[command timed out / command failed /
                         Error / Traceback]；错误结果按与 toolCall 的位置对齐
                         归因，无法对齐时不计。
  StateRevisitRate     = 非相邻重复次数 / 全部 toolCall 数；非相邻重复 = 同一
                         (name, canonical args) 再次出现且与此前任意一次出现
                         间隔 ≥ 1 个完整回合（相邻重复归 RepeatToolRate）。
  ProductiveRoundRatio = 含 toolCall 的回合中"新信息回合"占比；新信息回合 =
                         该回合任一 toolResult 文本与此前所有回合的 toolResult
                         文本均不相同的回合。
  canonical args       = json.dumps(sort_keys=True) 序列化。
  所有比率分母为零时记 0.0；RoundCount 分位在无任务时记 None。

CLI：
    ./.venv/bin/python trajectory_metrics.py results/<run_id> [--day N]

输出 JSON：{run_id, days, total, by_day, by_arm}；total/by_day/by_arm 各为
{tasks, round_count{p50,p75,p90,p95}, cap_rate, caprate_fallback_n,
repeat_tool_rate, retry_rate, state_revisit_rate, productive_round_ratio}。
"""

import argparse
import json
import sys
from pathlib import Path

ERROR_MARKERS = ["command timed out", "command failed", "error", "traceback"]
PASS_THRESHOLD = 0.5  # 成功口径，与 campaign.py 同值


def parse_rounds(events: list[dict]) -> list[dict]:
    """把 QCB OpenClaw 事件序列折成决策回合。

    回合 = 一个 assistant message 事件；toolCall part 记入 calls，其后紧随
    的 toolResult 事件文本记入该回合 results（campaign.py 每个 toolCall
    按序落一条 toolResult，位置对齐）。纯文本 assistant 回合 calls 为空。
    """
    rounds: list[dict] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            calls = []
            for part in message.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    calls.append((str(part.get("name", "")), part.get("arguments")))
            rounds.append({"calls": calls, "results": []})
        elif role == "toolResult" and rounds:
            for content in message.get("content") or []:
                if isinstance(content, str):
                    rounds[-1]["results"].append(content)
                elif isinstance(content, dict):
                    rounds[-1]["results"].append(str(content.get("text", "")))
                else:
                    rounds[-1]["results"].append(str(content))
    return rounds


def _canonical(args) -> str:
    """canonical arguments = JSON 序列化（key 排序），dict/str 都处理。"""
    return json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _call_key(call: tuple[str, object]) -> tuple[str, str]:
    name, args = call
    return (name, _canonical(args))


def count_tool_calls(rounds: list[dict]) -> int:
    return sum(len(r["calls"]) for r in rounds)


def repeat_tool_rate(rounds: list[dict]) -> float:
    repeats = count_repeat_tool_calls(rounds)
    calls = count_tool_calls(rounds)
    return repeats / calls if calls else 0.0


def count_repeat_tool_calls(rounds: list[dict]) -> int:
    """相邻两回合按位置对齐，统计 (name, canonical args) 完全相同的位置数。"""
    tool_rounds = [r for r in rounds if r["calls"]]
    repeats = 0
    for prev, cur in zip(tool_rounds, tool_rounds[1:]):
        repeats += sum(
            1
            for a, b in zip(prev["calls"], cur["calls"])
            if _call_key(a) == _call_key(b)
        )
    return repeats


def retry_rate(rounds: list[dict]) -> float:
    errors, retries = count_retries(rounds)
    return retries / errors if errors else 0.0


def count_retries(rounds: list[dict]) -> tuple[int, int]:
    """错误 toolResult 数 / 其中之后下一含 toolCall 回合仍调用同名工具的次数。"""
    errors = 0
    retries = 0
    for idx, round_ in enumerate(rounds):
        calls = round_["calls"]
        for pos, text in enumerate(round_["results"]):
            if pos >= len(calls):
                continue  # 结果与调用无法对齐，不计
            if not any(marker in text.lower() for marker in ERROR_MARKERS):
                continue
            errors += 1
            next_tool_round = next((r for r in rounds[idx + 1 :] if r["calls"]), None)
            if next_tool_round and any(
                call[0] == calls[pos][0] for call in next_tool_round["calls"]
            ):
                retries += 1
    return errors, retries


def state_revisit_rate(rounds: list[dict]) -> float:
    revisits = count_state_revisits(rounds)
    calls = count_tool_calls(rounds)
    return revisits / calls if calls else 0.0


def count_state_revisits(rounds: list[dict]) -> int:
    """非相邻重复：同一 (name, args) 再次出现且与此前任意一次间隔 ≥ 1 个完整回合。"""
    seen: dict[tuple[str, str], int] = {}
    revisits = 0
    for round_idx, round_ in enumerate(rounds):
        for call in round_["calls"]:
            key = _call_key(call)
            earlier = seen.get(key)
            if earlier is not None and round_idx - earlier >= 2:
                revisits += 1
            seen[key] = round_idx
    return revisits


def productive_round_ratio(rounds: list[dict]) -> float:
    productive, tool_rounds = count_productive_rounds(rounds)
    return productive / tool_rounds if tool_rounds else 0.0


def count_productive_rounds(rounds: list[dict]) -> tuple[int, int]:
    """新信息回合数 / 含 toolCall 回合数；新信息 = 该回合任一 toolResult 文本
    与此前所有回合的 toolResult 文本均不相同。"""
    seen: set[str] = set()
    productive = 0
    tool_rounds = 0
    for round_ in rounds:
        if not round_["calls"]:
            continue
        tool_rounds += 1
        results = round_["results"]
        if results and any(text not in seen for text in results):
            productive += 1
        seen.update(results)
    return productive, tool_rounds


def _percentile(sorted_values: list[float], p: float) -> float:
    """numpy 兼容线性插值（升序输入）；调用方保证非空。"""
    n = len(sorted_values)
    if n == 1:
        return float(sorted_values[0])
    rank = (p / 100.0) * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def _load_transcripts(run_dir: Path, day: int | None) -> list[dict]:
    """收集 transcripts/dayN/*.json 文档；目录缺失 fail loud。"""
    transcripts_root = run_dir / "transcripts"
    if not transcripts_root.exists():
        raise FileNotFoundError(f"transcripts directory not found: {transcripts_root}")
    day_dirs = sorted(
        (d for d in transcripts_root.iterdir() if d.is_dir() and d.name.startswith("day")),
        key=lambda d: int(d.name[3:]),
    )
    if day is not None:
        day_dirs = [d for d in day_dirs if int(d.name[3:]) == day]
    docs: list[dict] = []
    for day_dir in day_dirs:
        for path in sorted(day_dir.glob("*.json")):
            docs.append(json.loads(path.read_text()))
    return docs


def _load_run_rows(run_dir: Path) -> list[dict]:
    """run.jsonl 任务行；文件缺失返回 []（2026-08-19 裁决：run.jsonl 整体
    缺失不炸批，任务全部计入 cap_unknown_n 组）。"""
    path = run_dir / "run.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _is_capped(row: dict) -> tuple[bool, bool]:
    """(是否触顶, 是否走了 fallback 口径)。有 termination_reason 键时信任该字段；
    旧行（无键）fallback requests>=30。"""
    if "termination_reason" in row:
        return row.get("termination_reason") == "max_turns", False
    return row.get("requests", 0) >= 30, True


def _group_report(tasks: list[dict], rows: list[dict]) -> dict:
    """一组任务的汇总：trajectory 指标按全部 transcript 合并口径（pooled）；
    CapRate 以 transcript 任务为总体，逐任务关联 run.jsonl 行（day+arm+
    task_id join）取 score/termination，成败按 PASS_THRESHOLD 拆三档。
    tasks/rows 的 day+arm 作用域由调用方过滤。"""
    rows_by_key = {(r.get("day"), r.get("arm"), r.get("task_id")): r for r in rows}
    round_counts = []
    tool_calls = 0
    repeats = 0
    errors = 0
    retries = 0
    revisits = 0
    productive = 0
    tool_rounds = 0
    for doc in tasks:
        rounds = parse_rounds(doc.get("transcript") or [])
        round_counts.append(float(len(rounds)))
        tool_calls += count_tool_calls(rounds)
        repeats += count_repeat_tool_calls(rounds)
        e, r = count_retries(rounds)
        errors += e
        retries += r
        revisits += count_state_revisits(rounds)
        p, tr = count_productive_rounds(rounds)
        productive += p
        tool_rounds += tr
    total = len(tasks)
    capped = 0
    capped_success = 0
    capped_failure = 0
    unknown = 0
    fallback_n = 0
    for doc in tasks:
        row = rows_by_key.get((doc.get("day"), doc.get("arm"), doc.get("task_id")))
        has_score = row is not None and "score" in row
        if not has_score:
            unknown += 1  # run.jsonl 缺失 / 任务行缺失 / 行无 score → unknown 组
        if row is None:
            continue  # 无行：无法判触顶，也不计 fallback
        is_capped_row, used_fallback = _is_capped(row)
        fallback_n += 1 if used_fallback else 0
        if is_capped_row:
            capped += 1
            if has_score:
                if row["score"] >= PASS_THRESHOLD:
                    capped_success += 1  # "预算用满但交付"
                else:
                    capped_failure += 1  # "无效绕圈"
    return {
        "tasks": total,
        "round_count": (
            {
                "p50": _percentile(sorted(round_counts), 50),
                "p75": _percentile(sorted(round_counts), 75),
                "p90": _percentile(sorted(round_counts), 90),
                "p95": _percentile(sorted(round_counts), 95),
            }
            if round_counts
            else {"p50": None, "p75": None, "p90": None, "p95": None}
        ),
        "cap_rate": capped / total if total else 0.0,
        "cap_success_rate": capped_success / total if total else 0.0,
        "cap_failure_rate": capped_failure / total if total else 0.0,
        "cap_unknown_n": unknown,
        "caprate_fallback_n": fallback_n,
        "repeat_tool_rate": repeats / tool_calls if tool_calls else 0.0,
        "retry_rate": retries / errors if errors else 0.0,
        "state_revisit_rate": revisits / tool_calls if tool_calls else 0.0,
        "productive_round_ratio": productive / tool_rounds if tool_rounds else 0.0,
    }


def analyze(run_dir: Path, day: int | None = None) -> dict:
    """总体 + 按日 + 按臂分组报告。"""
    docs = _load_transcripts(run_dir, day)
    rows = _load_run_rows(run_dir)
    if day is not None:
        rows = [r for r in rows if r.get("day") == day]
    days = sorted(
        {int(d.name[3:]) for d in (run_dir / "transcripts").iterdir() if d.is_dir() and d.name.startswith("day")}
    )
    if day is not None:
        days = [d for d in days if d == day]

    def task_filter(doc: dict, arm: str | None = None) -> bool:
        return arm is None or doc.get("arm") == arm

    def row_filter(row: dict, arm: str | None = None) -> bool:
        return arm is None or row.get("arm") == arm

    total = _group_report(docs, rows)
    by_day = {
        str(d): _group_report(
            [doc for doc in docs if doc.get("day") == d],
            [row for row in rows if row.get("day") == d],
        )
        for d in days
    }
    arms = sorted({doc.get("arm") for doc in docs if doc.get("arm")})
    by_arm = {
        arm: _group_report(
            [doc for doc in docs if task_filter(doc, arm)],
            [row for row in rows if row_filter(row, arm)],
        )
        for arm in arms
    }
    return {
        "run_id": run_dir.name,
        "days": days,
        "total": total,
        "by_day": by_day,
        "by_arm": by_arm,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Trajectory 指标族离线分析（preview.html §8.2/§17.3）")
    ap.add_argument("run_dir", type=Path, help="results/<run_id> 目录（含 transcripts/ 与 run.jsonl）")
    ap.add_argument("--day", type=int, default=None, help="只分析指定日（1..7）")
    args = ap.parse_args(argv)
    report = analyze(args.run_dir, day=args.day)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
