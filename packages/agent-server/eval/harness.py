#!/usr/bin/env python3
"""E1 A/B harness: run a task subset through control/experiment arms and compare results.

Both arms run through agent-server (:8789) per the 2026-08-05 decision — the
only difference is the injection toggle (M8): experiment arm injects
retrieved experiences, control arm sends injection:false so its sessions and
traces still feed the learning loop. No arm physically bypasses the stack.

Uses the openai Python client directly (NOT litellm/mini-swe-agent) due to
a litellm connection bug in the eval venv. Implements a minimal Bash agent
with tool calling for file-operation tasks.

Usage:
    cd packages/agent-server
    eval/.venv/bin/python eval/harness.py --tasks eval/tasks/tasks-5.yaml --run-id smoke-01
"""

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = PROJECT_ROOT / "eval"
RESULTS_DIR = EVAL_DIR / "results"
VENV_DIR = EVAL_DIR / ".venv"

# ── config ──────────────────────────────────────────────────────────────────

DEFAULT_SEED = 42
DEFAULT_COST_LIMIT = 0.10  # USD per task
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_MAX_TURNS = 15
DEFAULT_TIMEOUT = 120  # seconds per task

# M8 (2026-08-09): both arms go through agent-server :8789; the only
# difference is the injection toggle. Direct DeepSeek / 8899 relay bypasses
# were retired (they mixed the backend variable into the A/B and starved the
# learning loop of control-arm traces).
EXPERIMENT_ENDPOINT = "http://127.0.0.1:8789/v1"
CONTROL_ENDPOINT = EXPERIMENT_ENDPOINT
GATEWAY_KEY = "lobster-local-key"

# Tool definitions (OpenAI function-calling format)
BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute a bash command in a sandboxed working directory. "
        "Use this to create, read, write, and modify files.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute (e.g., 'echo hello > file.txt', 'cat file.txt', 'ls -la')",
                }
            },
            "required": ["command"],
        },
    },
}


def load_tasks(tasks_path: Path) -> list[dict]:
    """Load tasks from YAML file."""
    import yaml
    with open(tasks_path) as f:
        data = yaml.safe_load(f)
    tasks = data.get("tasks", [])
    if not tasks:
        print(f"FATAL: no tasks found in {tasks_path}", file=sys.stderr)
        sys.exit(1)
    return tasks


def verify_task(workdir: Path, verifications: list[dict]) -> tuple[bool, list[str]]:
    """Run post-task verification checks. Returns (passed, failures)."""
    failures = []
    for v in verifications:
        vtype = v["type"]
        path = workdir / v["path"]
        if vtype == "file_exists":
            if not path.exists():
                failures.append(f"FILE_MISSING: {v['path']}")
        elif vtype == "file_contains":
            text = v["text"]
            if not path.exists():
                failures.append(f"FILE_MISSING: {v['path']}")
            elif text not in path.read_text():
                failures.append(f"TEXT_NOT_FOUND: '{text}' in {v['path']}")
        elif vtype == "file_not_contains":
            text = v["text"]
            if path.exists() and text in path.read_text():
                failures.append(f"UNEXPECTED_TEXT: '{text}' in {v['path']}")
        elif vtype == "command":
            cmd = v["command"]
            try:
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=workdir, timeout=30)
                if result.returncode != 0:
                    failures.append(f"COMMAND_FAILED({result.returncode}): {cmd}")
            except subprocess.TimeoutExpired:
                failures.append(f"COMMAND_TIMEOUT: {cmd}")
    return len(failures) == 0, failures


def run_bash_sandboxed(workdir: Path, command: str) -> str:
    """Execute a bash command in the sandbox workdir. Returns stdout+stderr."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            cwd=workdir,
            timeout=30,
        )
        output = result.stdout
        if result.stderr:
            output += "\n[stderr]\n" + result.stderr
        if result.returncode != 0:
            output += f"\n[exit code: {result.returncode}]"
        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return "Command timed out after 30s"


def run_agent_loop(
    task: dict,
    endpoint: str,
    api_key: str,
    workdir: Path,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    injection: bool | None = None,
) -> dict:
    """Run a minimal Bash agent with tool calling. Returns result dict.

    injection (M8): forwarded to agent-server as extra_body when the endpoint
    is :8789; control arm sends False, experiment sends True.
    """
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url=endpoint, timeout=60)

    system_prompt = (
        "You are a coding agent that solves tasks by executing bash commands. "
        "You work in a sandboxed directory. Use the `bash` tool to create, read, "
        "write, and modify files. Execute one command at a time. When the task is "
        "complete, respond with 'DONE' and do not call any more tools."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": task["prompt"]},
    ]

    total_input_tokens = 0
    total_output_tokens = 0
    total_cost = 0.0
    turns = 0

    for turn in range(max_turns):
        turns = turn + 1
        try:
            kwargs: dict = {
                "model": model,
                "messages": messages,
                "tools": [BASH_TOOL],
                "tool_choice": "auto",
                "temperature": 0.1,
            }
            if injection is not None and ":8789" in endpoint:
                kwargs["extra_body"] = {"injection": injection}
            response = client.chat.completions.create(**kwargs)
        except Exception as e:
            return {
                "exit_code": -1,
                "passed": False,
                "verification_failures": [f"API_ERROR: {e}"],
                "cost": {"input_tokens": total_input_tokens, "output_tokens": total_output_tokens, "cost_usd": total_cost},
                "turns": turns,
                "error": str(e),
            }

        usage = response.usage
        if usage:
            total_input_tokens += usage.prompt_tokens or 0
            total_output_tokens += usage.completion_tokens or 0

        choice = response.choices[0]
        msg = choice.message

        # Check if agent wants to call a tool
        if msg.tool_calls:
            # Append assistant message with tool calls
            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ],
            })

            # Execute each tool call
            for tc in msg.tool_calls:
                if tc.function.name != "bash":
                    tool_result = f"Unknown tool: {tc.function.name}"
                else:
                    try:
                        args = json.loads(tc.function.arguments)
                    except json.JSONDecodeError:
                        args = {}
                    command = args.get("command", "")
                    if not command:
                        tool_result = "Error: empty command"
                    else:
                        tool_result = run_bash_sandboxed(workdir, command)

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": tool_result[:2000],  # Truncate long outputs
                })
        else:
            # Agent responded with text only — check if done
            content = msg.content or ""
            messages.append({"role": "assistant", "content": content})
            if "DONE" in content.upper() or turn >= max_turns - 1:
                break

    return {
        "exit_code": 0,
        "passed": False,  # Will be checked by verify_task
        "verification_failures": [],
        "cost": {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "total_tokens": total_input_tokens + total_output_tokens,
            "cost_usd": total_cost,
        },
        "turns": turns,
    }


def run_task(
    task: dict,
    arm: str,
    endpoint: str,
    api_key: str,
    run_dir: Path,
    task_index: int,
    injection: bool | None = None,
) -> dict:
    """Run a single task. Returns result dict."""
    task_id = task["id"]
    verifications = task.get("verify", [])

    # Unique working directory per task
    workdir = run_dir / f"{task_index:03d}-{task_id}"
    workdir.mkdir(parents=True, exist_ok=True)

    start_time = time.time()
    agent_result = run_agent_loop(task, endpoint, api_key, workdir, DEFAULT_MODEL, injection=injection)
    elapsed = time.time() - start_time

    # Run verification
    passed, failures = verify_task(workdir, verifications)

    # Save trajectory
    traj_path = run_dir / f"{task_index:03d}-{task_id}.json"
    traj_path.write_text(json.dumps({
        "arm": arm,
        "task_id": task_id,
        "agent_result": agent_result,
        "verification_passed": passed,
        "verification_failures": failures,
        "elapsed_s": round(elapsed, 1),
    }, indent=2))

    return {
        "arm": arm,
        "task_id": task_id,
        "task_index": task_index,
        "exit_code": agent_result["exit_code"],
        "elapsed_s": round(elapsed, 1),
        "passed": passed,
        "verification_failures": failures,
        "cost": agent_result["cost"],
        "turns": agent_result["turns"],
    }


def archive_sessions(run_dir: Path) -> int:
    """Archive experiment arm sessions to prevent leakage across rounds."""
    sessions_dir = PROJECT_ROOT / "var" / "eval" / "sessions"
    if not sessions_dir.exists() or not any(sessions_dir.iterdir()):
        return 0

    archive_dir = run_dir / "sessions-archive"
    archive_dir.mkdir(parents=True, exist_ok=True)

    count = 0
    for f in sessions_dir.iterdir():
        if f.is_file():
            shutil.copy2(f, archive_dir / f.name)
            count += 1

    # Clear sessions for next round (anti-leakage)
    for f in sessions_dir.iterdir():
        if f.is_file():
            f.unlink()

    return count


def format_cost(cost: dict) -> str:
    return f"{cost.get('input_tokens',0):,} in / {cost.get('output_tokens',0):,} out tokens"


def main():
    parser = argparse.ArgumentParser(description="E1 A/B harness")
    parser.add_argument("--tasks", required=True, help="Path to tasks YAML")
    parser.add_argument("--run-id", required=True, help="Run identifier (e.g. smoke-01)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Random seed")
    parser.add_argument("--dry-run", action="store_true", help="Print planned runs without executing")
    args = parser.parse_args()

    # Dependency gate: the experiment arm needs the full local stack up.
    from preflight import ensure_for_base_url

    ensure_for_base_url(EXPERIMENT_ENDPOINT)

    tasks_path = Path(args.tasks)
    if not tasks_path.is_absolute():
        tasks_path = Path.cwd() / tasks_path

    tasks = load_tasks(tasks_path)

    # Shuffle with fixed seed
    rng = random.Random(args.seed)
    shuffled = list(tasks)
    rng.shuffle(shuffled)

    run_dir = RESULTS_DIR / args.run_id
    metadata = {
        "run_id": args.run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "seed": args.seed,
        "model": DEFAULT_MODEL,
        "max_turns": DEFAULT_MAX_TURNS,
        "task_count": len(shuffled),
        "task_ids": [t["id"] for t in shuffled],
        "task_order": [t["id"] for t in shuffled],
    }

    print(f"=== E1 A/B Harness: {args.run_id} ===")
    print(f"Tasks: {len(shuffled)} (seed={args.seed})")
    print(f"Model: {DEFAULT_MODEL}, max turns: {DEFAULT_MAX_TURNS}")
    print()

    if args.dry_run:
        print("DRY RUN — would execute:")
        for i, task in enumerate(shuffled):
            print(f"  [{i+1}/{len(shuffled)}] {task['id']}: {task['description']}")
        print(f"\nControl arm:  {len(shuffled)} tasks via {CONTROL_ENDPOINT} (injection off)")
        print(f"Experiment arm: {len(shuffled)} tasks via {EXPERIMENT_ENDPOINT} (injection on)")
        return

    # Create run directories
    if run_dir.exists():
        print(f"FATAL: run directory already exists: {run_dir}", file=sys.stderr)
        print("  Choose a different --run-id or remove the directory first.", file=sys.stderr)
        sys.exit(1)
    control_dir = run_dir / "control"
    experiment_dir = run_dir / "experiment"
    control_dir.mkdir(parents=True)
    experiment_dir.mkdir(parents=True)

    # ── Control arm ──────────────────────────────────────────────────────────
    print("── Control arm (via agent-server :8789, injection off) ──")
    control_results = []
    for i, task in enumerate(shuffled):
        print(f"[C {i+1}/{len(shuffled)}] {task['id']}...", end=" ", flush=True)
        result = run_task(task, "control", CONTROL_ENDPOINT, GATEWAY_KEY, control_dir, i + 1, injection=False)
        control_results.append(result)
        status = "PASS" if result["passed"] else f"FAIL ({'; '.join(result['verification_failures'])})"
        print(f"{status} | {format_cost(result['cost'])} | {result['elapsed_s']}s | {result['turns']} turns")

    # ── Experiment arm ──────────────────────────────────────────────────────
    print("\n── Experiment arm (via agent-server :8789, injection on) ──")
    experiment_results = []
    for i, task in enumerate(shuffled):
        print(f"[E {i+1}/{len(shuffled)}] {task['id']}...", end=" ", flush=True)
        result = run_task(task, "experiment", EXPERIMENT_ENDPOINT, GATEWAY_KEY, experiment_dir, i + 1, injection=True)
        experiment_results.append(result)
        status = "PASS" if result["passed"] else f"FAIL ({'; '.join(result['verification_failures'])})"
        print(f"{status} | {format_cost(result['cost'])} | {result['elapsed_s']}s | {result['turns']} turns")

    # ── Archive experiment sessions (anti-leakage) ───────────────────────────
    archived = archive_sessions(experiment_dir)
    if archived > 0:
        print(f"\nArchived {archived} experiment sessions → {experiment_dir / 'sessions-archive'}")

    # ── Summary ──────────────────────────────────────────────────────────────
    c_passed = sum(1 for r in control_results if r["passed"])
    e_passed = sum(1 for r in experiment_results if r["passed"])
    c_in = sum(r["cost"].get("input_tokens", 0) for r in control_results)
    c_out = sum(r["cost"].get("output_tokens", 0) for r in control_results)
    e_in = sum(r["cost"].get("input_tokens", 0) for r in experiment_results)
    e_out = sum(r["cost"].get("output_tokens", 0) for r in experiment_results)

    summary = {
        "metadata": metadata,
        "control": {
            "passed": c_passed,
            "total": len(control_results),
            "pass_rate": f"{c_passed}/{len(control_results)}",
            "input_tokens": c_in,
            "output_tokens": c_out,
            "total_tokens": c_in + c_out,
            "per_task": control_results,
        },
        "experiment": {
            "passed": e_passed,
            "total": len(experiment_results),
            "pass_rate": f"{e_passed}/{len(experiment_results)}",
            "input_tokens": e_in,
            "output_tokens": e_out,
            "total_tokens": e_in + e_out,
            "per_task": experiment_results,
        },
        "delta": {
            "pass_delta": f"{e_passed - c_passed:+d}",
            "token_delta": f"{(e_in + e_out) - (c_in + c_out):+,d}",
        },
    }

    summary_path = run_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))

    print(f"\n=== Summary ===")
    print(f"Control:    {c_passed}/{len(tasks)} passed | {c_in + c_out:,} tokens ({c_in:,} in / {c_out:,} out)")
    print(f"Experiment: {e_passed}/{len(tasks)} passed | {e_in + e_out:,} tokens ({e_in:,} in / {e_out:,} out)")
    print(f"Delta:      {e_passed - c_passed:+d} pass | {(e_in + e_out) - (c_in + c_out):+,d} tokens")
    print(f"\nFull results: {summary_path}")


if __name__ == "__main__":
    main()
