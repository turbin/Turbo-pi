#!/usr/bin/env python3
"""C 阶段办公自动化 campaign runner（每日批次：重复集 + 新任务切片）。

每日流程（D1..D7）：
  1. 实验臂：重复集 20 + 当日新任务切片，经 8789（injection on）
  2. 对照臂（仅 D1/D7）：重复集，经 8789 + injection off（同路径对照，trace 全落库）
  3. 当日结束后：合成任务级轨迹 → runDailyEvolution → 次日用热库

判据预注册见 doc/design/2026-08-05-agent-server-c-campaign-design.md。

用法：
    ./.venv/bin/python campaign.py --day 1 --dry-run          # 打印当日批次
    ./.venv/bin/python campaign.py --day 1                    # 正式跑（自动 preflight）
    ./.venv/bin/python campaign.py --metrics results/campaign-x/run.jsonl  # 判据核算
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from openai import OpenAI

from campaign_metrics import check_criteria, daily_summary
from campaign_plan import daily_batch, load_tasks
from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
QCB_DIR = EVAL_DIR / "qcb" / "tasks-v1.1"
HARNESS_REF = EVAL_DIR / "qcb" / "harness-ref"
sys.path.insert(0, str(HARNESS_REF))  # vendored QCB lib_tasks/lib_grading

AGENT_SERVER = "http://127.0.0.1:8789/v1"
MAX_TURNS = 30
PASS_THRESHOLD = 0.5

BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute a bash command in the task workspace.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The bash command to execute"}},
            "required": ["command"],
        },
    },
}


def setup_workspace(task_id: str, workdir: Path) -> Path:
    """Copy the task's asset tree into an isolated workspace."""
    src = QCB_DIR / "assets" / task_id
    ws = workdir / task_id
    ws.mkdir(parents=True, exist_ok=True)
    if src.exists():
        shutil.copytree(src, ws, dirs_exist_ok=True)
    return ws


def run_agent(client: OpenAI, model: str, prompt: str, ws: Path, timeout_s: int) -> dict:
    """Minimal bash-tool agent loop (E1 harness 同源形态)。"""
    transcript: list[dict] = []
    messages = [
        {
            "role": "system",
            "content": (
                f"You are an office-automation agent. Your workspace is {ws}. "
                "Complete the task using the bash tool. Work entirely inside the workspace."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    t0 = time.time()
    requests = 0
    for _ in range(MAX_TURNS):
        if time.time() - t0 > timeout_s:
            transcript.append({"role": "agent", "content": "[timeout]"})
            break
        requests += 1
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[BASH_TOOL],
            extra_body={"injection": injection},
        )
        msg = resp.choices[0].message
        transcript.append({"role": "assistant", "content": msg.content or "", "tool_calls": bool(msg.tool_calls)})
        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content or ""})
            break
        messages.append(msg.model_dump())
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            proc = subprocess.run(
                ["bash", "-c", args.get("command", "")],
                cwd=ws,
                capture_output=True,
                text=True,
                timeout=120,
            )
            output = (proc.stdout + proc.stderr)[:8000]
            transcript.append({"role": "tool", "content": output[:500]})
            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
    return {"status": "completed", "transcript": transcript, "workspace": str(ws), "requests": requests}


def grade(task_id: str, execution: dict, ws: Path) -> dict:
    """Vendored QCB grading（automated + judge hybrid）。judge 走 .env 的 DeepSeek。"""
    from lib_grading import grade_task  # noqa: PLC0415 - vendored import
    from lib_tasks import TaskLoader  # noqa: PLC0415

    task = TaskLoader(QCB_DIR / "tasks").load_task(QCB_DIR / "tasks" / f"{task_id}.md")
    result = grade_task(task=task, execution_result=execution, skill_dir=ws)
    return result.to_dict()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", type=int)
    ap.add_argument("--run-id", default=f"campaign-{time.strftime('%Y%m%d')}")
    ap.add_argument("--model", default="agent-auto")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--metrics", default="", help="核算既有结果 JSONL 的判据，不跑批")
    args = ap.parse_args()

    if args.metrics:
        from campaign_metrics import load_results

        rows = load_results(Path(args.metrics))
        print(json.dumps({"daily": daily_summary(rows), "criteria": check_criteria(rows)}, indent=2, ensure_ascii=False))
        return

    if not args.day:
        ap.error("--day required unless --metrics")

    tasks = load_tasks()
    batch = daily_batch(tasks, args.day)
    arms = {"experiment": batch["repeat"] + batch["new"]}
    if args.day in (1, 7):
        arms["control"] = batch["repeat"]

    print(f"day {args.day}: repeat={len(batch['repeat'])} new={len(batch['new'])}")
    if args.dry_run:
        for arm, ids in arms.items():
            print(f"  [{arm}] {len(ids)} tasks")
            for tid in ids:
                print(f"    {tid}")
        return

    ensure_for_base_url(AGENT_SERVER)
    out_dir = EVAL_DIR / "results" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "run.jsonl"
    client = OpenAI(base_url=AGENT_SERVER, api_key="lobster-local-key", timeout=300.0)

    with open(out_path, "a") as out:
        for arm, ids in arms.items():
            for i, task_id in enumerate(ids):
                kind = "repeat" if task_id in set(batch["repeat"]) else "new"
                meta = next(t for t in tasks if t.id == task_id)
                ws = setup_workspace(task_id, out_dir / f"day{args.day}" / arm)
                # 同路径对照：control 臂注入关闭（body 级覆盖，trace 仍落库）。
                execution = run_agent(
                    client, args.model, task_prompt(task_id), ws, meta.timeout_seconds, injection=arm == "experiment"
                )
                g = grade(task_id, execution, ws)
                row = {
                    "day": args.day,
                    "task_id": task_id,
                    "kind": kind,
                    "arm": arm,
                    "score": g["score"],
                    "passed": g["score"] >= PASS_THRESHOLD,
                    "escalated": False,  # 由 gateway model_runs 事后标注（见设计文档 §4）
                    "requests": execution["requests"],
                    "grading": g,
                }
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                print(f"[{arm} {i + 1}/{len(ids)}] {task_id} score={g['score']:.2f}")


def task_prompt(task_id: str) -> str:
    """取任务 md 的 ## Prompt 节正文（到下一个 ## 之前）。"""
    body = (QCB_DIR / "tasks" / f"{task_id}.md").read_text()
    return body.split("## Prompt", 1)[1].split("\n## ", 1)[0].strip()


if __name__ == "__main__":
    main()
