#!/usr/bin/env python3
"""ALFWorld ReAct agent with dual-arm endpoint switching (E2').

Faithful port of the ReAct paper's alfworld.ipynb loop to the chat.completions
API. Two-shot prompt per task type (react_{type}_1 + react_{type}_0), 49-step
cap, stop=["\n"], temperature=0. One JSONL record per game.

Usage:
    ALFWORLD_DATA=$PWD/alfworld_data ./.venv/bin/python alfworld_agent.py \
        --base-url http://127.0.0.1:8789/v1 --api-key lobster-local-key \
        --output results/alfworld-control.jsonl [--games 5] [--start 0]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import yaml
from openai import OpenAI

from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
CONFIG_PATH = EVAL_DIR / "alfworld" / "base_config.yaml"
PROMPTS_PATH = EVAL_DIR / "alfworld" / "alfworld_3prompts.json"

PREFIXES = {
    "pick_and_place": "put",
    "pick_clean_then_place": "clean",
    "pick_heat_then_place": "heat",
    "pick_cool_then_place": "cool",
    "look_at_obj": "examine",
    "pick_two_obj": "puttwo",
}

MAX_STEPS = 49

# Command extraction (M16, 2026-08-04 + 2026-08-09 fixes): reasoning-distilled
# models (e.g. Qwen3.5-27B-Distilled) narrate before acting ("Let me
# think...") instead of emitting the ReAct command on the first line.
# Generate without stop=["\n"] and extract the command from a line-anchored,
# word-bounded verb phrase. Anchoring kills false positives like "use " in
# "because" and "take " in "mistake"; the last NON-think match wins (think:
# is only used when nothing else matched — the loop treats it specially).
COMMAND_VERB_RE = re.compile(
    r"^\s*(go to|take|put|open|close|clean|heat|cool|use|examine|inventory|look|think)(?::|\b)"
)


def extract_command(text: str) -> tuple[str, bool]:
    """Extract the ReAct command from a (possibly narrated) model reply.

    Returns (command, verb_matched). verb_matched=False means no verb-phrase
    line was found and the raw last line was used — an extraction failure
    that is recorded per step so failure rates can be compared across arms
    (injection changes narration style and must not bias the score).
    """
    candidates: list[tuple[str, str]] = []
    for line in text.split("\n"):
        stripped = line.strip().lstrip(">").strip()
        m = COMMAND_VERB_RE.match(stripped)
        if m:
            phrase = stripped[m.start() :].strip().strip("`").rstrip(".").strip()
            if phrase:
                candidates.append((m.group(1), phrase))
    non_think = [(verb, phrase) for verb, phrase in candidates if not verb.startswith("think")]
    if non_think:
        return non_think[-1][1], True
    if candidates:
        return candidates[-1][1], True
    return text.strip().split("\n")[-1].strip().lstrip(">").strip(), False


def existing_game_idxs(path: Path) -> set[int]:
    """Already-recorded game_idx in an append-mode output (M15 dedup:
    a crash rerun must not double-count games)."""
    if not path.exists():
        return set()
    seen: set[int] = set()
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            seen.add(json.loads(line)["game_idx"])
        except (json.JSONDecodeError, KeyError):
            continue  # tolerate a malformed trailing line
    return seen


def pool_signature(pool: list[str]) -> tuple[int, str]:
    """(size, short sha256) of the sorted game pool, recorded per game so
    A/B arms can be verified to have played the same pool (C3)."""
    digest = hashlib.sha256("\n".join(pool).encode("utf-8")).hexdigest()[:16]
    return len(pool), digest


def parse_x_gateway(resp: object) -> dict:
    """Escalation marker from the gateway response (issue-004, M1).

    openai SDK 的 ChatCompletion 对象没有 .headers——标记必须从响应 body 的
    x_gateway 字段读取（gateway extra 字段经 openai SDK extra="allow" 穿透，
    agent-server 非流式分支透传同一字段）。历史上读 resp.headers 的版本
    运行时恒返回 {}（mock 带 headers 所以测试绿），观测仪器静默失明。
    """
    try:
        raw = getattr(resp, "x_gateway", None)
        if raw is None:
            return {}
        return raw if isinstance(raw, dict) else json.loads(raw)
    except (AttributeError, json.JSONDecodeError):
        return {}


def process_ob(ob: str) -> str:
    if ob.startswith("You arrive at loc "):
        ob = ob[ob.find(". ") + 2 :]
    return ob


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--output", required=True)
    ap.add_argument("--games", type=int, default=0, help="games to run; 0 = the whole pool (no wraparound replay)")
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument(
        "--max-tokens",
        type=int,
        required=True,  # issue-007: 必传——200 是 issue-003 的缺陷原值，默认值会静默复发门控误升级
        help="per-turn output cap（必传）。issue-003: 200 曾致 length 门控 84-87% 误升级；"
        "pilot 校准（800/1024）后按校准值传参。",
    )
    ap.add_argument(
        "--expect-pool-size",
        type=int,
        default=0,
        help="hard-fail if the game pool size differs (C3: pool drift breaks A/B alignment); 0 = skip check",
    )
    ap.add_argument(
        "--injection",
        choices=["on", "off"],
        default=None,
        help="experience injection override; only honored by agent-server (:8789). "
        "Default: server-side setting (env AGENT_SERVER_INJECTION, on). "
        "Control arms should run via :8789 with --injection off so their "
        "traces still feed the learning loop.",
    )
    return ap


def main() -> None:
    args = build_parser().parse_args()

    # Dependency gate: probe (and auto-start what we own) before burning hours.
    ensure_for_base_url(args.base_url)
    if args.injection and ":8789" not in args.base_url:
        print("warning: --injection is ignored by non-agent-server endpoints", file=sys.stderr)

    client = OpenAI(base_url=args.base_url, api_key=args.api_key, timeout=120.0)

    def llm(prompt: str) -> dict:
        for attempt in range(6):
            try:
                resp = client.chat.completions.create(
                    model=args.model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are playing a text-based household task game. "
                                "Respond with exactly one short command per turn, e.g. "
                                "'go to cabinet 1', 'take mug 1 from countertop 1', "
                                "'open drawer 1', or 'think: <reasoning>'. "
                                "You may think briefly, but your final line MUST be "
                                "the command itself."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0,
                    max_tokens=args.max_tokens,
                    extra_body={
                        "thinking": {"type": "disabled"},
                        "domain": "alfworld",
                        **({"injection": args.injection == "on"} if args.injection else {}),
                    },
                )
                usage = resp.usage.model_dump() if resp.usage else {}
                raw = resp.choices[0].message.content.strip()
                marker = parse_x_gateway(resp)
                action, extract_ok = extract_command(raw)
                return {
                    "action": action,
                    "usage": usage,
                    "trace_id": getattr(resp, "id", ""),
                    "finish_reason": resp.choices[0].finish_reason,
                    "provider": marker.get("provider", ""),
                    "escalated": bool(marker.get("escalated", False)),
                    "extract_ok": extract_ok,
                }
            except Exception as e:  # noqa: BLE001 - retry any transient API error
                wait = min(2**attempt * 4, 60)
                print(f"  llm error ({type(e).__name__}: {e}); retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
        raise RuntimeError("llm failed after 6 attempts")

    with open(CONFIG_PATH) as f:
        config = yaml.safe_load(f)
    prompts = json.load(open(PROMPTS_PATH))

    import alfworld.agents.environment as environment

    env = environment.get_environment(config["env"]["type"])(config, train_eval="eval_out_of_distribution")
    # Deterministic order for A/B alignment; pool bounds verified BEFORE any
    # game is played (C3: shuffled_cycle rewinds when the pool is exhausted,
    # which silently replays games and misaligns A/B pairs).
    pool = sorted(env.game_files)
    pool_size, pool_hash = pool_signature(pool)
    print(f"game files: {pool_size} (pool hash {pool_hash})")
    if args.expect_pool_size and pool_size != args.expect_pool_size:
        sys.exit(
            f"FATAL: game pool has {pool_size} files, expected {args.expect_pool_size} "
            f"(pool hash {pool_hash}) — pool drift breaks A/B alignment (issue-003 C3)"
        )
    games = pool_size if args.games <= 0 else args.games
    if args.start >= pool_size:
        sys.exit(f"FATAL: --start {args.start} is beyond pool size {pool_size}")
    if games > pool_size:
        sys.exit(f"FATAL: --games {games} exceeds pool size {pool_size}; wraparound replay is never allowed (issue-003 C3)")
    env = env.init_env(batch_size=1)
    env.skip(args.start)  # advance the game iterator so --start N matches game_idx (M14)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out = open(out_path, "a")
    done = existing_game_idxs(out_path)
    if done:
        print(f"resume: {len(done)} games already recorded, skipping (M15 dedup)")
    end = min(args.start + games, pool_size)

    for game_idx in range(args.start, end):
        ob, info = env.reset()
        ob = "\n".join(ob[0].split("\n\n")[1:])
        gamefile = info["extra.gamefile"][0]
        name = "/".join(gamefile.split("/")[-3:-1])

        task_type = None
        for k, v in PREFIXES.items():
            if name.startswith(k):
                task_type, pfx = k, v
                break
        if task_type is None:
            print(f"skip (unknown type): {name}", file=sys.stderr)
            continue
        if game_idx in done:
            print(f"[{game_idx}] already recorded, skip")
            continue

        prompt_head = (
            "Interact with a household to solve a task. Here are two examples.\n"
            + prompts[f"react_{pfx}_1"]
            + prompts[f"react_{pfx}_0"]
            + "\nHere is the task.\n"
        )

        init_prompt = prompt_head + ob + "\n>"
        history = ""
        won = False
        tokens_in = tokens_out = 0
        escalations = 0
        extract_failed = 0
        trace_ids: list[str] = []
        traj = []
        t0 = time.time()

        for step in range(1, MAX_STEPS + 1):
            turn = llm(init_prompt + history)
            action = turn["action"]
            tokens_in += turn["usage"].get("prompt_tokens", 0)
            tokens_out += turn["usage"].get("completion_tokens", 0)
            escalations += 1 if turn["escalated"] else 0
            extract_failed += 0 if turn["extract_ok"] else 1
            if turn["trace_id"]:
                trace_ids.append(turn["trace_id"])
            observation, _, done, step_info = env.step([action])
            observation, won, done = process_ob(observation[0]), bool(step_info["won"][0]), bool(done[0])
            if action.startswith("think:"):
                observation = "OK."
            traj.append(
                {
                    "step": step,
                    "action": action,
                    "obs": observation,
                    "finish_reason": turn["finish_reason"],
                    "provider": turn["provider"],
                    "escalated": turn["escalated"],
                }
            )
            history += f" {action}\n{observation}\n>"
            if done:
                break

        rec = {
            "game_idx": game_idx,
            "gamefile": gamefile,
            "task_type": task_type,
            "won": won,
            "steps": len(traj),
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "elapsed_s": round(time.time() - t0, 1),
            "trajectory": traj,
            # issue-003 fixes (2026-08-09):
            "init_prompt": init_prompt,  # M18: task context for the evolution pipeline
            "pool_size": pool_size,  # C3: pool provenance per record
            "pool_hash": pool_hash,  # C3
            "escalations": escalations,  # M3: gateway x-gateway marker
            "extract_failed_steps": extract_failed,  # M16: extraction artifact rate
            "trace_ids": trace_ids,  # issue-004: gateway trace ids（model_runs 回填兜底）
        }
        out.write(json.dumps(rec) + "\n")
        out.flush()
        print(f"[{game_idx + 1}/{pool_size}] {task_type} won={won} steps={len(traj)} in={tokens_in} out={tokens_out}")

    out.close()


if __name__ == "__main__":
    main()
