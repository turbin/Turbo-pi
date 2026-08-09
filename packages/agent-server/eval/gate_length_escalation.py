#!/usr/bin/env python3
"""issue-003 回归测试 2：跑批前门控——model_runs 全量口径 length 升级率门槛。

B 阶段教训：finish_reason_length 升级率 84-87% 时纯本地模型从未被测，结论
作废。本脚本在 pilot 校准后成为全量跑批的硬门槛（永久保留）：model_runs
全量口径下，因 finish_reason=length 而升级的请求占比必须 < 5%，否则禁止
开跑。制度化"拒绝小样本外推"：验收只看全量 ground truth（gateway 数据库）。

用法：
    ./.venv/bin/python gate_length_escalation.py [--db <gateway.db>] [--max-rate 0.05]

退出码：0 = 通过（可开跑）；1 = 未达标（禁止开跑，打印明细）。
"""

import argparse
import json
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent.parent / "agent-gateway" / "var" / "agent_gateway.db"
DEFAULT_MAX_RATE = 0.05


def length_escalation_stats(db_path: Path, since: str | None = None) -> dict:
    """窗口口径 length 升级统计：按 trace 去重。

    分子 = purpose='escalation' 且 escalation_reason='finish_reason_length' 的
    成功升级请求数；分母 = 有 primary run 的请求总数。`since`（已规范化为
    SQLite 存储格式的 UTC 时间戳）时按 request_executions.created_at 过滤——
    共享 DB 的历史脏数据不得钉死 pilot 窗口（issue-005）。
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_runs'"
        ).fetchall()
        if not table:
            raise ValueError(f"gateway database {db_path} has no model_runs table")
        since_clause = ""
        join_clause = ""
        params: list[str] = []
        if since:
            has_exec = con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='request_executions'"
            ).fetchall()
            if not has_exec:
                raise ValueError(
                    f"--since requires the request_executions table; {db_path} does not have one"
                )
            join_clause = " JOIN request_executions r ON r.trace_id = m.trace_id"
            since_clause = " AND r.created_at >= ?"
            params = [since]
        total = con.execute(
            "SELECT COUNT(DISTINCT m.trace_id) FROM model_runs m" + join_clause + " "
            f"WHERE m.purpose='primary' AND m.state='succeeded'{since_clause}",
            params,
        ).fetchone()[0]
        rows = con.execute(
            "SELECT m.trace_id, m.quality_signals_json FROM model_runs m" + join_clause + " "
            f"WHERE m.purpose='escalation' AND m.state='succeeded'{since_clause}",
            params,
        ).fetchall()
    finally:
        con.close()

    length_traces: set[str] = set()
    for trace_id, signals_json in rows:
        if not signals_json:
            continue
        try:
            signals = json.loads(signals_json)
        except json.JSONDecodeError:
            continue
        if signals.get("escalation_reason") == "finish_reason_length":
            length_traces.add(trace_id)
    return {"total_requests": total, "length_escalated": len(length_traces)}


def normalize_since(value: str) -> str:
    """ISO 8601 时间戳 → SQLite 存储格式（DateTime 列存 'YYYY-MM-DD HH:MM:SS.ffffff'）。"""
    return value.strip().replace("T", " ")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="length 升级率跑批门控（issue-003）")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="gateway SQLite 路径")
    ap.add_argument("--max-rate", type=float, default=DEFAULT_MAX_RATE, help="length 升级率上限（默认 0.05）")
    ap.add_argument(
        "--since",
        default="",
        help="只统计该 UTC 时间点之后的请求（ISO 8601）——pilot/全量窗口过滤，"
        "共享 DB 的历史脏数据不得钉死门控（issue-005）",
    )
    ap.add_argument(
        "--last-hours",
        type=float,
        default=0.0,
        help="只统计最近 N 小时内的请求（与 --since 二选一）",
    )
    ap.add_argument("--json", action="store_true", help="仅输出 JSON 统计（供上层脚本消费）")
    args = ap.parse_args(argv)

    since: str | None = None
    if args.last_hours > 0:
        since = (datetime.now(UTC) - timedelta(hours=args.last_hours)).strftime("%Y-%m-%d %H:%M:%S")
    elif args.since:
        since = normalize_since(args.since)

    db = Path(args.db)
    if not db.exists():
        print(f"gate: FATAL gateway database not found: {db}", file=sys.stderr)
        return 2
    try:
        stats = length_escalation_stats(db, since=since)
    except ValueError as exc:
        print(f"gate: FATAL {exc}", file=sys.stderr)
        return 2
    rate = stats["length_escalated"] / stats["total_requests"] if stats["total_requests"] else 0.0

    if args.json:
        print(json.dumps({**stats, "since": since, "length_escalation_rate": rate, "pass": rate < args.max_rate}))
        return 0 if rate < args.max_rate else 1

    window = f" since={since}" if since else " (all history)"
    print(f"gate:{window} requests={stats['total_requests']} length_escalated={stats['length_escalated']} "
          f"length_rate={rate:.3f} (max {args.max_rate})")
    if stats["total_requests"] == 0:
        print("gate: FAIL — no primary model_runs in window; refusing to run blind (issue-003)", file=sys.stderr)
        return 1
    if rate >= args.max_rate:
        print(
            f"gate: FAIL — length escalation rate {rate:.3f} >= {args.max_rate}; "
            "local model is being silently truncated/escalated (issue-003). Do not start a full run.",
            file=sys.stderr,
        )
        return 1
    print("gate: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
