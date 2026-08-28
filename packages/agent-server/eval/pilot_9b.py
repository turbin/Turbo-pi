#!/usr/bin/env python3
"""9B pilot 校准批次（post-c 统一方案 §108「9B 起跑前置」落地）。

目的（非测量实验，是全量跑批前的校准）：
  1. omlx 9B 可用性确认（链路：campaign client → agent-server 8789 → gateway → omlx 9B）
  2. 测速（每任务时长/请求数，供工期重估——9B 分布未验证，27B 外推失效）
  3. finish_reason 分布重测（9B 叙述风格与 27B 不同；length 升级率 <5% 门控不变，
     数据取自 gateway model_runs.quality_signals，C2 口径）
  4. Langfuse 实时监视验证（UI: http://localhost:3000，project exp-9b-campaign）

用法：
    ./.venv/bin/python pilot_9b.py [--tasks 3] [--run-id pilot-9b-YYYYMMDD]
"""

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

# macOS 系统代理不 bypass 回环（见 langfuse 决策记录 §4）；9B 模型指纹（M11）。
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("AGENT_EVAL_EXPECTED_OMLX_MODEL", "Qwen3.5-9B-4bit")

from openai import OpenAI  # noqa: E402

from campaign import AGENT_SERVER, run_agent, safe_grade, setup_workspace, task_prompt  # noqa: E402
from campaign_plan import load_tasks, split_tasks  # noqa: E402
import confirm_tasks  # noqa: E402
from preflight import ensure_for_base_url  # noqa: E402

GATEWAY_DB = (EVAL_DIR / "../../agent-gateway/var/agent_gateway.db").resolve()
LENGTH_GATE = 0.05  # 门控预注册口径：length 升级率 <5%（issue-003 回归资产沿用）


def model_runs_for(trace_ids: list[str]) -> list[dict]:
    """按 trace_id 从 gateway model_runs 取 finish_reason/升级腿（只读，C2 口径）。"""
    if not trace_ids:
        return []
    marks = ",".join("?" * len(trace_ids))
    db = sqlite3.connect(f"file:{GATEWAY_DB}?mode=ro", uri=True)
    try:
        rows = db.execute(
            f"SELECT trace_id, purpose, provider, state, quality_signals_json, "
            f"input_tokens, output_tokens FROM model_runs WHERE trace_id IN ({marks}) "
            f"ORDER BY trace_id, sequence",
            trace_ids,
        ).fetchall()
    finally:
        db.close()
    out = []
    for tid, purpose, provider, state, signals, in_tok, out_tok in rows:
        out.append(
            {
                "trace_id": tid,
                "purpose": purpose,
                "provider": provider,
                "state": state,
                "finish_reason": (json.loads(signals) or {}).get("finish_reason") if signals else None,
                "input_tokens": in_tok,
                "output_tokens": out_tok,
            }
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", type=int, default=3, help="重复集前 N 个任务（默认 3）")
    ap.add_argument("--run-id", default=f"pilot-9b-{time.strftime('%Y%m%d')}")
    args = ap.parse_args()

    ensure_for_base_url(AGENT_SERVER)
    tasks = load_tasks()
    repeat, _new = split_tasks(tasks)
    picks = repeat[: args.tasks]
    confirm_tasks.assert_no_confirm_tasks(picks, context="pilot_9b")
    print(f"pilot 9B: {len(picks)} tasks via {AGENT_SERVER} (injection on, experiment arm path)")

    client = OpenAI(base_url=AGENT_SERVER, api_key="lobster-local-key", timeout=1800.0)
    out_dir = EVAL_DIR / "results" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "pilot.json"

    rows: list[dict] = []
    for i, task_id in enumerate(picks):
        meta = next(t for t in tasks if t.id == task_id)
        ws = setup_workspace(task_id, out_dir / "ws")
        t0 = time.time()
        execution = run_agent(
            client, "agent-auto", task_prompt(task_id), ws, meta.timeout_seconds,
            injection=True, task_id=task_id, domain="office",
            arm="experiment", condition="pilot-injection-on",
        )
        duration = time.time() - t0
        g = safe_grade(task_id, execution, ws)
        runs = model_runs_for(execution["trace_ids"])
        row = {
            "task_id": task_id,
            "score": g["score"],
            "grading_error": g.get("grading_error", False),
            "requests": execution["requests"],
            "escalated": execution["escalated"],
            "duration_s": round(duration, 1),
            "model_runs": runs,
        }
        rows.append(row)
        out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
        print(
            f"[{i + 1}/{len(picks)}] {task_id} score={g['score']:.2f} "
            f"req={execution['requests']} dur={duration:.0f}s esc={execution['escalated']}"
        )

    all_runs = [r for row in rows for r in row["model_runs"]]
    primary = [r for r in all_runs if r["purpose"] == "primary"]
    escalations = [r for r in all_runs if r["purpose"] == "escalation"]
    dist = Counter(r["finish_reason"] for r in primary)
    n = len(primary)
    length_rate = dist.get("length", 0) / n if n else 0.0
    durations = [row["duration_s"] for row in rows]
    summary = {
        "tasks": len(rows),
        "total_requests": n,
        "finish_reason_dist": dict(dist),
        "length_rate": round(length_rate, 4),
        "length_gate_pass": length_rate < LENGTH_GATE,
        "escalation_runs": len(escalations),
        "scores": [row["score"] for row in rows],
        "duration_s": durations,
        "avg_duration_s": round(sum(durations) / len(durations), 1) if durations else 0,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"输出: {out_path} / {out_dir / 'summary.json'}")
    if not summary["length_gate_pass"]:
        sys.exit("pilot FAIL: length 升级率超门控 5% —— 校准 max_tokens 后再开全量")


if __name__ == "__main__":
    main()
